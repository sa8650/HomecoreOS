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

/**
 * Section-by-section scroll reveals, as required by the design system.
 *
 * A page fills in after its data arrives, so the elements that should fade in
 * often do not exist yet when the page is first shown. A MutationObserver
 * watches for them being added and reveals each one as it appears, which is
 * what stops a card from staying invisible for good.
 */
export function observeReveals(root: ParentNode = document) {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('.reveal:not(.is-visible)'));
  const reveal = (n: HTMLElement) => n.classList.add('is-visible');

  if (!('IntersectionObserver' in window) || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    nodes.forEach(reveal);
    return () => {};
  }

  // The page scrolls inside .content, not the window, so the observer has to
  // watch that element. With the viewport as the root, anything below the
  // fold never becomes visible.
  const scroller = (root as Element)?.querySelector?.('.content')
    || document.querySelector('.content');

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    }
  }, { root: (scroller as Element) || null, rootMargin: '0px 0px -40px 0px', threshold: 0.05 });
  nodes.forEach((n) => io.observe(n));

  // Elements added later — after a fetch resolves — are revealed as well.
  const mo = new MutationObserver((records) => {
    const added: HTMLElement[] = [];
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.classList.contains('reveal')) added.push(node);
        node.querySelectorAll?.('.reveal:not(.is-visible)').forEach((n) => added.push(n as HTMLElement));
      }
    }
    for (const n of added) {
      if (n.classList.contains('is-visible')) continue;
      // Already on screen: reveal it at once rather than waiting for a scroll.
      const box = n.getBoundingClientRect();
      const frame = (scroller as Element)?.getBoundingClientRect?.()
        || { top: 0, bottom: window.innerHeight };
      if (box.top < frame.bottom && box.bottom > frame.top) { reveal(n); continue; }
      io.observe(n);
    }
  });
  mo.observe(root as Node, { childList: true, subtree: true });

  return () => { io.disconnect(); mo.disconnect(); };
}
