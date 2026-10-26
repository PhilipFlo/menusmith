# Demo video — under 3:00

The screen clips are recorded automatically from the real app:
`submission/clips/{forge,api,heal,image,tour}.webm` (1440×900, no sound — recorded with
`scripts/record-clips.mts`). Add the voice-over (or captions) in any editor that takes WebM
(CapCut, Clipchamp, DaVinci Resolve; YouTube also accepts WebM directly), cut each clip to the
time below, and upload as a **public** YouTube video. No music unless it's royalty-free.

> Numbers come from `bench/results/` (latest.json, variance.json, heal.json)
> (`npx tsx bench/report.ts` prints them).

| Time | Clip | Voice-over |
|---|---|---|
| 0:00–0:12 | title card (text on black) — "Menusmith · agents that write the scraper once" | "Restaurant menus change all the time. Re-reading every menu with an LLM, every month, is slow, costly — and gives a slightly different answer each time." |
| 0:12–1:05 | `forge.webm` (Golden Mountain, Oslo) | "Menusmith flips that. Nemotron 3 Super reads the menu once — twice, actually, to catch what a single read skims past. Then it writes a small extractor program for this one website. The code runs in an isolated sandbox and is scored against the reading. Round one fails — and instead of '0 items', the agent gets a debugger: every selector it used and what it matched. It fixes its own code, and passes. Committed. From now on, every re-scrape is plain JavaScript: zero tokens, same answer every time." |
| 1:05–1:25 | `api.webm` (Hidden Leaf, Winorder) | "Many restaurants use ordering systems that build the menu with JavaScript. Menusmith renders the page, catches the menu API the page calls, and writes its extractor over that JSON — the next restaurant on the same system just reuses it, for free." |
| 1:25–1:40 | `image.webm` (Listen to Delhi) | "Some menus are pictures. Nemotron 3.5 Super VL reads them; Menusmith fingerprints the images, so it only reads them again when they change. PDF menus work the same way." |
| 1:40–2:15 | `heal.webm` | "Every night, the fleet re-runs the whole library. Now this restaurant redesigns its website… the extractor returns nothing. The fleet notices, Nemotron confirms the menu didn't really disappear, and the agent rewrites its own code — and reports the two real price changes and the new dish. Here's the diff it wrote." |
| 2:15–2:45 | `tour.webm` + results overlay | "We tested it on 120 real restaurant websites in Oslo and Palo Alto: 68% get a working extractor, 59% of written extractors pass on the first try, and re-runs are 100% deterministic and cost nothing — while reading the same page three times with an LLM gave the same answer on only 5 of 22 sites. We also redesigned ten websites: the fleet healed all ten, for half a cent each. Nano triages and arbitrates, Super reads and writes, Ultra takes over the hard repairs — all on Nebius Token Factory." |
| 2:45–3:00 | end card — repo URL, "MIT licensed", demo URL | "Menusmith. Write the scraper once." |

## Re-recording the clips

```bash
# 1. a local server with its own library copy (no writes to the public demo's store)
PORT=8796 MENUSMITH_LIBRARY=.cache/video-library MENUSMITH_STORE_URL= MENUSMITH_STORE_KEY= \
  MENUSMITH_STORE_TOKEN= MENUSMITH_FORGES_PER_HOUR=100 npx tsx src/server/index.ts
# 2. record (all clips, or some of: forge api heal image tour)
npx tsx scripts/record-clips.mts
```
