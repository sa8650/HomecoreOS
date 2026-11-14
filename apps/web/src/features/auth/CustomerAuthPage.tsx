import { useState, type FormEvent } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { getBrowserTimezoneFallback } from "@/lib/timezone";
import { HomecoreWordmark } from "@/components/graphics/HomecoreGraphics";
import {
  FormField,
  StatusAlert,
  ThemeToggleButton,
  TimezoneSelect,
} from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PerspectiveGrid } from "@/components/ui/perspective-grid";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";

interface CustomerAuthPageProps {
  initialTab?: "login" | "register" | "invite";
  initialInviteCode?: string;
  onAuthenticated: () => Promise<void> | void;
  onNavigate: (path: string) => void;
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
}

export function CustomerAuthPage({
  initialTab = "login",
  initialInviteCode = "",
  onAuthenticated,
  onNavigate,
  themeMode,
  onToggleTheme,
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
      <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
        <div className="fixed inset-0 z-0">
          <PerspectiveGrid gridSize={36} fadeRadius={82} />
        </div>

        <div className="pointer-events-none relative z-10 flex min-h-screen flex-col justify-between p-4 sm:p-6">
          <header className="pointer-events-auto mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
            <HomecoreWordmark subtitle="Smart-Home Automation Platform" />
            <div className="flex items-center gap-2">
              <ThemeToggleButton themeMode={themeMode} onToggleTheme={onToggleTheme} />
              <Button size="xs" variant="ghost" onClick={() => onNavigate("/admin/login")}>
                Platform Admin Console
              </Button>
            </div>
          </header>

          <main className="mx-auto my-8 w-full max-w-[480px]">
            <Card className="pointer-events-auto bg-card/95 p-6 shadow-md backdrop-blur-sm">
            <CardContent className="p-0">
              <div className="mb-5">
                <h1 className="text-xl font-semibold tracking-tight text-foreground">
                  Customer User Console
                </h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  Sign in to control rooms on your 2D floor plan, flash controllers over USB, and automate hardware.
                </p>
              </div>

              {errorMsg && (
                <StatusAlert tone="danger" className="mb-4">
                  {errorMsg}
                </StatusAlert>
              )}

              <Tabs value={tab} onValueChange={setTab} className="space-y-4">
                <TabsList className="w-full">
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
            </CardContent>
          </Card>
        </main>

          <footer className="pointer-events-auto mx-auto flex w-full max-w-5xl items-center justify-between text-[11px] text-muted-foreground">
            <span>HomecoreOS · Custom Argon2id Auth & HTTP-only Sessions</span>
            <span>ESP32-S3 Native</span>
          </footer>
        </div>
      </div>
    </TooltipProvider>
  );
}
