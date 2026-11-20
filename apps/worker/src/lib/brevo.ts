/**
 * Transactional email through Brevo.
 *
 * The Worker owns exactly one kind of outbound mail today: the six-digit
 * password-recovery code. The sender identity (from name, from address and
 * optional Reply-To) is administrator-managed in platform_settings, while the
 * Brevo API key stays a Worker secret (`BREVO_API_KEY`) and is never stored in
 * the database or returned to any console.
 *
 * A missing key or sender is reported as "not configured" instead of being
 * swallowed: a customer asking for a code must be told the truth, and an
 * administrator must be able to see why nothing was sent.
 */
import type { CustomFetch } from "./db";
import type { DbClient } from "./db";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

export interface BrevoSenderSettings {
  fromName: string;
  fromEmail: string | null;
  replyTo: string | null;
}

export interface RecoveryEmailInput {
  to: string;
  code: string;
  /** Minutes until the code stops working. */
  expiresInMinutes: number;
  recipientName?: string | null;
}

export type SendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; reason: "not_configured" | "rejected" | "unreachable"; detail: string };

/** Reads the administrator-managed sender identity. */
export async function loadBrevoSender(db: DbClient): Promise<BrevoSenderSettings> {
  const { data } = await db
    .from("platform_settings")
    .select("brevo_from_name,brevo_from_email,brevo_reply_to")
    .eq("id", 1)
    .maybeSingle();

  const row = (data ?? null) as {
    brevo_from_name?: string | null;
    brevo_from_email?: string | null;
    brevo_reply_to?: string | null;
  } | null;

  return {
    fromName: (row?.brevo_from_name ?? "").trim() || "HomecoreOS",
    fromEmail: (row?.brevo_from_email ?? "").trim() || null,
    replyTo: (row?.brevo_reply_to ?? "").trim() || null,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildBody(input: RecoveryEmailInput, sender: BrevoSenderSettings) {
  const greeting = input.recipientName ? `Hello ${input.recipientName},` : "Hello,";
  const subject = "Your HomecoreOS password recovery code";

  const textContent = [
    greeting,
    "",
    `Your HomecoreOS password recovery code is ${input.code}.`,
    `It expires in ${input.expiresInMinutes} minutes and can be used once.`,
    "",
    "If you did not ask to reset your password, you can ignore this email:",
    "your current password stays unchanged.",
    "",
    `— ${sender.fromName}`,
  ].join("\n");

  const htmlContent = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#101828;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;">
      <tr><td>
        <p style="margin:0 0 4px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#667085;">HomecoreOS</p>
        <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">Password recovery code</h1>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;">Enter this code on the sign-in card to choose a new password.</p>
        <p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:0.32em;font-variant-numeric:tabular-nums;">${escapeHtml(input.code)}</p>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">The code expires in ${input.expiresInMinutes} minutes and works once.</p>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#667085;">If you did not ask to reset your password, ignore this email. Your current password stays unchanged.</p>
        <p style="margin:24px 0 0;font-size:13px;color:#667085;">— ${escapeHtml(sender.fromName)}</p>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, textContent, htmlContent };
}

/** Sends the recovery code. Never throws: the caller decides how to react. */
export async function sendPasswordRecoveryEmail(params: {
  apiKey: string | undefined;
  sender: BrevoSenderSettings;
  input: RecoveryEmailInput;
  mailFetch?: CustomFetch;
}): Promise<SendResult> {
  const apiKey = (params.apiKey ?? "").trim();
  const sender = params.sender;

  if (!apiKey || !sender.fromEmail) {
    return {
      ok: false,
      reason: "not_configured",
      detail: !apiKey
        ? "BREVO_API_KEY is not configured on the Worker."
        : "No Brevo sender address is set in the admin console.",
    };
  }

  const { subject, textContent, htmlContent } = buildBody(params.input, sender);
  const fetcher: CustomFetch = params.mailFetch ?? fetch;

  let res: Response;
  try {
    res = await fetcher(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: sender.fromName, email: sender.fromEmail },
        ...(sender.replyTo ? { replyTo: { email: sender.replyTo } } : {}),
        to: [{ email: params.input.to }],
        subject,
        htmlContent,
        textContent,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      detail: err instanceof Error ? err.message : "Brevo could not be reached.",
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      reason: "rejected",
      detail: `Brevo rejected the message (${res.status}). ${body.slice(0, 300)}`.trim(),
    };
  }

  const payload = (await res.json().catch(() => null)) as { messageId?: string } | null;
  return { ok: true, messageId: payload?.messageId ?? null };
}
