/**
 * Visits every console page in a real browser and reports what it finds:
 * console errors, failed network requests, the page's own text content and
 * whether the main area actually rendered anything.
 *
 *   node scripts/dev/audit_console.mjs [base-url] [email] [password]
 *
 * Screenshots are written to /tmp/hc-shots so the layout can be inspected.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:5180';
const EMAIL = process.argv[3] || 'owner@example.com';
const PASSWORD = process.argv[4] || 'correct-horse-battery';
const SHOTS = '/tmp/hc-shots';
mkdirSync(SHOTS, { recursive: true });

const OWNER_PAGES = [
  ['/owner', 'Owner Overview'],
  ['/owner/setup', 'Setup Status'],
  ['/owner/customers', 'Customers'],
  ['/owner/staff', 'Staff & access'],
  ['/owner/firmware', 'Firmware management'],
  ['/owner/boards', 'Board library'],
  ['/owner/emqx', 'EMQX management'],
  ['/owner/usage', 'Usage & monitoring'],
  ['/owner/settings', 'Platform settings'],
  ['/owner/settings/integrations', 'Integrations'],
  ['/owner/security', 'Authentication & security'],
  ['/owner/audit', 'Audit logs'],
];

const CUSTOMER_PAGES = [
  ['/', 'Customer Overview'],
  ['/rooms', 'Rooms & areas'],
  ['/devices', 'Devices'],
  ['/switches', 'Switches'],
  ['/sensors', 'Sensors'],
  ['/controllers', 'Controllers'],
  ['/boards', 'Board library'],
  ['/setup', 'Add a controller'],
  ['/automation', 'Automation'],
  ['/firmware', 'Firmware & updates'],
  ['/activity', 'Activity'],
  ['/staff', 'Staff'],
  ['/settings', 'Settings'],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
const failedRequests = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)));
page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url().slice(0, 120)} — ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`);
});

const failures = [];

async function visit(paths, label) {
  console.log(`\n══ ${label} ══`);
  for (const [path, name] of paths) {
    consoleErrors.length = 0;
    failedRequests.length = 0;
    // Navigate inside the console rather than reloading the document, so the
    // audit sees what a person sees and the live connection is not torn down.
    const before = await page.content();
    await page.evaluate((p) => {
      const link = document.querySelector(`a[href="${p}"]`);
      if (link) { link.click(); return; }
      history.pushState({}, '', p);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, path).catch(() => {});
    await page.waitForTimeout(1400);
    const content = await page.content();
    const after = content === before;

    // What is actually on screen?
    const main = await page.$('#main-content');
    const mainText = main ? (await main.innerText().catch(() => '')) : '';
    const text = mainText.replace(/\s+/g, ' ').trim();
    const cards = await page.$$eval('#main-content .card, #main-content .stat', (els) => els.length).catch(() => 0);
    // Content that is on the page but painted invisible.
    const hidden = await page.$$eval('#main-content .reveal', (els) => els.filter((e) => {
      const b = e.getBoundingClientRect();
      if (b.bottom <= 0 || b.top >= window.innerHeight) return false;
      return getComputedStyle(e).opacity === '0';
    }).length).catch(() => 0);
    const loading = await page.$('.skeleton, .loading, [aria-busy="true"]');
    const isEmpty = text.length < 40 && cards === 0;

    const slug = path.replace(/\//g, '_') || '_root';
    await page.screenshot({ path: `${SHOTS}/${label}-${slug}.png`, fullPage: true }).catch(() => {});

    const issues = [];
    if (isEmpty) issues.push('EMPTY');
    if (loading) issues.push('STILL-LOADING');
    if (hidden) issues.push(`invisible:${hidden}`);
    if (consoleErrors.length) issues.push(`console:${consoleErrors.length}`);
    if (failedRequests.length) issues.push(`http:${failedRequests.length}`);

    if (issues.length) failures.push(`${label} ${path}: ${issues.join(' ')}`);
    console.log(`  ${issues.length ? '✗' : '✓'} ${path.padEnd(28)} ${name.padEnd(26)} ` +
      `cards=${String(cards).padEnd(3)} text=${String(text.length).padEnd(5)} ` +
      `${issues.join(' ')}`);
    if (consoleErrors.length) consoleErrors.slice(0, 4).forEach((e) => console.log(`        ! ${e}`));
    if (failedRequests.length) failedRequests.slice(0, 4).forEach((e) => console.log(`        ! ${e}`));
    if (isEmpty) console.log(`        content: "${text.slice(0, 120)}"`);
  }
}

// Sign in.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"], .btn-primary.btn-block');
await page.waitForTimeout(2500);
console.log(`signed in as ${EMAIL}; url = ${page.url()}`);

await visit(OWNER_PAGES, 'owner');
await visit(CUSTOMER_PAGES, 'customer');

// Dark mode.
console.log('\n══ dark mode ══');
await page.evaluate(() => {
  localStorage.setItem('homecoreos_theme', 'dark');
  document.documentElement.dataset.theme = 'dark';
});
for (const [path, name] of [['/owner', 'Owner Overview'], ['/', 'Customer Overview']]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(600);
  const colours = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color };
    };
    return {
      sidebar: pick('.sidebar'),
      navItem: pick('.nav-item'),
      navActive: pick('.nav-item.active'),
      brandName: pick('.brand-name'),
      navGroup: pick('.nav-group-label'),
      body: getComputedStyle(document.body).backgroundColor,
    };
  });
  console.log(`  ${path}:`);
  for (const [k, v] of Object.entries(colours)) {
    console.log(`    ${k.padEnd(12)} ${v ? `${v.bg || ''} ${v.color || ''}` : ''}`);
  }

  // The sidebar must not be painted in a mid grey, and its text must stay
  // clearly readable against it.
  const contrast = await page.evaluate(() => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const side = document.querySelector('.sidebar');
    const bg = getComputedStyle(side).backgroundColor;
    const out = { bg, items: [] };
    for (const el of side.querySelectorAll('.nav-item, .nav-group-label, .brand-name')) {
      const cs = getComputedStyle(el);
      out.items.push({
        text: (el.textContent || '').trim().slice(0, 24),
        color: cs.color,
        ratio: Math.round(ratio(cs.color, bg) * 100) / 100,
      });
    }
    return out;
  });

  // A mid grey on the sidebar is what made the navigation unreadable.
  const grey = /rgb\((\d+), (\d+), (\d+)\)/.exec(contrast.bg);
  const greyValue = grey ? Number(grey[1]) : -1;
  if (greyValue >= 90 && greyValue <= 210) {
    failures.push(`dark mode: the sidebar is painted grey (${contrast.bg})`);
    console.log(`    ✗ the sidebar is painted grey (${contrast.bg})`);
  }
  for (const item of contrast.items) {
    if (item.ratio < 4.5) {
      failures.push(`dark mode: "${item.text}" has a contrast of ${item.ratio}`);
      console.log(`    ✗ "${item.text}" contrast ${item.ratio} — too low`);
    }
  }
  await page.screenshot({ path: `${SHOTS}/dark${path.replace(/\//g, '_')}.png`, fullPage: true }).catch(() => {});
}

await browser.close();

if (failures.length) {
  console.log(`\n${failures.length} page(s) with problems:`);
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('\nAll pages rendered, with no console errors and no failed requests.');
process.exit(0);
