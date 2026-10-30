// Devpost image gallery (3:2, 2880×1920) from the live demo — runs real forges.
//   npx tsx scripts/gallery.mts [cover result discover heal library]
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const BASE = process.env.SHOTS_BASE || 'https://menusmith.onrender.com';
const OUT = 'submission/gallery';
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const want = (n: string) => !only.length || only.includes(n);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, colorScheme: 'light' });
const page = await ctx.newPage();
const save = async (p: Page, name: string) => {
  await p.mouse.move(2, 2); // no hover highlight
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`✓ ${name}`);
};
const scrollTo = async (p: Page, text: string, offset = 90) => {
  await p.evaluate(
    ([t, o]) => {
      const el = [...document.querySelectorAll('h1,h2,h3')].find((h) => h.textContent?.trim().startsWith(t as string));
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - (o as number) });
    },
    [text, offset],
  );
};

if (want('cover')) {
  await page.setContent(`<!doctype html><html><body style="margin:0;width:1440px;height:960px;background:#f6f1ea;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#2a231e">
  <div style="height:100%;box-sizing:border-box;padding:96px 104px;display:flex;flex-direction:column;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:18px">
      <svg width="64" height="64" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#d4521c"/><g fill="#fff8f0"><rect x="13.1" y="4" width="1.5" height="5" rx="0.75"/><rect x="15.25" y="4" width="1.5" height="5" rx="0.75"/><rect x="17.4" y="4" width="1.5" height="5" rx="0.75"/><path d="M13.1 8.3h5.8v.6a2.9 2.9 0 0 1-2.15 2.8V14h-1.5v-2.3a2.9 2.9 0 0 1-2.15-2.8z"/><path d="M4.5 14.5h20.5c.83 0 1.5.67 1.5 1.5v.5c0 .83-.67 1.5-1.5 1.5H22l-2 3h3.5c.55 0 1 .45 1 1V24H7.5v-2c0-.55.45-1 1-1H12l-2-3H9c-2.5 0-4.2-1.4-4.5-3.5z"/></g></svg>
      <span style="font-size:40px;font-weight:800;letter-spacing:-0.02em">Menusmith</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:28px">
      <div style="font-size:84px;line-height:1.02;font-weight:800;letter-spacing:-0.035em">Agents write the scraper once.<br><span style="color:#d4521c">Every re-scrape after that is free.</span></div>
      <div style="font-size:28px;line-height:1.4;color:#4d433b;max-width:1100px">NVIDIA Nemotron reads a restaurant's menu, writes a small program for that website, tests it against its own reading — and the fleet heals it when the site changes.</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px">
      ${[
        ['20 / 22', 'US restaurants, typed by name, got a menu'],
        ['22 / 22', 'identical re-runs — an LLM reading each time: 5 / 22'],
        ['$0', 'per re-scrape, forever — about 1¢ once per restaurant'],
      ]
        .map(([v, l]) => `<div style="background:#fffdf9;border:1px solid #e4d9ca;border-radius:18px;padding:26px 28px"><div style="font-size:52px;font-weight:800;letter-spacing:-0.02em">${v}</div><div style="font-size:21px;line-height:1.35;color:#4d433b;margin-top:6px">${l}</div></div>`)
        .join('')}
    </div>
    <div style="font-size:20px;color:#7a6d62">NVIDIA Nemotron on Nebius Token Factory · Tavily · menusmith.onrender.com</div>
  </div></body></html>`);
  await save(page, '1-cover');
}

if (want('result')) {
  await page.goto(`${BASE}/#/forge`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByRole('button', { name: /^Rose Pizzeria/ }).click();
  await page.locator('.result-title').waitFor({ timeout: 300_000 });
  await scrollTo(page, 'Pipeline', 150);
  await save(page, '2-result');
  const rounds = page.getByRole('heading', { name: 'Rounds' });
  if (await rounds.count()) {
    await scrollTo(page, 'Rounds', 40);
    await save(page, '3-agent-code-and-test');
  }
}

if (want('discover')) {
  await page.goto(`${BASE}/#/discover`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByRole('button', { name: 'pizza in San Francisco' }).click();
  await page.getByRole('button', { name: /^Forge all/ }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Forge all/ }).click();
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 1_500_000 });
  await scrollTo(page, 'Price index', 40);
  await save(page, '4-discover-price-index');
  await scrollTo(page, '6 restaurants', 40);
  await save(page, '5-discover-restaurants');
}

if (want('heal')) {
  await page.goto(`${BASE}/#/library/fjord-burger-fixture`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  const diff = page.getByRole('button', { name: /^Diff$/ });
  if (await diff.count()) await diff.click();
  await page.waitForTimeout(800);
  await scrollTo(page, 'Code', 110);
  await save(page, '6-self-healing-diff');
}

if (want('library')) {
  await page.goto(`${BASE}/#/library`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
  await save(page, '7-library');
}

await browser.close();
