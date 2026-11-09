/**
 * Measures how long each console page takes to become usable: the time until
 * its data has arrived and the number of requests it makes.
 *
 *   node scripts/dev/measure_performance.mjs [base-url] [email] [password]
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:5180';
const EMAIL = process.argv[3] || 'owner@example.com';
const PASSWORD = process.argv[4] || 'correct-horse-battery';

const OWNER_PAGES = [
  '/owner', '/owner/setup', '/owner/customers', '/owner/staff', '/owner/firmware',
  '/owner/boards', '/owner/emqx', '/owner/usage', '/owner/settings',
  '/owner/settings/integrations', '/owner/security', '/owner/audit',
];
const CUSTOMER_PAGES = [
  '/', '/rooms', '/devices', '/switches', '/sensors', '/controllers',
  '/boards', '/setup', '/automation', '/firmware', '/activity', '/staff', '/settings',
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

let requests = 0;
let streamRequests = 0;
let counting = false;
page.on('request', (r) => {
  if (!counting) return;
  requests++;
  if (r.url().includes('/api/stream')) streamRequests++;
});

async function signIn() {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('form button.btn-primary');
  await page.waitForTimeout(2500);
}

/** Moves to a page the way a person would: by clicking its link. */
async function goTo(path) {
  const link = page.locator(`a[href="${path}"]`).first();
  if (await link.count()) {
    await link.click();
  } else {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  }
}

async function measure(path) {
  requests = 0; streamRequests = 0;
  const started = Date.now();
  counting = true;
  await goTo(path);
  const ready = await page.waitForFunction(() => {
    const main = document.querySelector('#main-content');
    if (!main) return false;
    const text = (main.innerText || '').trim();
    const waiting = main.querySelector('.skeleton, .loading, [aria-busy="true"]');
    return text.length > 40 && !waiting;
  }, null, { timeout: 20000 }).then(() => Date.now() - started).catch(() => -1);
  counting = false;
  return { path, requests, streamRequests, ready };
}

console.log('page                    requests  stream  data-ready');
console.log('─'.repeat(56));

await signIn();
const customerRows = [];
for (const path of CUSTOMER_PAGES) {
  const row = await measure(path);
  customerRows.push(row);
  console.log(`${path.padEnd(24)} ${String(row.requests).padStart(7)}  ${String(row.streamRequests).padStart(5)}  ${String(row.ready).padStart(10)} ms`);
}

// Switch to the owner console.
await page.click('.sidebar-foot .nav-item').catch(() => {});
await page.waitForTimeout(1800);
const ownerRows = [];
for (const path of OWNER_PAGES) {
  const row = await measure(path);
  ownerRows.push(row);
  console.log(`${path.padEnd(24)} ${String(row.requests).padStart(7)}  ${String(row.streamRequests).padStart(5)}  ${String(row.ready).padStart(10)} ms`);
}

const rows = [...customerRows, ...ownerRows];
const times = rows.map((r) => r.ready).filter((t) => t > 0);
const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
const worst = rows.filter((r) => r.ready > 0).sort((a, b) => b.ready - a.ready).slice(0, 4);
console.log('\naverage data-ready :', avg, 'ms');
console.log('slowest            :', worst.map((w) => `${w.path} (${w.ready} ms)`).join(', '));
console.log('total requests     :', rows.reduce((a, r) => a + r.requests, 0));
console.log('live connections   :', rows.reduce((a, r) => a + r.streamRequests, 0));

await browser.close();
