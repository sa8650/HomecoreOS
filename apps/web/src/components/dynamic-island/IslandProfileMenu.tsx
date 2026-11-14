import { UserAvatar } from "@/components/shared/UserAvatar";
import { RiCheckLine, RiLogoutBoxRLine, RiSettings3Line } from "@remixicon/react";
import { Badge } from "@/components/reui/badge";
import type { UserSessionData } from "@/features/types";

export function getUserInitials(name: string, email: string): string {
  const trimmed = name.trim();
  if (trimmed.length > 0) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase() || "HC";
}

export function IslandProfileTrigger({
  name,
  email,
  avatarSeed,
  open,
  onClick,
}: {
  name: string;
  email: string;
  avatarSeed?: string | null;
  open: boolean;
  onClick: () => void;
}) {

  return (
    <button
      type="button"
      data-island-control=""
      data-active={open ? "true" : undefined}
      data-testid="island-profile-trigger"
      className="island-avatar"
      aria-label="Account menu"
      aria-haspopup="menu"
      aria-expanded={open}
      title={`${name} (${email})`}
      onClick={onClick}
    >
      <UserAvatar seed={avatarSeed} name={name} email={email} />
    </button>
  );
}

export function IslandProfileMenuContent({
  userSession,
  onSwitchAccount,
  onOpenSettings,
  onSignOut,
}: {
  userSession: UserSessionData;
  onSwitchAccount: (accountId: string) => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {

  return (
    <div
      data-island-layer=""
      data-testid="island-profile-menu"
      role="menu"
      aria-label="Account options"
      className="island-menu"
    >
      <div className="island-menu-header">
        <span className="island-menu-avatar" aria-hidden="true">
          <UserAvatar seed={userSession.user.avatarSeed} name={userSession.user.fullName} email={userSession.user.email} />
        </span>
        <div className="island-menu-identity">
          <div className="flex items-center gap-1.5">
            <p className="island-menu-name">{userSession.user.fullName}</p>
            <Badge variant="primary-light" size="xs" radius="full" className="shrink-0 uppercase">
              {userSession.account.staffRole}
            </Badge>
          </div>
          <p className="island-menu-email">{userSession.user.email}</p>
          <p className="island-menu-email">{userSession.account.name}</p>
        </div>
      </div>

      {userSession.accounts.length > 1 && (
        <>
          <div className="island-menu-divider" />
          <div className="island-menu-section-label">Active Account</div>
          <div className="space-y-0.5" role="group" aria-label="Switch household account">
            {userSession.accounts.map((acc) => {
              const selected = acc.id === userSession.account.id;
              return (
                <button
                  key={acc.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-selected={selected ? "true" : undefined}
                  className="island-menu-item"
                  onClick={() => onSwitchAccount(acc.id)}
                >
                  <span className="min-w-0 truncate">
                    {acc.name}{" "}
                    <span className="opacity-70">({acc.staffRole})</span>
                  </span>
                  {selected && <RiCheckLine className="size-3.5 shrink-0" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="island-menu-divider" />

      <button
        type="button"
        role="menuitem"
        className="island-menu-item"
        onClick={onOpenSettings}
      >
        <span className="flex items-center gap-2">
          <RiSettings3Line className="size-3.5 opacity-80" aria-hidden="true" />
          Account settings
        </span>
      </button>

      <button
        type="button"
        role="menuitem"
        className="island-menu-item island-menu-item--danger"
        onClick={onSignOut}
      >
        <span className="flex items-center gap-2">
          <RiLogoutBoxRLine className="size-3.5" aria-hidden="true" />
          Sign out
        </span>
      </button>
    </div>
  );
}
