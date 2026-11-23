import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSessionData } from "@/features/types";
import { UserOnboardingPage } from "./UserOnboardingPage";
import { jsonResponse } from "@/test/http";

const originalFetch = globalThis.fetch;

function session(overrides?: Partial<UserSessionData["onboarding"]>): UserSessionData {
  return {
    user: {
      id: "u1",
      email: "new@example.com",
      fullName: "New Owner",
      appearancePreference: "system",
      timezone: null,
    },
    account: {
      id: "a1",
      name: "New Home",
      slug: "new-home",
      status: "active",
      staffRole: "owner",
    },
    accounts: [
      { id: "a1", name: "New Home", slug: "new-home", status: "active", staffRole: "owner" },
    ],
    onboarding: {
      required: true,
      step: 1,
      completedAt: null,
      startedAt: null,
      ...overrides,
    },
  };
}

function renderPage(
  overrides?: Partial<UserSessionData["onboarding"]>,
  handlers?: { onFinished?: () => void; onSignOut?: () => void; onSessionRefresh?: () => void }
) {
  return render(
    <UserOnboardingPage
      session={session(overrides)}
      onSessionRefresh={handlers?.onSessionRefresh ?? (() => {})}
      onSignOut={handlers?.onSignOut ?? (() => {})}
      onFinished={handlers?.onFinished ?? (() => {})}
    />
  );
}

describe("Mandatory user onboarding", () => {
  let putCalls: unknown[];
  let completionCalls: number;

  beforeEach(() => {
    putCalls = [];
    completionCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/auth/onboarding/complete")) {
        completionCalls += 1;
        return jsonResponse({
          onboarding: { required: false, step: 4, completedAt: "2026-11-19T10:00:00.000Z", startedAt: null },
        });
      }
      if (url.endsWith("/api/auth/onboarding") && (init?.method ?? "GET") === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { step: number };
        putCalls.push(body.step);
        return jsonResponse({
          onboarding: {
            required: true,
            step: body.step,
            completedAt: null,
            startedAt: "2026-11-19T09:59:00.000Z",
          },
        });
      }
      return jsonResponse({});
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("opens on step 1 with a four-step indicator and no way to skip", async () => {
    renderPage();

    expect(
      screen.getByRole("heading", { name: /Welcome to Your Smart Home/i })
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Step 1 of 4/i).length).toBeGreaterThan(0);

    const indicator = screen.getByRole("progressbar");
    expect(indicator).toHaveAttribute("aria-valuemax", "4");
    expect(indicator).toHaveAttribute("aria-valuenow", "1");

    // No skip, close, dismiss or "later" affordance anywhere.
    for (const forbidden of [/skip/i, /close/i, /dismiss/i, /later/i, /remind me/i]) {
      expect(screen.queryByRole("button", { name: forbidden })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /^×$/ })).toBeNull();

    // Back is disabled on the first step; Next is the only way forward.
    expect(screen.getByRole("button", { name: /^Back$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Next$/i })).toBeEnabled();
    // "Get Started" only exists on the last step.
    expect(screen.queryByRole("button", { name: /Get Started/i })).toBeNull();
  });

  it("walks forward one step at a time and persists each step", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /^Next$/i }));
    await waitFor(() => expect(putCalls).toEqual([2]));
    expect(
      screen.getByRole("heading", { name: /Connect Your Hardware/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");

    await user.click(screen.getByRole("button", { name: /^Next$/i }));
    await waitFor(() => expect(putCalls).toEqual([2, 3]));
    expect(
      screen.getByRole("heading", { name: /Control and Automate Your Home/i })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Next$/i }));
    await waitFor(() => expect(putCalls).toEqual([2, 3, 4]));
    expect(
      screen.getByRole("heading", { name: /Monitor, Manage and Expand/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/Your home is ready\. Let's make it smarter\./i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Get Started/i })).toBeInTheDocument();

    // Four steps is the ceiling: Next is gone and completion is explicit.
    expect(screen.queryByRole("button", { name: /^Next$/i })).toBeNull();
    expect(putCalls).toEqual([2, 3, 4]);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");
  });

  it("supports Back without losing the furthest saved step", async () => {
    const user = userEvent.setup();
    renderPage({ step: 3 });

    expect(
      screen.getByRole("heading", { name: /Control and Automate Your Home/i })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Back$/i }));
    expect(
      screen.getByRole("heading", { name: /Connect Your Hardware/i })
    ).toBeInTheDocument();
    await waitFor(() => expect(putCalls).toEqual([2]));

    await user.click(screen.getByRole("button", { name: /^Back$/i }));
    expect(
      screen.getByRole("heading", { name: /Welcome to Your Smart Home/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Back$/i })).toBeDisabled();
  });

  it("resumes on the step stored against the account", async () => {
    renderPage({ step: 3 });

    expect(
      screen.getByRole("heading", { name: /Control and Automate Your Home/i })
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Step 3 of 4/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Back$/i })).toBeEnabled();
  });

  it("completes with Get Started and hands control back to the dashboard", async () => {
    const user = userEvent.setup();
    const onFinished = vi.fn();
    const onSessionRefresh = vi.fn();
    renderPage({ step: 4 }, { onFinished, onSessionRefresh });

    await user.click(screen.getByRole("button", { name: /Get Started/i }));

    await waitFor(() => expect(completionCalls).toBe(1));
    await waitFor(() => expect(onSessionRefresh).toHaveBeenCalled());
    expect(onFinished).toHaveBeenCalled();
  });

  it("keeps the user on the tour when completing fails", async () => {
    const user = userEvent.setup();
    const onFinished = vi.fn();
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/auth/onboarding/complete")) {
        return jsonResponse({ error: "Onboarding could not be completed." }, 500);
      }
      return jsonResponse({});
    }) as typeof fetch;

    renderPage({ step: 4 }, { onFinished });

    await user.click(screen.getByRole("button", { name: /Get Started/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(onFinished).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Get Started/i })).toBeEnabled();
  });

  it("lets a user sign out without completing onboarding", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    renderPage(undefined, { onSignOut });

    await user.click(screen.getByRole("button", { name: /Sign out/i }));

    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(completionCalls).toBe(0);
    expect(putCalls).toEqual([]);
  });

  it("never renders an escape hatch: no route buttons, no close control in the card", async () => {
    renderPage({ step: 2 });
    const region = screen.getByRole("region", { name: /HomecoreOS onboarding/i });

    const buttons = within(region)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "");
    expect(buttons).toEqual(expect.arrayContaining(["Back", "Next"]));
    expect(buttons.join(" ")).not.toMatch(/skip|close|dismiss|later|exit|dashboard/i);
  });
});
