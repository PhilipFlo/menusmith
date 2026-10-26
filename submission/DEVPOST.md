# Devpost submission draft

**Project name:** Menusmith
**Tagline:** Agents that write the scraper once — so the price index runs forever.
**Track:** Coding and Agentic Engineering

## Inspiration
We built nearBite, a dish-level restaurant search for Oslo and Palo Alto, on 78,682 dishes scraped
from restaurants' own websites. Keeping it fresh meant asking an LLM to re-read every menu every
month: costly, slow, and non-deterministic — reading the identical page three times gave the same
dish list on only 5 of 22 sites we measured (counts swing a median 5%, up to 18%), which shows up
as fake "menu changes" in a price time series.

## What it does
Menusmith is a team of NVIDIA Nemotron agents that turns a restaurant website into a permanent,
deterministic price feed. It reads the menu once, writes a small extractor program for that one
website, runs it in a sandbox, tests it against its own reading, and repairs it until it passes.
Re-runs are plain JavaScript — zero tokens, same output every time. A nightly fleet re-runs the
whole library; when a website redesign breaks an extractor, the agent notices and rewrites its own
code. It doesn't trust quiet changes either: before recording "2 dishes removed", Nemotron re-reads
the page — if those dishes are still there, the code was wrong, and it is rewritten.

## How we built it
- **Nebius Token Factory** serves every model call through one OpenAI-compatible API.
- **Nemotron 3 Nano** (thinking off): triages menu links and arbitrates disputed items.
- **Nemotron 3 Super** (thinking off, JSON mode, chunked): the oracle that reads the menu.
- **Nemotron 3 Super** (thinking on, multi-turn): writes and repairs the extractor code from test
  feedback, including an execution trace of every selector it used. When Super stops improving,
  **Nemotron 3 Ultra** takes over the same conversation.
- **Nemotron 3.5 Super VL** reads menus that are only published as images.
- **Headless Chromium** renders JavaScript-built menus and captures the menu API the page calls;
  extractors over that JSON replay the request directly on re-runs.
- **Isolated sandbox** for model-written code: separate process, empty environment, Node permission
  model, no string code generation, CPU/memory limits.
- **Tavily** `/search` finds a restaurant's official site from its name (ranked by brand, city and
  country) and `/map` finds menu pages the homepage doesn't link clearly.
- **Hosting is portable:** the public demo runs in Docker on a free host with a durable store, and
  the nightly fleet is a scheduled job (GitHub Actions). Deployment scripts for Nebius AI Cloud
  Serverless (Endpoint for the app, Job for the fleet) are included but not what the demo runs on.
- React + Hono app streaming every agent step live over Server-Sent Events.

## Challenges
- Half of real restaurant sites render their menu with JavaScript → API capture.
- The LLM reading and the code disagree on what a "dish" is (add-on options, promo banners) →
  Nemotron Nano arbitration that corrects both sides.
- "0 items" is useless feedback → the sandbox records every selector call and how many elements
  went in and out, so the model debugs like a developer in DevTools.
- A broken extractor is easy to spot; one that quietly drops 2 of 22 dishes looks exactly like a
  menu change. Removals are now only recorded after Nemotron re-reads the page and confirms they're
  gone — in our test the fleet caught a deliberately lossy extractor and rewrote it in 12 s for
  half a cent.

## Accomplishments
- **83 of 120 real restaurant websites** (Oslo + Palo Alto) get a working extractor starting from
  the homepage — 79 from the stored menu link alone.
- **59%** of written extractors pass on the **first attempt**; average F1 **0.976** against a fresh
  Nemotron reading of the page (self-consistency; against nearBite's independently scraped menus,
  which merge several pages per site: precision 0.74, recall 0.63 — half of the mismatches are the same
  dish written differently or re-priced since, see `bench/precision.ts`); **100% deterministic** on re-run (78/78 measured); re-runs take ~170 ms and **$0**.
- **10/10 perfect** (F1 1.0) against ground truth on our fictional fixture sites.
- **Self-healing measured, not just demoed:** we redesigned all 10 fixture websites (new markup plus
  real price and dish changes). The fleet detected and rewrote the extractor on **10/10**, and every
  healed extractor scores **F1 1.0 against the true new menu** — median repair **$0.005 and 10 s**.
- **Measured the premise:** reading the same page 3× with the LLM gave the same dish list on only
  5 of 22 real sites (median 5% count swing, one empty reading); the extractors: 22/22 identical.
- **Start from just a name:** Tavily search plus our ranking finds a restaurant's official website
  from name + city for **85%** of held-out restaurants.
- Covers the real web's variety: server HTML, captured menu APIs, JavaScript-rendered pages,
  **18 PDF menus** and **image menus** (Nemotron 3.5 Super VL), all re-checked for free.
- Running publicly on a **free** host (512 MB / 0.1 CPU) with a durable token-gated store, a
  daily model-spend cap and SSRF protection — total model spend for the whole project, including every benchmark run, under $10.

## What we learned
Putting the LLM in the *build* step instead of the *run* step changes the economics: the expensive
model runs once per website, and then only when something breaks.

## What's next
Scanned-PDF menus (render pages to images for the vision model); platform-level adapters shared across
every restaurant on the same ordering system; a public restaurant price index for Oslo.

## Built with
nvidia-nemotron, nebius-token-factory, tavily, docker, typescript, node.js, react, hono,
playwright, cheerio, vitest

## Pre-existing work
Menusmith's code was written during the submission period. It uses data from our earlier project
nearBite (restaurant URLs and previously scraped menus) as a benchmark reference only.

## Feedback on Nebius Token Factory / NVIDIA models

Specific notes from building Menusmith (more than 850 metered Token Factory calls across five NVIDIA models, about $8 in total):

**What worked really well**
- One OpenAI-compatible endpoint for Nano, Super, Ultra, Lightning and Super-VL made
  model routing a config change. Our Super → Ultra escalation and Nano arbitration were a
  few lines each.
- `chat_template_kwargs.enable_thinking` let us run the same model fast (thinking off) for
  extraction and smart (thinking on) for code writing.
- `nvidia/Nemotron-3.5-Super-VL` read real restaurant menu images (16–31 dishes per
  picture) for about $0.002 each — it turned a whole failure class into successes.

**Friction we hit (actionable)**
1. **402 "You have exhausted your budget" with funds available.** Our key stopped working
   after ~$1.60 of spend; the cause was a budget setting, not the balance. The error should
   say *which* limit was hit (account balance vs. project/key budget) and link to it.
2. **Reasoning field name.** Non-streaming responses put Nemotron's reasoning in
   `message.reasoning`, while the API reference documents `reasoning_content`. We had to
   inspect raw JSON to find it. Please align the docs (or return both).
3. **Thinking toggle is only documented on Hugging Face.** `enable_thinking` and the
   per-model sampling advice (temperature 1.0 / top_p 0.95 for Super/Ultra) belong on the
   Token Factory model pages.
4. **`response_format` docs contradict themselves.** The spec lists `json_schema` but a
   field note says only `json_object`/`text` are supported; the cookbook uses `guided_json`.
   A single tested example per model family would remove the guesswork.
5. **Inconsistent model IDs.** `nvidia/Nemotron-3_5-Lightning` vs `nvidia/Nemotron-3.5-Super-VL`,
   and mixed casing (`nemotron-3-super-…` vs `Nemotron-3-Ultra-…`) — easy to typo; a stable
   alias scheme would help.
6. **Default rate limits aren't published**, only an example table. We built conservative
   retries blind.
7. **No balance/usage endpoint in the API.** Apps that let the public trigger model calls
   (like our demo) need to enforce budgets; we keep our own spend meter on disk.
8. **Sandboxes are gated behind a beta form.** For the "agents that write, run, and test code"
   track it would be great to have hackathon access by default; we ship our own hardened
   Node sandbox meanwhile.
