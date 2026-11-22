import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Session = { id: string; transport: string; status: string; started_at: string; detected_problems: string[]; unresolved_problems: string[]; next_action: string | null; firmware_version_before: string | null };
/** Explicitly loaded; no permanent polling or device-control capabilities. */
export function RecoveryHistory({ endpoint = "/api/recovery/history" }: { endpoint?: string }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <section className="space-y-2 rounded border p-3">
    <h3 className="font-semibold">Recovery history · read-only</h3>
    <Button variant="outline" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { const data = await apiFetch<{ sessions: Session[] }>(endpoint); setSessions(data.sessions ?? []); }
      catch (err) { setError(err instanceof Error ? err.message : "Could not load history"); }
      finally { setBusy(false); }
    }}>{busy ? "Loading recovery history…" : "Load recovery history"}</Button>
    {error && <p role="alert">{error}</p>}
    {sessions?.length === 0 && <p>No recorded recovery sessions.</p>}
    {sessions?.map((item) => <details key={item.id} className="rounded border p-2 text-sm"><summary>{item.started_at} · {item.transport} · {item.status}</summary>
      <p>Session: {item.id} · Firmware: {item.firmware_version_before ?? "Unknown"}</p>
      <p>Detected problems: {item.detected_problems?.join(", ") || "None confirmed"}</p>
      <p>Unresolved: {item.unresolved_problems?.join(", ") || "None confirmed"}</p>
      <p>{item.next_action}</p>
    </details>)}
    <p className="text-xs text-muted-foreground">Latest 20 sessions. Local-only reports are not available in server history.</p>
  </section>;
}
