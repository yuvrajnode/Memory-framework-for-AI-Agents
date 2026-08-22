import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const problems = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', e => problems.push('PAGEERROR ' + e.message));
for (const view of ['console','memories','graph','insights','maintenance']) {
  await page.goto(`http://localhost:4173/#/${view}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (o > 2) problems.push(`mobile/${view}: horizontal overflow ${o}px`);
}
await page.goto('http://localhost:4173/#/console', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.screenshot({ path: '/tmp/mobile.png', fullPage: false });
console.log(problems.length ? problems.join('\n') : 'mobile: 5 views clean, no horizontal overflow');
await browser.close();
