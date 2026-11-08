/** Light / dark / system preference. Stored locally; never sent to the server. */
export type ThemePreference = 'system' | 'light' | 'dark';
const KEY = 'homecoreos_theme';

export function getTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* sandboxed preview */ }
  return 'system';
}

export function applyTheme(preference: ThemePreference) {
  const dark = preference === 'dark'
    || (preference === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#000000' : '#F1F4F6');
}

export function setTheme(preference: ThemePreference) {
  try { localStorage.setItem(KEY, preference); } catch { /* sandboxed preview */ }
  applyTheme(preference);
  window.dispatchEvent(new CustomEvent('homecoreos-theme', { detail: preference }));
}

/** Section-by-section scroll reveals, as required by the design system. */
export function observeReveals(root: ParentNode = document) {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('.reveal:not(.is-visible)'));
  if (!nodes.length) return () => {};
  if (!('IntersectionObserver' in window) || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    nodes.forEach((n) => n.classList.add('is-visible'));
    return () => {};
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    }
  }, { rootMargin: '0px 0px -40px 0px', threshold: 0.05 });
  nodes.forEach((n) => io.observe(n));
  return () => io.disconnect();
}
