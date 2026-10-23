# Submission checklist — Nebius × NVIDIA Global AI Hackathon

Deadline: **Fri 30 Oct 2026, 10:00 PT = 18:00 Oslo**. Aim to submit on **29 Oct**.

## Done

- [x] Working project on Nebius Token Factory with five NVIDIA models (Nemotron 3 Nano / Super /
      Ultra, Nemotron 3.5 Super VL; Lightning in the fallback chain)
- [x] Public demo: https://menusmith.onrender.com (free tier; durable store; daily spend cap)
- [x] Repo with MIT licence, README (setup, model usage, results, screenshots)
- [x] Offline demo with no key: `npm run demo`; 155 tests; CI workflow
- [x] Benchmark on 120 real restaurant sites + 10 ground-truth fixtures (`bench/results/`)
- [x] Video screen clips: `submission/clips/*.webm` + script `submission/VIDEO-SCRIPT.md`
- [x] Devpost text: `submission/DEVPOST.md` (incl. the feedback section)

## You — before submitting

- [ ] **Render:** set `MENUSMITH_LLM` to `live` (or delete it) → the badge shows "Live".
- [ ] **Optional — nightly fleet:** GitHub → Settings → Secrets and variables → Actions → add
      `NEBIUS_API_KEY`, `TAVILY_API_KEY`, `MENUSMITH_STORE_URL`, `MENUSMITH_STORE_KEY`,
      `MENUSMITH_STORE_TOKEN`; then Actions → *fleet* → *Run workflow*.
- [ ] **Video:** cut the clips to the script, add your voice-over (or captions), title + end
      cards, ≤ 3:00, upload to YouTube as **Public**. No copyrighted music.
- [ ] **Repo public:** GitHub → menusmith → Settings → General → Danger Zone → Change visibility
      → Public. Check the MIT licence shows in the "About" box.
- [ ] **README:** paste the YouTube link where it says `Demo video: _(link)_` (or ask Claude).
- [ ] **Devpost** (nebiusglobalaihackathon.devpost.com → Enter a submission):
  - Track: **Coding and Agentic Engineering**
  - Text: from `submission/DEVPOST.md` (Inspiration … What's next, Built with)
  - Demo URL: https://menusmith.onrender.com
  - Repo URL: https://github.com/PhilipFlo/menusmith
  - YouTube URL
  - Images: `docs/screenshots/*.png` (extractor-diff first)
  - "Existed before?" — explain: new code written in the submission period; uses nearBite data
    only as a benchmark reference (text is in DEVPOST.md)
  - Feedback section: paste from DEVPOST.md
- [ ] Wake the demo once (open it) shortly before judging days; Render free sleeps after 15 min.

## After the hackathon

- [ ] Rotate the Nebius and Tavily API keys (they appeared in a chat).
- [ ] Judging is Dec 1–15: keep the Render service and the Supabase project; the nightly fleet
      keeps the free Supabase project from pausing.
