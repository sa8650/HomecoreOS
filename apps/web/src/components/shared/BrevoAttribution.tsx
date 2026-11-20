import { cn } from "@/lib/utils";

/**
 * "Email delivered by Brevo" attribution shown at the bottom of the sign-in
 * card.
 *
 * Transactional mail (password-recovery codes today) leaves the Worker through
 * Brevo, so the login screen credits it where the customer actually sees it.
 * The wordmark ships in `public/brand/` and sits on a light chip in both themes:
 * Brevo's green has too little contrast on the dark background to be legible
 * otherwise, and the logo must never be recoloured.
 */
export function BrevoAttribution({ className }: { className?: string }) {
  return (
    <a
      href="https://www.brevo.com/"
      target="_blank"
      rel="noreferrer noopener"
      data-testid="brevo-attribution"
      aria-label="Email delivery powered by Brevo"
      className={cn(
        "group inline-flex items-center gap-2 rounded-full border border-border/70 bg-white/95 px-2.5 py-1 text-[10px] font-medium text-slate-600 shadow-sm transition-colors hover:border-primary/40 hover:text-slate-900",
        className
      )}
    >
      <span className="whitespace-nowrap">Email delivered by</span>
      <img
        src="/brand/brevo-wordmark.png"
        alt="Brevo"
        width={48}
        height={20}
        loading="lazy"
        decoding="async"
        className="h-[13px] w-auto shrink-0"
      />
    </a>
  );
}
