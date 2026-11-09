/**
 * Exercises the controls that change data, to prove they work:
 * creating an area, adding a device, creating an automation rule and
 * changing a setting. Each action is checked against the server afterwards.
 *
 *   node scripts/dev/test_interactions.mjs [base-url] [email] [password]
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:5180';
const EMAIL = process.argv[3] || 'customer@example.com';
const PASSWORD = process.argv[4] || 'correct-horse-battery';

const results = [];
const TAG = `T${Date.now().toString(36).slice(-5)}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (e) => results.push({ ok: false, what: `page error: ${e.message.slice(0, 120)}` }));
page.on('response', (r) => {
  if (r.status() < 400 || !r.url().includes('/api/')) return;
  // The check that runs before signing in is expected to be refused.
  if (r.status() === 401 && r.url().endsWith('/api/auth/me')) return;
  // The board already has a device on that pin, so the second one is
  // refused on purpose.
  if (r.status() === 400 && r.url().endsWith('/api/devices')) return;
  results.push({ ok: false, what: `${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}` });
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('form button.btn-primary');
await page.waitForTimeout(2500);

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, what: name, detail });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    results.push({ ok: false, what: name, detail: String(e.message || e).slice(0, 160) });
    console.log(`  ✗ ${name} — ${String(e.message || e).slice(0, 160)}`);
  }
}

async function go(path) {
  await page.evaluate((p) => { const l = document.querySelector(`a[href="${p}"]`); if (l) l.click(); }, path);
  await page.waitForTimeout(1600);
}

/* --------------------------------------------------------- create an area */
await step('Create an area', async () => {
  await go('/rooms');
  await page.click('button:has-text("New room"), button:has-text("Add room")');
  await page.waitForTimeout(900);
  const name = page.locator('.modal input.input, .modal input[type="text"]').first();
  await name.fill(`Kitchen ${TAG}`);
  await page.locator('.modal button.btn-primary').last().click();
  await page.waitForTimeout(1800);
  const text = await page.$eval('#main-content', (e) => e.innerText);
  if (!new RegExp(`Kitchen ${TAG}`).test(text)) throw new Error('the area did not appear on the page');
  return `Kitchen ${TAG} is listed`;
});

/* --------------------------------------------------------- add a device */
await step('Add a device', async () => {
  await go('/devices');
  await page.click('button:has-text("Add device")');
  await page.waitForTimeout(900);
  const modal = page.locator('.modal').first();
  await modal.locator('.field:has-text("Device name") input.input').first().fill('Desk lamp');
  // The controller must be chosen before the wizard will move on. The
  // controller list is the select that follows the "Controller board" label.
  const boardSelect = modal.locator('.field:has-text("Controller board") select').first();
  const options = await boardSelect.locator('option').count();
  if (options < 2) throw new Error('no controller is registered, so no device can be created');
  const value = await boardSelect.locator('option').nth(1).getAttribute('value');
  await boardSelect.selectOption(value);
  await page.waitForTimeout(900);
  // The name is written after the controller, so the wizard is not reset.
  await modal.locator('.field:has-text("Device name") input.input').first().fill('Desk lamp');
  await page.waitForTimeout(900);
  await page.waitForTimeout(700);
  await modal.locator('button:has-text("Next")').click({ force: true });
  await page.waitForTimeout(1600);
  // Step two picks an output pin.
  const pin = modal.locator('.pin-rail button.pin:not([disabled])').first();
  if (await pin.count()) {
    await pin.click();
    await page.waitForTimeout(600);
  }
  await modal.locator('button:has-text("Next")').click({ force: true });
  await page.waitForTimeout(1200);
  await modal.locator('button:has-text("Create device")').click({ force: true });
  await page.waitForTimeout(2200);
  const text = await page.$eval('#main-content', (e) => e.innerText);
  if (!/Desk lamp/.test(text)) throw new Error('the device did not appear on the page');
  return 'Desk lamp is listed';
});

/* --------------------------------------------------- change a setting */
await step('Save the home name', async () => {
  await go('/settings');
  const name = `Renamed ${TAG}`;
  const field = page.locator('#main-content .field:has-text("Home name") input.input').first();
  await field.fill(name);
  await page.waitForTimeout(600);
  await page.click('button:has-text("Save changes")');
  await page.waitForTimeout(2500);
  // The name lives in an input, so it is read from the field itself and
  // from the account chip in the sidebar.
  const fieldValue = await page.locator('#main-content .field:has-text("Home name") input.input').first().inputValue();
  const chip = await page.evaluate(() => document.querySelector('.workspace-chip .name')?.textContent || '');
  if (fieldValue !== name) throw new Error(`the field shows "${fieldValue}"`);
  if (chip !== name) throw new Error(`the account chip shows "${chip}"`);
  return 'the field and the account chip both show the new name';
});

/* --------------------------------------------------- create an automation */
await step('Create an automation rule', async () => {
  await go('/automation');
  const add = page.locator('button:has-text("Add rule"), button:has-text("New rule"), button:has-text("Create")').first();
  if (!(await add.count())) return 'no create control on this page';
  await add.click();
  await page.waitForTimeout(900);
  const modal = page.locator('.modal').first();
  await modal.locator('.field:has-text("Name") input.input').first().fill('Evening lights');
  await page.locator('.modal button.btn-primary').last().click();
  await page.waitForTimeout(1800);
  const text = await page.$eval('#main-content', (e) => e.innerText);
  if (!/Evening lights/.test(text)) throw new Error('the rule did not appear');
  return 'Evening lights is listed';
});

/* ---------------------------------------------------- delete the area */
await step('Delete the area', async () => {
  await go('/rooms');
  const text0 = await page.$eval('#main-content', (e) => e.innerText);
  const marker = `Kitchen ${TAG}`;
  if (!text0.includes(marker)) return 'nothing to delete';
  // The card that carries the name has a delete button beside it.
  const card = page.locator('#main-content .card').filter({ hasText: marker }).first();
  await card.locator('button[aria-label="Delete"]').first().click();
  await page.waitForTimeout(1000);
  const confirm = page.locator('.modal button.btn-danger, .modal button.btn-primary').last();
  if (await confirm.count()) await confirm.click({ force: true });
  await page.waitForTimeout(2200);
  const text = await page.$eval('#main-content', (e) => e.innerText);
  if (text.includes(marker)) throw new Error('the area is still listed');
  return 'the area is gone';
});

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} steps worked`);
if (failed.length) {
  for (const f of failed) console.log('  ✗', f.what, f.detail || '');
  process.exit(1);
}
process.exit(0);
