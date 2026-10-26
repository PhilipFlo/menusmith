# Demo video — under 3:00

The screen clips are recorded automatically from the real app (1440×900, no sound, with
`scripts/record-clips.mts`):

- **`submission/clips-v2/`** (Oct 26) — matches the current app, adds `tilda.webm` and
  `recheck.webm`. Use these unless you already started editing.
- `submission/clips/` (Oct 23) — the first set; the two rows marked *new* have no clip there, so
  skip them and give the time to `forge` and `heal`.

Add the voice-over (or captions) in any editor that takes WebM (CapCut, Clipchamp, DaVinci
Resolve; YouTube also accepts WebM directly), cut each clip to the time below, and upload as a
**public** YouTube video. No music unless it's royalty-free.

> Numbers come from `bench/results/` (latest, variance, heal, coverage, false-alarms)
> (`npx tsx bench/report.ts` prints the benchmark table).

| Time | Clip | Voice-over |
|---|---|---|
| 0:00–0:10 | title card (text on black) — "Menusmith · agents that write the scraper once" | "Restaurant menus change all the time. Re-reading every menu with an LLM is slow, costly — and gives a different answer each time." |
| 0:10–0:55 | `forge.webm` (Golden Mountain, Oslo) | "Menusmith flips that. Nemotron 3 Super reads the menu once, then writes a small extractor program for this one website. The code runs in an isolated sandbox and is scored against the reading. When a round fails, the agent gets a debugger — every selector it used and what it matched — fixes its own code, and passes. From now on every re-scrape is plain JavaScript: zero tokens, same answer every time." |
| 0:55–1:10 | `api.webm` (Hidden Leaf, Winorder) | "Ordering systems build the menu with JavaScript. Menusmith catches the menu API the page calls and writes its extractor over that JSON." |
| 1:10–1:22 | `image.webm` (Listen to Delhi) | "Some menus are pictures — Nemotron 3.5 Super VL reads them, and they're only read again when the images change." |
| 1:22–1:35 | `tilda.webm` (Mia Oceanfront) — *new* | "Some site builders put every dish name in one block and every price in another. Menusmith rebuilds the reading order first — this one passes on the first try." |
| 1:35–2:05 | `heal.webm` | "Every night the fleet re-runs the whole library. This restaurant redesigns its website… the extractor returns nothing. The fleet notices, confirms the menu didn't really disappear, and the agent rewrites its own code — reporting the real price changes and the new dish. Here's the diff it wrote." |
| 2:05–2:25 | `recheck.webm` — *new* | "The sneaky case: code that quietly drops two dishes looks like a menu change. A free re-scrape won't record it. One click asks Nemotron to read the page again — the dishes are still there, so the code is wrong, and it's rewritten. In our tests that's caught ten out of ten times, with zero false alarms on healthy sites." |
| 2:25–2:50 | `tour.webm` + results overlay | "On 120 real restaurant websites in Oslo and Palo Alto, 69% get a working extractor, and re-runs are 100% deterministic and free — while reading the same page three times with an LLM gave the same answer on only 5 of 22 sites. Ten redesigned websites: all ten healed, for half a cent each. Nano, Super, Ultra and Super VL — all on Nebius Token Factory." |
| 2:50–3:00 | end card — repo URL, "MIT licensed", demo URL | "Menusmith. Write the scraper once." |

## Re-recording the clips

```bash
# 1. a local server with its own library copy (no writes to the public demo's store)
#    (for `recheck`, make kebab-kongen-fixture's extractor drop its last 2 dishes in that copy)
PORT=8796 MENUSMITH_LIBRARY=.cache/video-library-v2 MENUSMITH_STORE_URL= MENUSMITH_STORE_KEY= \
  MENUSMITH_STORE_TOKEN= MENUSMITH_FORGES_PER_HOUR=100 npx tsx src/server/index.ts
# 2. record (all clips, or some of: forge api heal image tilda recheck tour)
CLIPS_OUT=submission/clips-v2 npx tsx scripts/record-clips.mts
```
