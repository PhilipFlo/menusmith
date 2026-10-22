# Menusmith

**Agents that write the scraper once — so the price index runs forever.**

Menusmith turns any restaurant website into a live, deterministic price feed. A team of
**NVIDIA Nemotron** agents on **Nebius Token Factory** reads a restaurant's menu, **writes a small
extractor program for that one website, runs it in a sandbox, tests it against its own reading,
and repairs it until it passes**. After that, every re-scrape is plain JavaScript: **zero tokens,
same answer every time**. When a website redesign breaks an extractor, the fleet notices and the
agent heals its own code.

> Nebius × NVIDIA Global AI Hackathon 2026 · Track: **Coding and Agentic Engineering**
> Demo video: _(link)_ · Live demo: _(link)_

---

## Why

We run [nearBite](https://github.com/PhilipFlo), a dish-level restaurant search for Oslo and
Palo Alto: **1,036 restaurants and 78,682 dishes** scraped from restaurants' own websites, with
**20,045 menu changes** tracked since June 2026. Keeping that fresh the usual way — asking an LLM
to re-read every menu, every month — has three problems:

1. **Cost and speed.** Every re-scrape pays for a full LLM reading of every page.
2. **Noise.** LLM extraction is not deterministic: on the same page our item counts wobble
   ±2–5% from run to run. In a price *time series*, that noise looks like menu changes.
3. **Half the web is JavaScript.** Ordering systems and site builders ship an empty HTML shell
   and load the menu from an API.

Menusmith moves the LLM to where it's worth it — **writing and repairing code** — and out of the
hot path.

## How it works

```mermaid
flowchart LR
  A[URL or name] -->|Tavily search + map| B[Find menu page]
  B --> C{Menu in HTML?}
  C -- yes --> D[HTML]
  C -- no --> E[Headless browser<br/>capture menu API JSON]
  D --> F[Oracle<br/>Nemotron 3 Super reads the menu]
  E --> F
  F --> G{Library extractor<br/>for this platform passes?}
  G -- yes --> K[Adopt — 0 tokens]
  G -- no --> H[Forge<br/>Nemotron 3 Super writes extract()<br/>escalates to Ultra if stuck]
  H --> I[Sandbox run + score<br/>precision · recall · F1]
  I -- disputed items --> J[Arbitrate<br/>Nemotron 3 Nano]
  J --> I
  I -- fail --> H
  I -- pass, deterministic --> K[Commit to library]
  K --> L[Fleet re-runs nightly<br/>Nebius Serverless Job, 0 tokens]
  L -- drift detected --> F
```

1. **Find** — given a name, Tavily search finds the official site (aggregators filtered out);
   Tavily map + Nemotron Nano triage find the menu page among the site's links.
2. **Acquire** — if the menu isn't in the server HTML, a headless browser renders the page and
   **captures the JSON the page loads from its menu API**. The extractor is then written over that
   JSON and re-runs replay the request directly — no browser, no HTML fragility.
3. **Oracle** — Nemotron 3 Super reads the visible page (or the API data) and writes down the menu.
   Items whose names don't occur on the page are dropped (hallucination guard).
4. **Forge** — Nemotron 3 Super, with reasoning on, writes `extract($, ctx)` (cheerio) or
   `extract(data, ctx)` (JSON) against a compact skeleton of the page: the menu region is located
   by price density and long runs of identical items are collapsed.
5. **Test** — the code runs in an isolated sandbox and is scored against the oracle. Code that
   hard-codes dish names is rejected. Duplicates always count as errors.
6. **Arbitrate** — when the code and the reading disagree on specific items (add-on options,
   promo banners, a dish the reading skimmed past), **Nemotron 3 Nano rules on each one** and both
   sides are corrected. The extractor is only penalised for real mistakes.
7. **Repair + escalation** — failures go back as concrete feedback (missing dishes, wrong
   prices, duplicates, runtime errors with line numbers, a selector-by-selector execution
   trace, or the exact JSON paths that hold dishes). If two rounds don't fix it, **Nemotron 3
   Ultra takes over the same conversation**. Repairs stop early if they stop improving.
8. **Commit** — only after a second run proves the output is deterministic.
9. **Fleet** — re-runs every extractor at zero token cost. Unchanged → stable. Plausible change →
   recorded as price changes. Broken (0 items, collapsed count, lost prices) → the oracle checks
   whether the menu really shrank; if not, the agent rewrites the extractor from its old code plus
   the new page: **self-healing**.
10. **Reuse** — before writing new code, extractors from sites on the same platform (Squarespace,
    WordPress, or hosted ordering systems like Winorder/Ordera) are tried first — zero tokens.

## Results

_(Filled in from `bench/results/` — see [Benchmark](#benchmark).)_

| | |
|---|---|
| Fixture sites (ground truth known) | TODO |
| Real restaurant sites (Oslo + Palo Alto) | TODO |
| Median cost to write an extractor | TODO |
| Cost of a re-run | **$0.00** (no model call) |
| Determinism of committed extractors | TODO |

## How we use NVIDIA Nemotron on Nebius Token Factory

Every model call goes through Token Factory's OpenAI-compatible API
(`https://api.tokenfactory.nebius.com/v1/`). Models are routed by job — the cheapest model
that does each job well:

| Role | Model | Why | Settings |
|---|---|---|---|
| Triage (menu links), arbitration | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | many small yes/no calls, $0.06/M in | thinking off, JSON mode |
| Oracle (read the menu) | `nvidia/nemotron-3-super-120b-a12b` | long structured extraction, 262K context | thinking off, JSON mode, chunked |
| Forge + repair (write code) | `nvidia/nemotron-3-super-120b-a12b` | solves most sites in 1–2 rounds at a third of Ultra's price | thinking **on**, multi-turn with test feedback |
| Escalation (hard repairs) | `nvidia/Nemotron-3-Ultra-550b-a55b` | strongest reasoning, only when Super is stuck | thinking **on**, continues the same conversation |
| Vision (image/PDF menus, roadmap) | `nvidia/Nemotron-3.5-Super-VL` | — | — |

- Reasoning is toggled per call with `chat_template_kwargs.enable_thinking`; the model's reasoning
  (`message.reasoning`) is streamed into the UI's "Agent thinking" panel.
- Each role has a fallback chain (e.g. Ultra → Super) for rate limits or outages.
- Every call is metered (tokens, $) into a per-job ledger shown live in the UI.
- `MENUSMITH_LLM=record` saves every response; `replay` re-serves them — tests and the offline
  demo run with **no API key**.

**Where Token Factory accelerated us:** one OpenAI-compatible endpoint for four Nemotron sizes
meant model routing was a config change, not an integration; JSON mode and the thinking toggle
made the cheap calls cheap and the code-writing calls smart.

### Other Nebius services and Tavily

- **Nebius AI Cloud Serverless Endpoint** — hosts the web app + API (`deploy/nebius.sh endpoint`).
- **Nebius AI Cloud Serverless Job** — the nightly fleet run (`deploy/nebius.sh fleet-job`):
  re-runs the library, heals broken extractors, writes the fleet report.
- **Tavily** — `/search` finds a restaurant's official website from its name; `/map` discovers
  the menu pages of a site.

## The sandbox

Model-written code never runs in the server process. Each run is a fresh Node process with:

- an **empty environment** — no API keys exist to steal;
- Node's **permission model** — no file writes, no child processes, no workers, reads limited to
  the harness and `node_modules`;
- `--disallow-code-generation-from-strings` — `eval`/`Function` (and the classic
  `this.constructor.constructor` escape) fail;
- a `vm` context exposing only `$`/`data`, `ctx`, `parsePrice`, `cleanText`; 4 s CPU timeout,
  256 MB heap, 12 s wall-clock kill.

These properties are covered by tests (`tests/sandbox.test.ts`).

## Quickstart

```bash
git clone https://github.com/PhilipFlo/menusmith && cd menusmith
npm install
npx playwright install chromium   # for JavaScript-built menus
cp .env.example .env              # add NEBIUS_API_KEY and TAVILY_API_KEY
npm run build && npm start        # web app on http://localhost:8790
```

Command line:

```bash
npm run forge -- fixture://fjord-burger/          # one of our 10 fictional demo sites
npm run forge -- https://example-restaurant.no/   # any real site
npm run forge -- "Restaurant Name" --city Oslo    # find the site with Tavily first
npm run fleet                                     # re-run everything, heal what broke
npx tsx src/cli.ts redesign fjord-burger on       # simulate a website redesign…
npm run fleet                                     # …and watch it heal
npm test                                          # 140+ tests, no API key needed
npm run demo                                      # full loop + self-heal, replayed — no API key
```

## Benchmark

- `bench/fixtures.ts` — 10 fictional restaurant sites in `fixtures/sites/` (WordPress/Elementor,
  Squarespace, Wix, Webflow, Shopify, tables, JSON-LD, …) each with a **redesigned** version and
  the true menu. Scores extractors against the truth.
- `bench/run.ts` — real restaurant websites. Our evaluation set comes from nearBite (private
  data; only per-site metrics are published in `bench/results/`).

## Repository layout

```
src/agent/     acquire · discover · oracle · forge · evaluate · judge (arbitration) · pipeline
src/sandbox/   isolated runner + harness for model-written code
src/html/      fetch · headless render + API capture · page simplifier · JSON views · platform detection
src/fleet/     drift detection, price-change diffing, self-healing
src/library/   versioned extractor store
src/server/    Hono API with Server-Sent Events
web/           React app: Live Forge · Library · Fleet · How it works
fixtures/      fictional restaurant sites with ground truth and redesigns
bench/         benchmarks
deploy/        Nebius Serverless deployment
```

## What was built during the hackathon

Everything in this repository was written during the submission period (Aug 26 – Oct 30, 2026).
It builds on our pre-existing nearBite project only through **data**: the benchmark set of real
restaurant URLs and their previously scraped menus, used as an independent reference. nearBite's
own scraper is not part of Menusmith.

## Limitations

- Image-only and PDF menus are out of scope for the code-writing path (a vision path with
  Nemotron 3.5 Super VL is on the roadmap).
- Some hosted APIs mix dishes with add-on options; arbitration settles most disputes, but very
  large option-heavy menus can still fail to converge.
- Sites behind aggressive bot protection are not bypassed — by design.

## License

MIT — see [LICENSE](LICENSE).
