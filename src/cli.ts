import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, ROOT } from './config.ts';
import { setFixtureRedesigned } from './html/fetch.ts';
import { listExtractors } from './library/store.ts';
import { forge } from './agent/pipeline.ts';
import { runFleet } from './fleet/fleet.ts';
import { closeBrowser } from './html/render.ts';
import { flush, hydrate, storeEnabled } from './library/persist.ts';
import type { AgentEvent } from './types.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const flagValue = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

const c = { dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m' };

function printer(verbose: boolean) {
  return (e: AgentEvent) => {
    switch (e.type) {
      case 'step': {
        const col = e.status === 'done' ? c.green : e.status === 'fail' ? c.red : e.status === 'skip' ? c.yellow : c.cyan;
        console.log(`${col}${e.status.padEnd(5)}${c.reset} ${c.bold}${e.step}${c.reset} ${e.detail ?? ''}`);
        break;
      }
      case 'llm':
        console.log(`${c.dim}      ${e.role} · ${e.model} · ${e.promptTokens}+${e.completionTokens} tok · $${e.costUsd.toFixed(5)} · ${(e.ms / 1000).toFixed(1)}s${c.reset}`);
        break;
      case 'test':
        console.log(`${c.dim}      round ${e.round}: ${e.run.ok ? `${e.run.count} items, f1=${e.score.f1} p=${e.score.precision} r=${e.score.recall}` : 'error: ' + e.run.error}${c.reset}`);
        break;
      case 'code':
        if (verbose) console.log(`${c.dim}${e.code}${c.reset}`);
        break;
      case 'log':
        if (verbose || !e.message.startsWith('Reasoning')) console.log(`${c.dim}      ${e.message}${c.reset}`);
        break;
      case 'error':
        console.log(`${c.red}error ${e.message}${c.reset}`);
        break;
    }
  };
}

async function main() {
  // Ephemeral runners (GitHub Actions, serverless jobs): restore the library first.
  if (storeEnabled()) {
    const h = await hydrate();
    console.log(`store: restored ${h.restored} file(s)${h.seeded ? `, seeded ${h.seeded}` : ''}`);
  }
  // A Serverless Job may start on an empty shared volume — seed it from the image.
  const shipped = resolve(ROOT, 'library');
  if (config.libraryDir !== shipped && existsSync(shipped) && !existsSync(resolve(config.libraryDir, 'extractors')))
    cpSync(shipped, config.libraryDir, { recursive: true });
  const verbose = flags.has('--verbose') || flags.has('-v');
  if (cmd === 'forge') {
    const target = args[0];
    if (!target) throw new Error('usage: npm run forge -- <url | "Restaurant name"> [--city Oslo] [--no-reuse] [--verbose]');
    const isUrl = /^(https?|fixture):\/\//i.test(target);
    const out = await forge(
      { url: isUrl ? target : undefined, restaurant: isUrl ? flagValue('--name') : target, city: flagValue('--city'), noReuse: flags.has('--no-reuse') },
      printer(verbose),
    );
    console.log(
      `\n${out.ok ? c.green + 'OK' : c.red + 'FAILED'}${c.reset} ${out.ok ? `${out.meta!.id} v${out.meta!.version} (${out.mode}) — ${out.items!.length} items` : out.reason}` +
        `\n${c.dim}${out.rounds} round(s) · ${out.ledger.calls} LLM call(s) · ${out.ledger.promptTokens + out.ledger.completionTokens} tokens · $${out.ledger.costUsd.toFixed(4)} · ${(out.ms / 1000).toFixed(1)}s${c.reset}`,
    );
    process.exitCode = out.ok ? 0 : 1;
  } else if (cmd === 'fleet') {
    const maxUsd = flagValue('--max-usd');
    const r = await runFleet(
      { heal: !flags.has('--no-heal'), only: args.filter((a) => a !== maxUsd).length ? args.filter((a) => a !== maxUsd) : undefined, maxUsd: maxUsd ? Number(maxUsd) : undefined },
      printer(verbose),
    );
    const t = r.totals;
    console.log(`\nFleet: ${t.extractors} extractors · ${t.stable} stable · ${t.changed} changed · ${t.healed} healed · ${t.broken} broken · ${t.error} errors · ${t.tokens} tokens · $${t.costUsd.toFixed(4)} · ${(t.ms / 1000).toFixed(1)}s`);
  } else if (cmd === 'redesign') {
    const [slug, state] = args;
    if (!slug) throw new Error('usage: npm run redesign -- <fixture-slug> [on|off]');
    console.log('redesigned fixtures:', setFixtureRedesigned(slug, state !== 'off'));
  } else if (cmd === 'demo') {
    // The full loop on our fictional demo sites, served from recorded model responses
    // (cassettes/) — no API key, no network, same agent code path.
    if (config.llmMode !== 'replay') console.log(`${c.dim}(tip: MENUSMITH_LLM=replay runs this offline from recordings)${c.reset}`);
    const sites = args.length ? args : ['fjord-burger', 'trattoria-sole', 'sushi-koi'];
    for (const slug of sites) {
      console.log(`\n${c.bold}▶ ${slug}${c.reset}`);
      const out = await forge({ url: `fixture://${slug}/`, noReuse: true }, printer(verbose));
      console.log(out.ok ? `${c.green}✓ ${out.items!.length} dishes · ${out.rounds} round(s)${c.reset}` : `${c.red}✗ ${out.reason}${c.reset}`);
    }
    console.log(`\n${c.bold}▶ self-heal: fjord-burger redesigns its website${c.reset}`);
    setFixtureRedesigned('fjord-burger', true);
    try {
      const r = await runFleet({ heal: true, only: ['fjord-burger-fixture'] }, printer(verbose));
      const e = r.entries[0];
      console.log(e ? `${e.status === 'healed' ? c.green : c.yellow}${e.status}: ${e.detail}${c.reset}` : 'no fleet entry');
    } finally {
      setFixtureRedesigned('fjord-burger', false);
    }
  } else if (cmd === 'list') {
    for (const x of listExtractors())
      console.log(`${x.meta.id.padEnd(32)} v${x.meta.version}  ${x.meta.platform.padEnd(11)} f1=${x.meta.score.f1}  ${x.meta.baselineCount} items  $${x.meta.costUsd.toFixed(4)}`);
  } else {
    console.log('commands: forge <url|name> | fleet [ids…] | redesign <slug> [on|off] | list | demo [slugs…]');
  }
}

main()
  .catch((e) => {
    console.error(`${c.red}${(e as Error).message}${c.reset}`);
    process.exitCode = 1;
  })
  // The headless browser keeps the event loop alive — close it so the command exits.
  // Uploads to the durable store must finish before the process exits.
  .finally(async () => {
    await closeBrowser();
    await flush();
  });
