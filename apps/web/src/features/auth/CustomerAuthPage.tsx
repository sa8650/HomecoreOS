import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { getBrowserTimezoneFallback } from "@/lib/timezone";
import { HomecoreWordmark } from "@/components/graphics/HomecoreGraphics";
import {
  FormField,
  StatusAlert,
  TimezoneSelect,
} from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PerspectiveGrid } from "@/components/ui/perspective-grid";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TechnologyEcosystem } from "@/features/auth/TechnologyEcosystem";

interface CustomerAuthPageProps {
  initialTab?: "login" | "register" | "invite";
  initialInviteCode?: string;
  onAuthenticated: () => Promise<void> | void;
}

export function CustomerAuthPage({
  initialTab = "login",
  initialInviteCode = "",
  onAuthenticated,
}: CustomerAuthPageProps) {
  const [tab, setTab] = useState<string>(initialTab);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [regEmail, setRegEmail] = useState("");
  const [regFullName, setRegFullName] = useState("");
  const [regAccountName, setRegAccountName] = useState("");
  const [regHomeName, setRegHomeName] = useState("Primary Home");
  const [regTimezone, setRegTimezone] = useState(() => getBrowserTimezoneFallback());
  const [regPassword, setRegPassword] = useState("");

  const [inviteCode, setInviteCode] = useState(initialInviteCode);

  // Password recovery: ask for a code, verify it, then set a new password twice.
  const [resetStep, setResetStep] = useState<"idle" | "email" | "otp" | "password" | "done">(
    "idle"
  );
  const [resetEmail, setResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  function openPasswordRecovery() {
    setResetEmail(loginEmail);
    setResetCode("");
    setResetToken("");
    setResetPassword("");
    setResetConfirm("");
    setResetError(null);
    setResetNotice(null);
    setResetStep("email");
  }

  function closePasswordRecovery() {
    setResetStep("idle");
    setResetError(null);
    setResetNotice(null);
    setResetCode("");
    setResetToken("");
    setResetPassword("");
    setResetConfirm("");
  }

  async function handleResetRequest(e: FormEvent) {
    e.preventDefault();
    setResetError(null);
    setResetBusy(true);
    try {
      await apiFetch("/api/auth/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email: resetEmail }),
      });
      setResetNotice(
        `If an account exists for ${resetEmail.trim()}, a six-digit code is on its way.`
      );
      setResetStep("otp");
    } catch (err) {
      setResetError(
        err instanceof ApiError ? err.message : "The recovery code could not be sent."
      );
    } finally {
      setResetBusy(false);
    }
  }

  async function handleResetVerify(e: FormEvent) {
    e.preventDefault();
    setResetError(null);
    setResetBusy(true);
    try {
      const res = await apiFetch<{ resetToken: string }>(
        "/api/auth/password-reset/verify",
        {
          method: "POST",
          body: JSON.stringify({ email: resetEmail, otp: resetCode }),
        }
      );
      setResetToken(res.resetToken);
      setResetNotice("Code confirmed. Choose a new password.");
      setResetStep("password");
    } catch (err) {
      setResetError(err instanceof ApiError ? err.message : "That code could not be verified.");
    } finally {
      setResetBusy(false);
    }
  }

  async function handleResetConfirm(e: FormEvent) {
    e.preventDefault();
    setResetError(null);
    if (resetPassword.length < 8) {
      setResetError("Choose a password of at least 8 characters.");
      return;
    }
    if (resetPassword !== resetConfirm) {
      setResetError("The two passwords do not match.");
      return;
    }
    setResetBusy(true);
    try {
      await apiFetch("/api/auth/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({ resetToken, newPassword: resetPassword }),
      });
      setResetNotice(null);
      setResetStep("done");
      setLoginPassword("");
    } catch (err) {
      setResetError(
        err instanceof ApiError ? err.message : "The new password could not be saved."
      );
    } finally {
      setResetBusy(false);
    }
  }

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (initialInviteCode) {
      setInviteCode(initialInviteCode);
    }
  }, [initialInviteCode]);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: loginEmail,
          password: loginPassword,
        }),
      });
      if (tab === "invite" && inviteCode.trim()) {
        await apiFetch("/api/auth/invitations/accept", {
          method: "POST",
          body: JSON.stringify({ code: inviteCode.trim() }),
        });
      }
      await onAuthenticated();
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email: regEmail,
          password: regPassword,
          fullName: regFullName,
          accountName: regAccountName || undefined,
          homeName: regHomeName || undefined,
          timezone: regTimezone || undefined,
        }),
      });
      if (tab === "invite" && inviteCode.trim()) {
        await apiFetch("/api/auth/invitations/accept", {
          method: "POST",
          body: JSON.stringify({ code: inviteCode.trim() }),
        });
      }
      await onAuthenticated();
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
        <div className="fixed inset-0 z-0">
          <PerspectiveGrid gridSize={36} fadeRadius={82} />
        </div>

        <div className="pointer-events-none relative z-10 flex min-h-screen flex-col justify-between p-4 sm:p-6">
          <header className="pointer-events-auto mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
            <HomecoreWordmark subtitle="Connect Everything. Control Anything" />
          </header>

          <main className="mx-auto my-8 w-full max-w-[480px]">
            <Card className="pointer-events-auto bg-card/95 p-6 shadow-md backdrop-blur-sm">
            <CardContent className="p-0">
              <div className="mb-5">
                <h1 className="text-xl font-semibold tracking-tight text-foreground">
                  Welcome Home
                </h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  Everything in your home, in one quiet, personal place.
                </p>
              </div>

              {errorMsg && (
                <StatusAlert tone="danger" className="mb-4">
                  {errorMsg}
                </StatusAlert>
              )}

              {resetStep !== "idle" ? (
                <div className="space-y-4" data-testid="password-recovery">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">
                        {resetStep === "done" ? "Password updated" : "Recover your password"}
                      </h2>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {resetStep === "email" &&
                          "We email a six-digit code to the address on your account."}
                        {resetStep === "otp" && `Enter the code sent to ${resetEmail.trim()}.`}
                        {resetStep === "password" && "Choose a new password and type it twice."}
                        {resetStep === "done" && "Sign in with your new password."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={closePasswordRecovery}
                      className="shrink-0 text-[11px] font-medium text-primary hover:underline cursor-pointer"
                    >
                      {resetStep === "done" ? "Done" : "Cancel"}
                    </button>
                  </div>

                  {resetNotice && resetStep !== "done" && (
                    <StatusAlert tone="info">{resetNotice}</StatusAlert>
                  )}
                  {resetError && <StatusAlert tone="danger">{resetError}</StatusAlert>}

                  {resetStep === "email" && (
                    <form onSubmit={handleResetRequest} className="space-y-4">
                      <FormField id="reset-email" label="Email address">
                        <Input
                          id="reset-email"
                          type="email"
                          required
                          autoFocus
                          value={resetEmail}
                          onChange={(e) => setResetEmail(e.target.value)}
                          placeholder="you@example.com"
                        />
                      </FormField>
                      <Button type="submit" disabled={resetBusy} className="w-full">
                        {resetBusy ? "Sending code..." : "Send Recovery Code"}
                      </Button>
                    </form>
                  )}

                  {resetStep === "otp" && (
                    <form onSubmit={handleResetVerify} className="space-y-4">
                      <FormField
                        id="reset-code"
                        label="Six-digit code"
                        hint="The code expires in 10 minutes and works once."
                      >
                        <Input
                          id="reset-code"
                          required
                          autoFocus
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          pattern="\d{6}"
                          value={resetCode}
                          onChange={(e) =>
                            setResetCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                          }
                          placeholder="123456"
                          className="text-center text-lg tracking-[0.4em] tabular-nums"
                        />
                      </FormField>
                      <Button
                        type="submit"
                        disabled={resetBusy || resetCode.length !== 6}
                        className="w-full"
                      >
                        {resetBusy ? "Verifying..." : "Verify Code"}
                      </Button>
                      <button
                        type="button"
                        onClick={handleResetRequest}
                        disabled={resetBusy}
                        className="w-full text-center text-[11px] font-medium text-primary hover:underline cursor-pointer disabled:opacity-50"
                      >
                        Send a new code
                      </button>
                    </form>
                  )}

                  {resetStep === "password" && (
                    <form onSubmit={handleResetConfirm} className="space-y-4">
                      <FormField
                        id="reset-password"
                        label="New password"
                        hint="Minimum 8 characters."
                      >
                        <Input
                          id="reset-password"
                          type="password"
                          required
                          autoFocus
                          autoComplete="new-password"
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          placeholder="Create a strong password"
                        />
                      </FormField>
                      <FormField id="reset-confirm" label="Re-enter new password">
                        <Input
                          id="reset-confirm"
                          type="password"
                          required
                          autoComplete="new-password"
                          value={resetConfirm}
                          onChange={(e) => setResetConfirm(e.target.value)}
                          placeholder="Type the same password again"
                        />
                      </FormField>
                      <Button
                        type="submit"
                        disabled={
                          resetBusy ||
                          resetPassword.length < 8 ||
                          resetPassword !== resetConfirm
                        }
                        className="w-full"
                      >
                        {resetBusy ? "Saving..." : "Save New Password"}
                      </Button>
                    </form>
                  )}

                  {resetStep === "done" && (
                    <Button type="button" onClick={closePasswordRecovery} className="w-full">
                      Back to Sign In
                    </Button>
                  )}
                </div>
              ) : (
              <Tabs value={tab} onValueChange={setTab} className="space-y-4">
                <TabsList className="w-full overflow-visible">
                  <TabsTrigger value="login">Sign In</TabsTrigger>
                  <TabsTrigger value="register">Create Account</TabsTrigger>
                  <TabsTrigger value="invite">Join via Invite</TabsTrigger>
                </TabsList>

                <TabsContent value="login">
                  <form onSubmit={handleLogin} className="space-y-4">
                    <FormField id="login-email" label="Email address">
                      <Input
                        id="login-email"
                        type="email"
                        required
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        placeholder="you@example.com"
                      />
                    </FormField>
                    <FormField id="login-pass" label="Password">
                      <Input
                        id="login-pass"
                        type="password"
                        required
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        placeholder="Enter your password"
                      />
                    </FormField>
                    <button
                      type="button"
                      onClick={openPasswordRecovery}
                      className="w-full text-right text-[11px] font-medium text-primary hover:underline cursor-pointer"
                    >
                      Forgot password?
                    </button>
                    <Button type="submit" disabled={loading} className="w-full">
                      {loading ? "Signing in..." : "Sign in to User Console"}
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="register">
                  <form onSubmit={handleRegister} className="space-y-3.5">
                    <FormField id="reg-name" label="Full name">
                      <Input
                        id="reg-name"
                        required
                        value={regFullName}
                        onChange={(e) => setRegFullName(e.target.value)}
                        placeholder="Alex Rivera"
                      />
                    </FormField>
                    <FormField id="reg-email" label="Email address">
                      <Input
                        id="reg-email"
                        type="email"
                        required
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        placeholder="alex@example.com"
                      />
                    </FormField>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FormField id="reg-acc" label="Account name">
                        <Input
                          id="reg-acc"
                          value={regAccountName}
                          onChange={(e) => setRegAccountName(e.target.value)}
                          placeholder="Rivera Household"
                        />
                      </FormField>
                      <FormField id="reg-home" label="Primary home name">
                        <Input
                          id="reg-home"
                          value={regHomeName}
                          onChange={(e) => setRegHomeName(e.target.value)}
                          placeholder="Primary Home"
                        />
                      </FormField>
                    </div>
                    <FormField id="reg-tz" label="Regional timezone">
                      <TimezoneSelect
                        id="reg-tz"
                        ariaLabel="Regional timezone"
                        value={regTimezone}
                        onValueChange={setRegTimezone}
                      />
                    </FormField>
                    <FormField
                      id="reg-pass"
                      label="Password"
                      hint="Minimum 8 characters, hashed with Argon2id"
                    >
                      <Input
                        id="reg-pass"
                        type="password"
                        required
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        placeholder="Create a strong password"
                      />
                    </FormField>
                    <Button type="submit" disabled={loading} className="w-full">
                      {loading ? "Creating account..." : "Create Customer Account"}
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="invite">
                  <form onSubmit={handleLogin} className="space-y-4">
                    <FormField
                      id="inv-code"
                      label="Staff Invitation Code"
                      hint="Sign in with your customer email & password to accept this invitation."
                    >
                      <Input
                        id="inv-code"
                        required
                        value={inviteCode}
                        onChange={(e) => setInviteCode(e.target.value)}
                        placeholder="HC-xxxxxxxx"
                      />
                    </FormField>
                    <FormField id="inv-email" label="Email address">
                      <Input
                        id="inv-email"
                        type="email"
                        required
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        placeholder="staff@example.com"
                      />
                    </FormField>
                    <FormField id="inv-pass" label="Password">
                      <Input
                        id="inv-pass"
                        type="password"
                        required
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                      />
                    </FormField>
                    <Button type="submit" disabled={loading} className="w-full">
                      {loading ? "Joining account..." : "Sign In & Accept Invite"}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
              )}
            </CardContent>
          </Card>
        </main>

          <footer className="pointer-events-auto mx-auto flex w-full max-w-5xl flex-col items-center gap-3 text-[11px] text-muted-foreground">
            <TechnologyEcosystem />
            <div className="flex w-full items-center justify-between">
              <span>Smart Things · Powered by HomecoreOS</span>
              <span>ESP32 Native</span>
            </div>
          </footer>
        </div>
      </div>
    </TooltipProvider>
  );
}
