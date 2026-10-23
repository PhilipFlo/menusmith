// Record demo-video clips of the real app with Playwright (WebM, 1440×900).
// Start the server first (see the command in submission/VIDEO-SCRIPT.md), then:
//   npx tsx scripts/record-clips.mts [clip …]     clips: forge api heal image tour
import { mkdirSync, renameSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const BASE = process.env.CLIPS_BASE || 'http://localhost:8796';
const OUT = 'submission/clips';
const W = 1440;
const H = 900;
mkdirSync(OUT, { recursive: true });

const pause = (p: Page, ms: number) => p.waitForTimeout(ms);

async function slowScroll(p: Page, px: number, steps = 12) {
  for (let i = 0; i < steps; i++) {
    await p.mouse.wheel(0, px / steps);
    await pause(p, 120);
  }
}

async function forge(p: Page, target: string, maxMs = 6 * 60_000) {
  await p.goto(`${BASE}/#/forge`);
  await pause(p, 1500);
  const input = p.getByLabel('Restaurant website or name');
  await input.click();
  await input.pressSequentially(target, { delay: 35 });
  await pause(p, 600);
  await p.getByRole('button', { name: /^Forge$/ }).click();
  await pause(p, 2500);
  await slowScroll(p, 520);
  await p.locator('section[aria-label="Result"]').waitFor({ timeout: maxMs });
  await pause(p, 1200);
  await p.locator('section[aria-label="Result"]').scrollIntoViewIfNeeded();
  await pause(p, 3500);
}

const clips: Record<string, (p: Page) => Promise<void>> = {
  // A real Oslo restaurant: reading, code, a failed round with the debugger, repair, pass.
  async forge(p) {
    await forge(p, process.env.CLIP_FORGE_URL || 'http://www.goldenmountain.no/meny');
    const rounds = p.getByRole('tab');
    const n = await rounds.count();
    for (let i = 0; i < n; i++) {
      await rounds.nth(i).click();
      await pause(p, 2200);
    }
    const dbg = p.getByText('Debugger — what each selector matched on the real page');
    if (await dbg.count()) {
      await rounds.first().click();
      await dbg.first().click();
      await pause(p, 3000);
    }
    await slowScroll(p, 900);
    await pause(p, 2500);
  },
  // An ordering system: the menu comes from an API the page calls.
  async api(p) {
    await forge(p, 'https://hiddenleafrestaurant.winorder.no/');
    await slowScroll(p, 700);
    await pause(p, 2500);
  },
  // Self-healing: the restaurant redesigns its site, the fleet notices and rewrites the code.
  async heal(p) {
    await p.goto(`${BASE}/#/fleet`);
    await pause(p, 2000);
    const toggle = p.getByRole('switch', { name: 'Fjord Burger: redesigned website' });
    await toggle.scrollIntoViewIfNeeded();
    await pause(p, 800);
    // The real checkbox is visually hidden behind the styled switch — click its label.
    if (!(await toggle.isChecked())) await toggle.locator('xpath=ancestor::label[1]').click();
    await pause(p, 1500);
    await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await pause(p, 1200);
    await p.getByRole('button', { name: /Run fleet now/ }).click();
    await p.locator('section[aria-label="Fleet report"]').waitFor({ timeout: 8 * 60_000 });
    await pause(p, 1500);
    await p.locator('section[aria-label="Fleet report"]').scrollIntoViewIfNeeded();
    await pause(p, 2500);
    const changes = p.getByText(/changes ▾/).first();
    if (await changes.count()) {
      await changes.click();
      await pause(p, 3500);
    }
    await p.goto(`${BASE}/#/library/fjord-burger-fixture`);
    await pause(p, 2500);
    const diff = p.getByRole('button', { name: /^Diff$/ });
    if (await diff.count()) {
      await diff.click();
      await pause(p, 3500);
    }
    await slowScroll(p, 600);
    await pause(p, 2500);
    // Put the demo site back.
    await p.goto(`${BASE}/#/fleet`);
    const t2 = p.getByRole('switch', { name: 'Fjord Burger: redesigned website' });
    if (await t2.isChecked()) await t2.locator('xpath=ancestor::label[1]').click();
  },
  // A menu published as pictures: Nemotron 3.5 Super VL reads it.
  async image(p) {
    await forge(p, 'https://listentodelhi.no/');
    await slowScroll(p, 900);
    await pause(p, 2500);
  },
  // Library and how it works.
  async tour(p) {
    await p.goto(`${BASE}/#/library`);
    await pause(p, 3000);
    await slowScroll(p, 900, 16);
    await pause(p, 1500);
    await p.goto(`${BASE}/#/about`);
    await pause(p, 2500);
    await slowScroll(p, 1800, 30);
    await pause(p, 2500);
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(clips);
const browser = await chromium.launch();
for (const name of wanted) {
  const run = clips[name];
  if (!run) {
    console.log(`unknown clip ${name}`);
    continue;
  }
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await run(page);
    console.log(`✓ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) {
    console.log(`✗ ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
  const video = page.video();
  await ctx.close();
  if (video) renameSync(await video.path(), `${OUT}/${name}.webm`);
}
await browser.close();
