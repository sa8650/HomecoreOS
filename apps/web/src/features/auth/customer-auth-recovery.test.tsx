import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomerAuthPage } from "./CustomerAuthPage";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

type Call = { url: string; method: string; body: unknown };

function installFetchMock() {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/api/auth/password-reset/request")) return json({ ok: true });
    if (url.includes("/api/auth/password-reset/verify")) {
      return json({ resetToken: "token-abcdefghijklmnop", expiresAt: "2026-11-19T12:00:00Z" });
    }
    if (url.includes("/api/auth/password-reset/confirm")) return json({ ok: true });
    return json({});
  }) as typeof fetch;
  return calls;
}

it("opens the card with a personal title and no horizontal tab scroller", () => {
  installFetchMock();
  render(<CustomerAuthPage onAuthenticated={vi.fn()} />);

  expect(screen.getByRole("heading", { name: "Welcome Home" })).toBeInTheDocument();
  const tabs = document.querySelector('[data-slot="tabs-list"]');
  expect(tabs).not.toBeNull();
  expect(tabs!.className).toContain("overflow-visible");
  expect(tabs!.className).not.toContain("overflow-x-auto");
});

it("recovers a password with an emailed code, then a new password typed twice", async () => {
  const calls = installFetchMock();
  const onAuthenticated = vi.fn();
  const user = userEvent.setup();
  render(<CustomerAuthPage onAuthenticated={onAuthenticated} />);

  await user.click(screen.getByRole("button", { name: /Forgot password\?/i }));

  const recovery = await screen.findByTestId("password-recovery");
  await user.type(within(recovery).getByLabelText(/Email address/i), "owner@homecoreos.local");
  await user.click(within(recovery).getByRole("button", { name: /Send Recovery Code/i }));

  expect(await within(recovery).findByText(/six-digit code is on its way/i)).toBeInTheDocument();
  const codeField = within(recovery).getByLabelText(/Six-digit code/i);
  await user.type(codeField, "123456");
  await user.click(within(recovery).getByRole("button", { name: /Verify Code/i }));

  const passwordField = await within(recovery).findByLabelText(/^New password$/i);
  const confirmField = within(recovery).getByLabelText(/Re-enter new password/i);

  // The save button stays disabled until both entries agree.
  await user.type(passwordField, "Sup3rSecretPass");
  await user.type(confirmField, "Sup3rSecretPas");
  expect(within(recovery).getByRole("button", { name: /Save New Password/i })).toBeDisabled();

  await user.type(confirmField, "s");
  await user.click(within(recovery).getByRole("button", { name: /Save New Password/i }));

  expect(await within(recovery).findByText(/Password updated/i)).toBeInTheDocument();

  const confirmCall = calls.find((call) =>
    call.url.includes("/api/auth/password-reset/confirm")
  );
  expect(confirmCall?.body).toEqual({
    resetToken: "token-abcdefghijklmnop",
    newPassword: "Sup3rSecretPass",
  });
  expect(onAuthenticated).not.toHaveBeenCalled();

  await user.click(within(recovery).getByRole("button", { name: /Back to Sign In/i }));
  expect(screen.queryByTestId("password-recovery")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Sign in to User Console/i })).toBeInTheDocument();
});

it("shows the Worker's message when the code is wrong", async () => {
  const calls = installFetchMock();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: "POST", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("/password-reset/verify")) {
      return new Response(
        JSON.stringify({ error: "That code is not correct. 4 attempts left.", code: "OTP_MISMATCH" }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const user = userEvent.setup();
  render(<CustomerAuthPage onAuthenticated={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: /Forgot password\?/i }));
  const recovery = await screen.findByTestId("password-recovery");
  await user.type(within(recovery).getByLabelText(/Email address/i), "owner@homecoreos.local");
  await user.click(within(recovery).getByRole("button", { name: /Send Recovery Code/i }));
  await user.type(within(recovery).getByLabelText(/Six-digit code/i), "999999");
  await user.click(within(recovery).getByRole("button", { name: /Verify Code/i }));

  expect(await within(recovery).findByText(/4 attempts left/i)).toBeInTheDocument();
  expect(within(recovery).queryByLabelText(/Re-enter new password/i)).not.toBeInTheDocument();
});
