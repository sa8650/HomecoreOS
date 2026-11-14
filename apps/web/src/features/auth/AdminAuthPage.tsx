import { useEffect, useState, type FormEvent } from "react";
import { RiArrowLeftLine, RiShieldFlashLine } from "@remixicon/react";
import { apiFetch, ApiError } from "@/lib/api";
import { HomecoreWordmark } from "@/components/graphics/HomecoreGraphics";
import { IconTile } from "@/components/reui/icon-tile";
import {
  FormField,
  StatusAlert,
  ThemeToggleButton,
} from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PerspectiveGrid } from "@/components/ui/perspective-grid";
import { TooltipProvider } from "@/components/ui/tooltip";

interface AdminAuthPageProps {
  onAuthenticated: () => Promise<void> | void;
  onNavigate: (path: string) => void;
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
}

export function AdminAuthPage({
  onAuthenticated,
  onNavigate,
  themeMode,
  onToggleTheme,
}: AdminAuthPageProps) {
  const [checking, setChecking] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    apiFetch<{ needsBootstrap: boolean }>("/api/admin/auth/bootstrap-status")
      .then((res) => setNeedsBootstrap(res.needsBootstrap))
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);
    try {
      if (needsBootstrap) {
        await apiFetch("/api/admin/auth/bootstrap", {
          method: "POST",
          body: JSON.stringify({ email, fullName, password }),
        });
      } else {
        await apiFetch("/api/admin/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
      }
      await onAuthenticated();
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : "Authentication failed.");
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
            <div className="flex items-center gap-3">
              <HomecoreWordmark subtitle="Platform Operations" compact />
              <Button
                size="xs"
                variant="ghost"
                onClick={() => onNavigate("/login")}
              >
                <RiArrowLeftLine className="size-3.5" aria-hidden="true" />
                Back to Customer Sign-In
              </Button>
            </div>
            <ThemeToggleButton themeMode={themeMode} onToggleTheme={onToggleTheme} />
          </header>

          <main className="mx-auto my-8 w-full max-w-[440px]">
            <Card className="pointer-events-auto bg-card/95 p-6 shadow-md backdrop-blur-sm">
            <CardContent className="p-0">
              <div className="mb-5 flex items-center gap-3">
                <IconTile variant="solid" size="default">
                  <RiShieldFlashLine className="size-5" aria-hidden="true" />
                </IconTile>
                <div>
                  <h1 className="text-lg font-semibold text-foreground">
                    {needsBootstrap ? "Bootstrap Root Administrator" : "Platform Admin Console"}
                  </h1>
                  <p className="text-xs text-muted-foreground">
                    {needsBootstrap
                      ? "Create the initial super_admin account. This step locks permanently afterward."
                      : "Restricted to platform administrators and support operators."}
                  </p>
                </div>
              </div>

              {checking ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  Checking platform bootstrap status...
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                  {errorMsg && <StatusAlert tone="danger">{errorMsg}</StatusAlert>}

                  {needsBootstrap && (
                    <FormField id="adm-name" label="Administrator Full Name">
                      <Input
                        id="adm-name"
                        required
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="Platform Owner"
                      />
                    </FormField>
                  )}

                  <FormField id="adm-email" label="Administrator Email">
                    <Input
                      id="adm-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="admin@homecoreos.local"
                    />
                  </FormField>

                  <FormField
                    id="adm-pass"
                    label="Password"
                    hint={needsBootstrap ? "Minimum 10 characters required for root admin" : undefined}
                  >
                    <Input
                      id="adm-pass"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter administrator password"
                    />
                  </FormField>

                  <Button type="submit" disabled={loading} className="w-full">
                    {loading
                      ? "Verifying..."
                      : needsBootstrap
                        ? "Create Initial Super Admin"
                        : "Sign In to Admin Console"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </main>

          <footer className="pointer-events-auto mx-auto w-full max-w-5xl text-center text-[11px] text-muted-foreground">
            HomecoreOS Platform Operations · Strictly Isolated Admin Sessions
          </footer>
        </div>
      </div>
    </TooltipProvider>
  );
}
