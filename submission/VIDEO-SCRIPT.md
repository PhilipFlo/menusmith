# Demo video script — under 3:00

Record the screen at 1440×900 with the browser zoomed to 110%. Speak calmly; captions help.
No copyrighted music. Pre-record every live part once as a backup.

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Title card: "Menusmith — agents that write the scraper once" | "We track 78,682 dishes across a thousand restaurants in Oslo and Palo Alto. Keeping prices fresh by asking an LLM to re-read every menu every month is slow, costly — and gives a slightly different answer each time." |
| 0:15–0:25 | Split: the same menu read twice by an LLM, item counts differ | "Same page, two readings, different results. In a price time series, that noise looks like real menu changes." |
| 0:25–1:15 | **Live Forge** on a real Oslo restaurant (Damaskus Huset or Pizzabakeren) | "Menusmith flips it. Nemotron 3 Super reads the menu once. Nemotron 3 Ultra — with reasoning on — writes a small extractor program for this one website. It runs in an isolated sandbox and is scored against the reading: precision, recall, F1. Here round one fails…" *(show the debugger trace)* "…the agent sees exactly which selector matched nothing, fixes its own code, and passes. Committed. That cost under two cents — and every re-scrape after this costs zero tokens." |
| 1:15–1:35 | **Hidden API**: forge Afghan House or Saigon Express — the "Found the menu API" step | "Half of real restaurant sites build their menu with JavaScript. Menusmith renders the page, catches the menu API the page calls, and writes its extractor over clean JSON. Re-runs replay the request — no browser." |
| 1:35–2:10 | **Self-healing**: Fleet → toggle "redesign" on Fjord Burger → Run fleet | "Every night a Nebius Serverless Job re-runs the whole library. Healthy extractors cost nothing. Now the restaurant redesigns its website… the extractor returns zero items. The fleet notices, Nemotron confirms the menu didn't really disappear, and the agent rewrites its own code — and reports the two real price changes and the new dish." |
| 2:10–2:35 | **Results**: About page benchmark table + Library KPIs | *(read the 3 headline numbers from bench/results)* "Ten fictional sites with known truth, N real restaurants, deterministic on every re-run." |
| 2:35–2:55 | Architecture slide: model routing (Nano → Super → Ultra), Token Factory, Serverless Endpoint + Job, Tavily | "Nano triages and arbitrates, Super reads, Ultra writes code — all on Nebius Token Factory. Tavily finds the website. The app runs on a Nebius Serverless Endpoint." |
| 2:55–3:00 | Repo URL + "MIT licensed" | "Menusmith. Write the scraper once." |

## Shot list to prepare
- [ ] Reset the demo library (`npx tsx src/cli.ts redesign fjord-burger off`, fresh forge of fixtures with Ultra)
- [ ] Warm the cache for the real sites used on camera (so pages load instantly)
- [ ] Have a backup recording of each live run
