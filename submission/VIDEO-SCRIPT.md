# Demo video — under 3:00

**Order: the result first, then the process that proves it.** A judge decides in seconds whether
something is interesting; the result earns that, the agent loop (write → test → repair → heal) is
what makes Menusmith different from "an LLM that reads menus".

## How to record

Record the **live site** (https://menusmith.onrender.com) with any screen recorder — QuickTime
(File → New Screen Recording), Loom or OBS. Browser window about 1440×900, zoom 100–110 %, bookmarks
bar hidden. Record each segment as its own take; cut and speed up in the editor (CapCut,
Clipchamp, DaVinci Resolve or iMovie). Speed up waiting (2–4×) and say so on screen ("2× speed").
Voice-over or captions; no music unless royalty-free. Upload as a **public** YouTube video and put
the link in the README and on Devpost.

Before recording: open the site once (wakes it if it slept), press Cmd+Shift+R (newest version),
and leave the checkbox *"Answer from the library…"* **off**, so every run is real.

> Numbers come from `bench/results/` — judge-sim, variance, heal, coverage, false-alarms.

## The script

| Time | Screen — exactly what to click | Voice-over |
|---|---|---|
| **0:00–0:10** · Problem | Title card (text on plain background): *"Menusmith — agents that write the scraper once"* | "Restaurant menus change all the time. Re-reading every menu with an LLM costs money every time — and gives a different answer every time." |
| **0:10–0:40** · Result | **Live Forge** → click **Rose Pizzeria · San Francisco**. Let it run (speed up the waiting 3×). End on the green card: *"41 dishes · $0.0084 once · $0.0000 per re-run forever"*, scroll briefly through the dish table. | "Menusmith flips that. I give it a restaurant — here Rose Pizzeria in San Francisco. Forty seconds later it has the whole menu, forty-one dishes with prices. It cost under a cent — once. Every re-scrape after this costs nothing." |
| **0:40–1:20** · Process | Scroll up to **Pipeline** (point at Read → Forge → Test → Commit), then down to **Rounds** → show the **code** it wrote, then the **Precision / Recall / F1** bars and the *Wrong price / Missing* list. If the run had two rounds, click **Round 1** then **Round 2** to show the score rising. | "Here's how. Nemotron 3 Super reads the menu once — that reading is the reference. Then it writes a small extractor program for this one website. The code runs in an isolated sandbox and is scored against the reading: precision, recall, F1. If anything is missing or a price is wrong, the agent gets a debugger trace of every selector it used, fixes its own code and tries again — Ultra takes over if Super gets stuck. Only code that passes is saved." |
| **1:20–1:35** · Payoff | Click **Open in library →** → on the extractor page press **Re-scrape now**. The same dishes come back in a fraction of a second, *$0*. | "And this is the point: re-scraping is now plain JavaScript. Same dishes, a fraction of a second, zero tokens — tomorrow, next month, every night." |
| **1:35–2:05** · Self-healing | **Fleet** → in *"Demo: simulate a website redesign"* flip **Fjord Burger** to *Redesigned* → **Run fleet now** → wait for *healed* → open the extractor → **version diff**. (Or use `submission/clips-v2/heal.webm`.) | "Websites change. Every night the fleet re-runs the whole library. This restaurant just redesigned its site, and the old code breaks. The fleet notices, checks the menu didn't really disappear, and the agent rewrites its own code — here's the diff it wrote, with the real price changes it found." |
| **2:05–2:30** · Scale | **Discover** → click **pizza in San Francisco** → the list of six pizzerias appears → **Forge all** (speed up heavily) → scroll to the **Price index**, filtered to *pizza*, cheapest first. | "One search, a whole area. Tavily finds the pizzerias worth knowing in San Francisco, Nemotron names them, and Menusmith forges an extractor for each — then every pizza is compared side by side. That's a price index that refreshes itself for free." |
| **2:30–2:50** · Proof | **How it works** (measured results) — or a still with four numbers: *20 / 22 US restaurants got a menu · 22 / 22 identical re-runs (LLM alone: 5 / 22) · 10 / 10 redesigns healed · $0 per re-scrape* | "We measured it. Twenty-two US restaurants typed by name: twenty got their menu. Re-runs were identical twenty-two times out of twenty-two — reading with an LLM each time, only five. Ten redesigned websites, ten healed. Nemotron Nano, Super, Ultra and Super VL, all on Nebius Token Factory." |
| **2:50–3:00** · End | End card: demo URL, GitHub URL, *"MIT licensed"* | "Menusmith. Write the scraper once — run it forever." |

## If a take goes wrong

- **A run is slow or fails while recording:** just click it again — or use **Burma Superstar**
  (same full pipeline, about 40 s). Both were tested from scratch several times.
- **You want the repair moment on screen:** a run that needed two rounds shows it best. If
  Rose Pizzeria passes in one round, the self-healing segment tells the "it fixes its own code"
  story instead — no need to force it.
- **Don't record** the PDF or image examples for the main flow: they take about 3 minutes on the
  free server. A 5-second mention is enough ("PDF and image menus work too").

## Optional: re-recording the automatic clips

The older automatic clips (`submission/clips-v2/`, Oct 26) still match the Fleet page and can be
used for the self-healing segment. To re-record them:

```bash
# 1. a local server with its own library copy (no writes to the public demo's store)
PORT=8796 MENUSMITH_LIBRARY=.cache/video-library-v2 MENUSMITH_STORE_URL= MENUSMITH_STORE_KEY= \
  MENUSMITH_STORE_TOKEN= MENUSMITH_FORGES_PER_HOUR=100 npx tsx src/server/index.ts
# 2. record (all clips, or some of: forge api heal image tilda recheck tour)
CLIPS_OUT=submission/clips-v2 npx tsx scripts/record-clips.mts
```
