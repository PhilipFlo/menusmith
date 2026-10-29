## Inspiration

Before this hackathon we built nearBite, a search engine for individual dishes in Oslo and Palo Alto — "where can I get a good bánh mì under $15 near me?". To make it work we scraped 78,682 dishes from restaurants' own websites.

Then the menus changed. Prices went up, dishes came and went, websites got redesigned. Keeping the data fresh meant asking an LLM to read every menu again, every month. That was slow and it cost money every single time — but the real surprise was worse: **we read the same page three times with an LLM and got the same list of dishes on only 5 of 22 websites.** Same page, same model, different answers. If you're trying to track prices over time, that noise shows up as fake price changes.

So we flipped the question. Instead of asking an AI to *read* the menu every day, what if the AI *wrote a program* that reads it — once — and that program ran forever for free?

## What it does

Menusmith is a team of NVIDIA Nemotron agents that turns any restaurant website into a permanent, reliable price feed.

You give it a restaurant — a link, or just a name and a city. Nemotron reads the menu once. Then it writes a small program (an "extractor") for that one website, runs it in a sandbox, and tests it against its own reading. If a dish is missing or a price is wrong, the agent sees exactly which part of its code failed, fixes it, and tries again — until the program matches. Only then is it saved.

From that moment, re-scraping the menu is plain code: **zero AI tokens, the same answer every time, in a fraction of a second.** Rose Pizzeria in San Francisco took 45 seconds and less than one cent to set up; every re-scrape after that costs $0.

And because websites change, Menusmith takes care of itself:

- **Every night a fleet re-runs every extractor.** When a restaurant redesigns its website and the code breaks, the agent notices and rewrites its own code.
- **It doesn't trust quiet changes.** Code that silently drops two dishes looks exactly like a restaurant removing two dishes. Before Menusmith records "2 dishes removed", Nemotron re-reads the page. If the dishes are still there, the code was wrong — and it gets fixed.
- **Discover** turns one search into a price index for a whole area: type "pizza in San Francisco", Tavily finds the pizzerias worth knowing, Menusmith builds an extractor for each, and every pizza is compared side by side, cheapest first.

It handles the messy real web: normal websites, menus built by JavaScript (it catches the menu data the page loads), PDF menus, menus that are only a photo (read by Nemotron 3.5 Super VL), and websites that block bots — those it respects, and finds the menu on a public listing instead, clearly labelled.

### What it can be used for

Menus are our test bed. The idea underneath is bigger: **put the expensive AI in the build step, not in every run.**

- **A real-time "price of a burger" index.** Official restaurant inflation numbers come from monthly surveys. Menusmith can track thousands of real menus every night for close to nothing — useful for economists, central banks and journalists ("what does ramen cost in New York vs Seattle this month?").
- **Restaurant owners watching their neighbourhood.** One Discover search shows what every competitor charges for the same dish, and the nightly fleet tells you when they change it.
- **Food apps that never go stale.** Delivery apps, dish-level search, allergen and diet filters ("vegan, under $15, within 1 km") all need fresh menus. Today they pay per refresh, or let data rot.
- **Fair prices for diners.** Compare what a restaurant charges on its own website with what the delivery apps charge for the same dish.
- **Menus for everyone.** Once a menu is clean data, it can be translated, read aloud by a screen reader or filtered by allergens — even when the original is a blurry photo or a PDF.
- **Far beyond food.** The same loop fits any data spread over thousands of slightly different websites that changes now and then: grocery prices, rental listings, job boards, public tenders, product specs.

The economics are what make it work. Reading 10,000 restaurants with an LLM every day costs roughly $36,000 a year (at about a cent per reading) — and gives you noisy data. With Menusmith that's about $110 once (median one-time cost: one cent per restaurant), plus a few cents when a website changes.

## How we built it

- **NVIDIA Nemotron on Nebius Token Factory** for every model call, each job routed to the cheapest model that can do it:
  - **Nemotron 3 Nano** picks menu links and settles disputes between the reading and the code.
  - **Nemotron 3 Super** reads the menu (the reference) and writes and repairs the extractor code, with thinking on.
  - **Nemotron 3 Ultra** takes over the same conversation when Super gets stuck.
  - **Nemotron 3.5 Super VL** reads menus that are only published as pictures.
- **Tavily** finds a restaurant's official website from just its name, maps a site to find the menu page, finds a public listing when a site blocks bots, and powers Discover.
- **A hardened sandbox** runs the AI-written code: a separate process with no secrets, an isolated context with no network or file access, and CPU and memory limits.
- **A headless browser** renders JavaScript menus and captures the menu data the page loads, so later re-runs can skip the browser entirely.
- A React + Hono app that streams every agent step live, running on a free server (0.1 CPU) with a nightly fleet on GitHub Actions.

## Challenges we ran into

- **What even is a dish?** The AI reading and the code disagreed about add-on options, promo banners and "build your own" choices. We added a judge (Nemotron Nano) that settles each disputed item, so both sides get corrected.
- **"0 items" is useless feedback.** So the sandbox records every selector the code used and what it matched — the agent debugs like a developer in the browser's dev tools.
- **Silent mistakes.** A broken extractor is easy to spot. One that quietly misses 2 of 40 dishes isn't. We built and measured a coverage check for exactly that.
- **Weird layouts.** Some site builders put all dish names in one block and all prices in another. One site went from F1 0.03 to 0.99 once we rebuilt the reading order first.
- **Being a good citizen.** Some sites block bots. We decided Menusmith never gets around bot protection; it says so and uses a public listing instead.
- **A tiny budget.** The whole project, including every benchmark, was built within $25 of model credits — which forced us to make every call count.

## Accomplishments that we're proud of

We measured everything instead of just demoing it (all benchmarks are in the repo):

- **20 of 22 US restaurants** typed by just name and city got a menu — San Francisco, New York, Chicago, Seattle, LA, Miami, Nashville, Austin — for $0.38 in total.
- **Re-runs were identical 22 out of 22 times.** Reading the same pages with an LLM: 5 out of 22.
- **10 of 10 redesigned websites healed** by the nightly fleet, all perfect against the true new menu, for about half a cent each.
- Silent dish losses caught **10 out of 10 times**, with **0 false alarms** on 20 healthy extractors.
- **83 of 120** real restaurant websites in Oslo and Palo Alto get a working extractor.

## What we learned

The most useful thing an AI agent can produce is often not an answer — it's a program that produces the answer. When the agent writes code and has to prove it against its own reading, you get speed, a price close to zero and the same result every time, and you only pay for intelligence again when the world actually changes.

## What's next for Menusmith

- A public, nightly **restaurant price index** for a few cities, open for anyone to use.
- **One adapter per ordering platform**, so thousands of restaurants on the same system share one extractor.
- An **API and MCP server**, so other AI agents can ask "what does a margherita cost near me right now?" and get a fresh, verified answer.
- The same engine for **other verticals**: grocery prices, rentals and job listings.
