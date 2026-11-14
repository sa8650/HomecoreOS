import { createAvatar } from "@dicebear/core";
import { avataaars } from "@dicebear/collection";


export const AVATAR_SEEDS = Array.from({ length: 8 }, (_, i) => `homecore-${i + 1}`);

export function UserAvatar({ seed, name, email }: { seed?: string | null; name: string; email: string }) {
  if (!seed || !AVATAR_SEEDS.includes(seed)) return <>{name.trim().split(/\s+/).filter(Boolean).map((part, i, parts) => i === 0 || i === parts.length - 1 ? part[0] : "").join("").toUpperCase() || email.slice(0, 2).toUpperCase() || "HC"}</>;
  const src = createAvatar(avataaars, { seed, backgroundColor: ["dbeafe"] }).toDataUri();
  return <img src={src} alt="" className="h-full w-full rounded-full object-cover hc-avatar-float motion-safe:transition-transform motion-safe:duration-500 motion-safe:hover:scale-110" />;
}
