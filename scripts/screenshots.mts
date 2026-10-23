// Capture README screenshots from a running server (default http://localhost:8796).
//   npx tsx scripts/screenshots.mts
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.SHOTS_BASE || 'http://localhost:8796';
const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
const page = await ctx.newPage();

async function shot(name: string, path: string, prep?: () => Promise<void>) {
  await page.goto(`${BASE}${path}`);
  await page.waitForTimeout(1500);
  if (prep) await prep();
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`✓ ${name}`);
}

await shot('library', '/#/library');
await shot('extractor-diff', '/#/library/fjord-burger-fixture', async () => {
  const diff = page.getByRole('button', { name: /^Diff$/ });
  if (await diff.count()) await diff.click();
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, 520);
  await page.waitForTimeout(600);
});
await shot('fleet', '/#/fleet', async () => {
  const past = page.locator('section[aria-label="Fleet report"]');
  if (await past.count()) await past.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
});
await shot('image-menu', '/#/library/listentodelhi-no');
await shot('how-it-works', '/#/about');
await browser.close();
