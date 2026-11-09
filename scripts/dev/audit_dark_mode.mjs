/**
 * Checks the sidebar in dark mode, both expanded and collapsed, in both
 * consoles: the background must not be a mid grey and every piece of text
 * must stay readable against it.
 *
 *   node scripts/dev/audit_dark_mode.mjs [base-url] [email] [password]
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:5180';
const EMAIL = process.argv[3] || 'owner@example.com';
const PASSWORD = process.argv[4] || 'correct-horse-battery';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const failures = [];

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('form button.btn-primary');
await page.waitForTimeout(2500);

// The owner console.
await page.click('.sidebar-foot .nav-item').catch(() => {});
await page.waitForTimeout(1800);

await page.evaluate(() => {
  localStorage.setItem('homecoreos_theme', 'dark');
  document.documentElement.dataset.theme = 'dark';
});
await page.waitForTimeout(600);

const LUMINANCE = `
  const lum = (rgb) => {
    const parts = rgb.match(/[\\d.]+/g);
    if (!parts || parts.length < 3) return 0;
    const [r, g, b] = parts.slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
`;

async function inspect(label) {
  const result = await page.evaluate(`(() => {
    ${LUMINANCE}
    const side = document.querySelector('.sidebar');
    const cs = getComputedStyle(side);
    const bg = cs.backgroundColor;
    const items = [];
    for (const el of side.querySelectorAll('.nav-item, .nav-group-label, .brand-name, .brand-sub')) {
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      items.push({
        text: (el.textContent || '').trim().slice(0, 26),
        color: s.color,
        ratio: Math.round(ratio(s.color, bg) * 100) / 100,
      });
    }
    return { bg, width: Math.round(side.getBoundingClientRect().width), items };
  })()`);

  const grey = /rgb\((\d+)/.exec(result.bg);
  const greyValue = grey ? Number(grey[1]) : -1;
  const greySidebar = greyValue >= 90 && greyValue <= 210;

  console.log(`\n  ${label}`);
  console.log(`    sidebar background : ${result.bg}  (width ${result.width}px)`);
  if (greySidebar) {
    failures.push(`${label}: the sidebar is painted grey (${result.bg})`);
    console.log('    ✗ the sidebar is painted in a mid grey');
  } else {
    console.log('    ✓ not a mid grey');
  }
  let worst = 99;
  for (const item of result.items) {
    worst = Math.min(worst, item.ratio);
    if (item.ratio < 4.5) {
      failures.push(`${label}: "${item.text}" contrast ${item.ratio}`);
      console.log(`    ✗ "${item.text}" — contrast ${item.ratio}`);
    }
  }
  if (result.items.length) console.log(`    lowest contrast     : ${worst} across ${result.items.length} labels`);
  else console.log('    (no visible labels)');
  return result;
}

console.log('Dark mode — Owner console');
await inspect('expanded');
await page.screenshot({ path: '/tmp/hc-shots/dark-owner-expanded.png' });

// Collapse the sidebar.
await page.click('.sidebar-brand .nav-collapse');
await page.waitForTimeout(900);
await inspect('collapsed');
await page.screenshot({ path: '/tmp/hc-shots/dark-owner-collapsed.png' });

// Expand it again.
await page.click('.sidebar-brand .nav-collapse').catch(() => {});
await page.waitForTimeout(700);

// The customer console.
await page.evaluate(() => { const l = document.querySelector('.sidebar-foot .nav-item'); if (l) l.click(); });
await page.waitForTimeout(1800);
console.log('\nDark mode — Customer console');
await inspect('expanded');
await page.screenshot({ path: '/tmp/hc-shots/dark-customer-expanded.png' });

await page.click('.sidebar-brand .nav-collapse');
await page.waitForTimeout(900);
await inspect('collapsed');
await page.screenshot({ path: '/tmp/hc-shots/dark-customer-collapsed.png' });

await browser.close();

if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('\nThe sidebar is dark and every label is readable, expanded and collapsed.');
