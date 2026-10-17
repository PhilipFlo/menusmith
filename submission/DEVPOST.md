# Devpost submission draft

**Project name:** Menusmith
**Tagline:** Agents that write the scraper once — so the price index runs forever.
**Track:** Coding and Agentic Engineering

## Inspiration
We built nearBite, a dish-level restaurant search for Oslo and Palo Alto, on 78,682 dishes scraped
from restaurants' own websites. Keeping it fresh meant asking an LLM to re-read every menu every
month: costly, slow, and non-deterministic — the same page read twice gave item counts that
differed by 2–5%, which shows up as fake "menu changes" in a price time series.

## What it does
Menusmith is a team of NVIDIA Nemotron agents that turns a restaurant website into a permanent,
deterministic price feed. It reads the menu once, writes a small extractor program for that one
website, runs it in a sandbox, tests it against its own reading, and repairs it until it passes.
Re-runs are plain JavaScript — zero tokens, same output every time. A nightly fleet re-runs the
whole library; when a website redesign breaks an extractor, the agent notices and rewrites its own
code.

## How we built it
- **Nebius Token Factory** serves every model call through one OpenAI-compatible API.
- **Nemotron 3 Nano** (thinking off): triages menu links and arbitrates disputed items.
- **Nemotron 3 Super** (thinking off, JSON mode, chunked): the oracle that reads the menu.
- **Nemotron 3 Ultra** (thinking on, multi-turn): writes and repairs the extractor code from test
  feedback, including an execution trace of every selector it used.
- **Headless Chromium** renders JavaScript-built menus and captures the menu API the page calls;
  extractors over that JSON replay the request directly on re-runs.
- **Isolated sandbox** for model-written code: separate process, empty environment, Node permission
  model, no string code generation, CPU/memory limits.
- **Tavily** finds a restaurant's official site from its name and maps its pages.
- **Nebius AI Cloud Serverless** — Endpoint for the app, Job for the nightly fleet.
- React + Hono app streaming every agent step live over Server-Sent Events.

## Challenges
- Half of real restaurant sites render their menu with JavaScript → API capture.
- The LLM reading and the code disagree on what a "dish" is (add-on options, promo banners) →
  Nemotron Nano arbitration that corrects both sides.
- "0 items" is useless feedback → the sandbox records every selector call and how many elements
  went in and out, so the model debugs like a developer in DevTools.

## Accomplishments
_(fill in from bench/results)_

## What we learned
Putting the LLM in the *build* step instead of the *run* step changes the economics: the expensive
model runs once per website, and then only when something breaks.

## What's next
Vision path for image/PDF menus with Nemotron 3.5 Super VL; platform-level adapters shared across
every restaurant on the same ordering system; a public restaurant price index for Oslo.

## Built with
nvidia-nemotron, nebius-token-factory, nebius-ai-cloud, tavily, typescript, node.js, react, hono,
playwright, cheerio, vitest

## Pre-existing work
Menusmith's code was written during the submission period. It uses data from our earlier project
nearBite (restaurant URLs and previously scraped menus) as a benchmark reference only.

## Feedback on Nebius Token Factory / NVIDIA models
_(fill in honestly — the Most Valuable Feedback prize rewards specific, actionable notes)_
- `message.reasoning` holds Nemotron's reasoning, but the API reference documents
  `reasoning_content` — worth aligning the docs.
- `chat_template_kwargs.enable_thinking` works well; documenting it on the Token Factory model pages
  (not only the Hugging Face cards) would save time.
- The default rate limits for new accounts aren't published.
- A balance/usage endpoint in the API would let apps enforce budgets.
