import { createAvatar } from "@dicebear/core";
import { avataaars } from "@dicebear/collection";

export const AVATAR_SEEDS = Array.from({ length: 8 }, (_, i) => `homecore-${i + 1}`);

/** "Alice M. Owner" -> "AO"; falls back to email initials, then "HC". */
function buildInitials(name?: string | null, email?: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const fromName = words
    .map((part, i) => (i === 0 || i === words.length - 1 ? part[0] : ""))
    .join("")
    .toUpperCase();
  if (fromName) return fromName;
  const fromEmail = (email ?? "").trim().slice(0, 2).toUpperCase();
  return fromEmail || "HC";
}

export function UserAvatar({
  seed,
  name,
  email,
}: {
  seed?: string | null;
  name?: string | null;
  email?: string | null;
}) {
  if (!seed || !AVATAR_SEEDS.includes(seed)) {
    return <>{buildInitials(name, email)}</>;
  }
  let src: string;
  try {
    src = createAvatar(avataaars, { seed, backgroundColor: ["dbeafe"] }).toDataUri();
  } catch {
    // DiceBear can fail on an unexpected seed shape; initials beat a crash.
    return <>{buildInitials(name, email)}</>;
  }
  return (
    <img
      src={src}
      alt=""
      className="h-full w-full rounded-full object-cover hc-avatar-float motion-safe:transition-transform motion-safe:duration-500 motion-safe:hover:scale-110"
    />
  );
}
