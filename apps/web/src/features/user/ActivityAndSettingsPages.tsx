import { AVATAR_SEEDS, UserAvatar } from "@/components/shared/UserAvatar";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiHistoryLine,
  RiShieldUserLine,
  RiTimeLine,
} from "@remixicon/react";
import { toast } from "sonner";
import { apiFetch, ApiError, cachedGet, getCachedSnapshot } from "@/lib/api";
import {
  formatTimestamp,
  getBrowserTimezoneFallback,
  useEffectiveTimezone,
} from "@/lib/timezone";
import { Badge } from "@/components/reui/badge";
import {
  ConfirmDeleteDialog,
  EmptyStatePanel,
  FormField,
  PageHeader,
  StatusAlert,
  TimezoneSelect,
} from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { UserNotificationPreferences } from "@homecoreos/shared";
import type { ActivityItem, UserSessionData } from "@/features/types";
import { Switch } from "@/components/ui/switch";

const USER_PREFERENCE_DEFS: Array<{
  key: keyof UserNotificationPreferences;
  label: string;
  description: string;
}> = [
  {
    key: "controller_offline_online",
    label: "Controller Online / Offline Alerts",
    description: "Notify when an ESP32 controller disconnects or reconnects to EMQX.",
  },
  {
    key: "device_disconnected",
    label: "Device Disconnected Alerts",
    description: "Notify when a controlled relay, light, or actuator loses connection.",
  },
  {
    key: "sensor_alerts",
    label: "Sensor Threshold Alerts",
    description: "Notify when temperature, humidity, motion, or contact rules trigger.",
  },
  {
    key: "automation_failures",
    label: "Automation Failure Alerts",
    description: "Alert when a cloud or hybrid automation rule fails to execute.",
  },
  {
    key: "firmware_updates",
    label: "New Firmware Releases",
    description: "Notify when a verified firmware release is published for your boards.",
  },
  {
    key: "firmware_install_results",
    label: "Firmware OTA / USB Results",
    description: "Notify when an OTA or Web Serial USB flash completes or fails.",
  },
  {
    key: "security_events",
    label: "Account Security Events",
    description: "Alert on password changes, staff invitations, or new login sessions.",
  },
];

export function ActivityPage() {
  const timezone = useEffectiveTimezone();
  const initialCached = getCachedSnapshot<{ activity: ActivityItem[] }>("/api/activity");
  const [items, setItems] = useState<ActivityItem[]>(() => initialCached?.activity ?? []);
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(!initialCached);
  const [error, setError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  async function load(cat: string) {
    const seq = ++loadSeqRef.current;
    const qs = cat === "all" ? "" : `?category=${encodeURIComponent(cat)}`;
    const url = `/api/activity${qs}`;
    const snap = getCachedSnapshot<{ activity: ActivityItem[] }>(url);
    if (snap) {
      setItems(snap.activity);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const res = await cachedGet<{ activity: ActivityItem[] }>(url, { ttlMs: 15_000 });
      if (loadSeqRef.current === seq) {
        setItems(res.activity);
      }
    } catch (err) {
      if (loadSeqRef.current === seq) {
        setError(err instanceof ApiError ? err.message : "Failed to load activity.");
      }
    } finally {
      if (loadSeqRef.current === seq) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void load(category);
  }, [category]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Audit Trail"
        title="Activity Log"
        description={`Real audit events across pairing, switches, firmware, and security (${timezone}).`}
        actions={
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger aria-label="Filter category" size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              <SelectItem value="controller">Controller</SelectItem>
              <SelectItem value="pairing">Pairing</SelectItem>
              <SelectItem value="switch">Switches</SelectItem>
              <SelectItem value="device">Devices</SelectItem>
              <SelectItem value="sensor">Sensors</SelectItem>
              <SelectItem value="firmware">Firmware</SelectItem>
              <SelectItem value="automation">Automation</SelectItem>
              <SelectItem value="staff">Staff</SelectItem>
              <SelectItem value="security">Security</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      {error && <StatusAlert tone="danger">{error}</StatusAlert>}

      {loading ? (
        <div className="py-12 text-center text-xs text-muted-foreground">
          Loading audit trail...
        </div>
      ) : items.length === 0 ? (
        <EmptyStatePanel
          icon={<RiHistoryLine />}
          tone="neutral"
          title="No activity events recorded yet"
          description="Controller pairings, switch changes, automations, firmware flashes, and security events appear here."
        />
      ) : (
        <Card className="overflow-hidden py-0">
          <Table className="text-xs">
            <TableHeader className="bg-muted/60">
              <TableRow>
                <TableHead className="px-4">Summary</TableHead>
                <TableHead className="px-4">Category</TableHead>
                <TableHead className="px-4">Action</TableHead>
                <TableHead className="px-4">Timestamp ({timezone})</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="px-4">
                    <div className="flex items-center gap-2">
                      <RiHistoryLine className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="font-medium text-foreground">
                        {item.summary}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="px-4">
                    <Badge variant="secondary">{item.category}</Badge>
                  </TableCell>
                  <TableCell className="px-4 font-mono text-[11px] text-muted-foreground">
                    {item.action}
                  </TableCell>
                  <TableCell className="px-4 tabular-nums text-muted-foreground">
                    {formatTimestamp(item.created_at, timezone)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

interface StaffMember {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  role: "owner" | "administrator" | "operator" | "viewer";
  status: "active" | "suspended";
}

interface SessionItem {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  last_seen_at: string;
  expires_at: string;
  isCurrent: boolean;
}

export function UserSettingsPage({
  session,
  onSessionRefresh,
}: {
  session: UserSessionData;
  onSessionRefresh: () => Promise<void>;
}) {
  const effectiveTimezone = useEffectiveTimezone();
  const isOwner = session.account.staffRole === "owner";
  const canManageStaff =
    session.account.staffRole === "owner" ||
    session.account.staffRole === "administrator";
  const isAccountActive = session.account.status === "active";

  const [avatarSeed, setAvatarSeed] = useState<string | null>(session.user.avatarSeed ?? null);
  const [fullName, setFullName] = useState(session.user.fullName);
  const [accountName, setAccountName] = useState(session.account.name);
  const [timezonePref, setTimezonePref] = useState<string>(session.user.timezone ?? "__default__");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const [sessionsList, setSessionsList] = useState<SessionItem[]>([]);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [notifPrefs, setNotifPrefs] = useState<UserNotificationPreferences | null>(null);
  const [savingNotifPrefs, setSavingNotifPrefs] = useState(false);
  const [inviteRole, setInviteRole] = useState<"administrator" | "operator" | "viewer">("operator");
  const [generatedInviteLink, setGeneratedInviteLink] = useState<string | null>(null);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  const platformDefault = session.platformDefaultTimezone ?? "UTC";

  useEffect(() => {
    setAvatarSeed(session.user.avatarSeed ?? null);
    setFullName(session.user.fullName);
    setAccountName(session.account.name);
    setTimezonePref(session.user.timezone ?? "__default__");
  }, [session.user.fullName, session.account.name, session.user.timezone, session.user.avatarSeed]);

  const loadDetails = useCallback(async () => {
    try {
      const [sRes, pRes] = await Promise.all([
        apiFetch<{ sessions: SessionItem[] }>("/api/auth/sessions"),
        apiFetch<{ preferences: UserNotificationPreferences }>(
          "/api/notifications/preferences"
        ).catch(() => ({ preferences: null })),
      ]);
      setSessionsList(sRes.sessions);
      setNotifPrefs(pRes.preferences);
      if (isAccountActive) {
        const stRes = await apiFetch<{ staff: StaffMember[] }>("/api/account/staff");
        setStaffList(stRes.staff);
      }
    } catch {
      // Handled smoothly if account paused
    }
  }, [isAccountActive]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails, session.account.id, session.account.status]);

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({
          fullName,
          avatarSeed,
          timezone: timezonePref === "__default__" ? null : timezonePref,
        }),
      });
      if (canManageStaff && isAccountActive && accountName !== session.account.name) {
        await apiFetch("/api/account", {
          method: "PATCH",
          body: JSON.stringify({ name: accountName }),
        });
      }
      toast.success("Profile and regional timezone saved.");
      await onSessionRefresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Update failed.");
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Password updated; other active sessions revoked.");
      await loadDetails();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Password change failed.");
    }
  }

  async function handleToggleNotifPref(
    key: keyof UserNotificationPreferences,
    enabled: boolean
  ) {
    if (!notifPrefs) return;
    const nextPrefs: UserNotificationPreferences = { ...notifPrefs, [key]: enabled };
    setNotifPrefs(nextPrefs);
    setSavingNotifPrefs(true);
    try {
      await apiFetch("/api/notifications/preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: enabled }),
      });
      toast.success("Notification preferences updated.");
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to save notification preferences."
      );
      void loadDetails();
    } finally {
      setSavingNotifPrefs(false);
    }
  }

  async function handleRevokeSession(id: string) {
    try {
      await apiFetch(`/api/auth/sessions/${id}`, { method: "DELETE" });
      toast.success("Session revoked.");
      await loadDetails();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to revoke session.");
    }
  }

  async function handleCreateInvite() {
    try {
      const res = await apiFetch<{ inviteLink: string; inviteCode: string }>(
        "/api/account/staff/invitations",
        {
          method: "POST",
          body: JSON.stringify({ role: inviteRole, expiresInHours: 48 }),
        }
      );
      setGeneratedInviteLink(`${res.inviteCode} — ${res.inviteLink}`);
      toast.success("Staff invitation link created.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to generate invite.");
    }
  }

  async function handleStaffAction(staffId: string, action: "suspend" | "reactivate" | "remove") {
    try {
      if (action === "remove") {
        await apiFetch(`/api/account/staff/${staffId}`, { method: "DELETE" });
        toast.success("Staff member removed.");
      } else {
        await apiFetch(`/api/account/staff/${staffId}/${action}`, { method: "POST" });
        toast.success(
          action === "suspend" ? "Staff member suspended." : "Staff member reactivated."
        );
      }
      await loadDetails();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Staff update failed.");
    }
  }

  async function handlePauseAccount() {
    try {
      await apiFetch("/api/account/pause", { method: "POST" });
      toast.success("Account paused.");
      await onSessionRefresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to pause account.");
    }
  }

  async function handleRequestDeletion() {
    setDeletingAccount(true);
    try {
      await apiFetch("/api/account/request-deletion", {
        method: "POST",
        body: JSON.stringify({ reason: "Requested via User Settings" }),
      });
      toast.success("Account deletion requested.");
      setConfirmDeleteAccount(false);
      await onSessionRefresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to request deletion.");
    } finally {
      setDeletingAccount(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Account & Security"
        title="User Settings"
        description="Manage profile, regional timezone preference, password, active sessions, customer staff, and account lifecycle."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="py-5">
          <CardContent>
            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">
                  Profile & Regional Timezone
                </h2>
                <Badge variant="primary-light">
                  <RiTimeLine className="size-3" aria-hidden="true" />
                  Effective: {effectiveTimezone}
                </Badge>
              </div>
              <fieldset className="space-y-2"><legend className="text-xs font-medium text-muted-foreground">Profile avatar</legend>
                <p className="text-xs text-muted-foreground">Choose a Homecore avatar or use your initials. No image upload needed.</p>
                <div className="flex flex-wrap gap-2">
                  {[null, ...AVATAR_SEEDS].map((seed) => <button key={seed ?? "initials"} type="button" aria-label={seed ? `Choose avatar ${seed.split("-")[1]}` : "Use initials"} aria-pressed={avatarSeed === seed} onClick={() => setAvatarSeed(seed)} className="flex size-11 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-xs font-bold ring-offset-background transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-offset-2"><UserAvatar seed={seed} name={fullName} email={session.user.email} /></button>)}
                </div>
              </fieldset>
              <FormField id="set-fullname" label="Full Name">
                <Input
                  id="set-fullname"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </FormField>
              {canManageStaff && isAccountActive && (
                <FormField id="set-accname" label="Account Name">
                  <Input
                    id="set-accname"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    required
                  />
                </FormField>
              )}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Regional Timezone
                  </span>
                  <button
                    type="button"
                    onClick={() => setTimezonePref(getBrowserTimezoneFallback())}
                    className="text-[11px] font-medium text-primary hover:underline cursor-pointer"
                  >
                    Use browser timezone
                  </button>
                </div>
                <TimezoneSelect
                  id="set-tz"
                  ariaLabel="Regional Timezone"
                  value={timezonePref}
                  onValueChange={setTimezonePref}
                  inheritLabel={`Inherit Platform Default (${platformDefault})`}
                />
                <p className="text-xs text-muted-foreground">
                  Follows platform default unless overridden per user.
                </p>
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm">
                  Save Changes
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="py-5">
          <CardContent>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <h2 className="text-sm font-semibold text-foreground">
                Change Password
              </h2>
              <FormField id="set-curpw" label="Current Password">
                <Input
                  id="set-curpw"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </FormField>
              <FormField id="set-newpw" label="New Password (8+ chars)">
                <Input
                  id="set-newpw"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </FormField>
              <div className="flex justify-end">
                <Button type="submit" variant="outline" size="sm">
                  Update Password & Revoke Other Sessions
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Customer Staff Management */}
      {canManageStaff && isAccountActive && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b">
            <CardTitle className="flex items-center gap-2 text-sm">
              <RiShieldUserLine className="size-5 text-primary" aria-hidden="true" />
              Account Staff & Invitations
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={inviteRole}
                onValueChange={(v) => setInviteRole(v as typeof inviteRole)}
              >
                <SelectTrigger aria-label="Invitation role" size="sm" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {isOwner && <SelectItem value="administrator">Administrator</SelectItem>}
                  <SelectItem value="operator">Operator</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" onClick={() => void handleCreateInvite()}>
                <RiAddLine className="size-4" aria-hidden="true" />
                Create Invite Link
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            {generatedInviteLink && (
              <StatusAlert tone="info" title="Shareable Invitation (48h expiry)">
                <span className="font-mono break-all">{generatedInviteLink}</span>
              </StatusAlert>
            )}

            {staffList.length === 0 ? (
              <EmptyStatePanel
                compact
                icon={<RiShieldUserLine />}
                tone="neutral"
                title="No staff members invited yet"
                description="Generate a 48-hour invite link above to onboard household operators or viewers."
              />
            ) : (
            <div className="rounded-lg border overflow-hidden">
              <Table className="text-xs">
                <TableHeader className="bg-muted/60">
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {staffList.map((st) => (
                    <TableRow key={st.id}>
                      <TableCell>
                        <p className="font-semibold text-foreground">
                          {st.fullName}
                        </p>
                        <p className="text-[11px] text-muted-foreground">{st.email}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="primary-light">{st.role}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={st.status === "active" ? "success-light" : "warning-light"}>
                          {st.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {st.role !== "owner" && (
                          <div className="flex gap-1.5">
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() =>
                                void handleStaffAction(
                                  st.id,
                                  st.status === "active" ? "suspend" : "reactivate"
                                )
                              }
                            >
                              {st.status === "active" ? "Suspend" : "Reactivate"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => void handleStaffAction(st.id, "remove")}
                            >
                              <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
                              Remove
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Notification Preferences */}
      {notifPrefs && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between border-b">
            <CardTitle className="text-sm">Notification Preferences</CardTitle>
            {savingNotifPrefs && (
              <span className="text-[11px] text-muted-foreground">Saving...</span>
            )}
          </CardHeader>
          <CardContent className="divide-y pt-2">
            {USER_PREFERENCE_DEFS.map((pref) => (
              <div
                key={pref.key}
                className="flex items-center justify-between gap-4 py-3 first:pt-2 last:pb-2"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">{pref.label}</p>
                  <p className="text-[11px] text-muted-foreground">{pref.description}</p>
                </div>
                <Switch
                  aria-label={pref.label}
                  checked={Boolean(notifPrefs[pref.key])}
                  onCheckedChange={(checked) => void handleToggleNotifPref(pref.key, checked)}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Active Sessions */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Active Sessions</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {sessionsList.length === 0 ? (
            <EmptyStatePanel
              compact
              icon={<RiHistoryLine />}
              tone="neutral"
              title="No active sessions found"
              description="Active browser sessions for this account appear here."
            />
          ) : (
          <div className="rounded-lg border overflow-hidden">
            <Table className="text-xs">
              <TableHeader className="bg-muted/60">
                <TableRow>
                  <TableHead>Client / Device</TableHead>
                  <TableHead>IP Address</TableHead>
                  <TableHead>Last Seen</TableHead>
                  <TableHead>Revoke</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessionsList.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="max-w-xs truncate">{s.user_agent || "Browser Session"}</span>
                        {s.isCurrent && <Badge variant="success-light">Current</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono">{s.ip_address || "—"}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatTimestamp(s.last_seen_at, effectiveTimezone)}
                    </TableCell>
                    <TableCell>
                      {!s.isCurrent && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => void handleRevokeSession(s.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          )}
        </CardContent>
      </Card>

      {/* Owner Lifecycle Controls */}
      {isOwner && isAccountActive && (
        <StatusAlert
          tone="danger"
          title="Account Lifecycle Controls"
          action={
            <div className="flex gap-2">
              <Button variant="outline" size="xs" onClick={() => void handlePauseAccount()}>
                Pause Account
              </Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={() => setConfirmDeleteAccount(true)}
              >
                Request Account Deletion
              </Button>
            </div>
          }
        >
          Pausing suspends operational access without deleting data. Requesting deletion revokes controller MQTT access immediately.
        </StatusAlert>
      )}

      <ConfirmDeleteDialog
        open={confirmDeleteAccount}
        onOpenChange={setConfirmDeleteAccount}
        title="Request account deletion?"
        description="This immediately marks your customer account pending deletion and revokes all controller MQTT credentials."
        confirmLabel="Request Deletion"
        busy={deletingAccount}
        onConfirm={handleRequestDeletion}
      />
    </div>
  );
}
