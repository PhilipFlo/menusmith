# Free deployment on Render (+ Supabase store, GitHub Actions fleet)

| Piece | Where | Cost |
|---|---|---|
| Web app + API | Render free web service, `Dockerfile.slim` | $0 |
| Durable library (extractors, snapshots, fleet reports) | Supabase project `menusmith`, table `menusmith_files` | $0 |
| Nightly fleet | GitHub Actions `fleet.yml` (scheduled) | $0 (Actions minutes) |
| Models | Nebius Token Factory (NVIDIA Nemotron) | pay-per-use, capped by `MENUSMITH_DAILY_BUDGET_USD` |

Everything stays portable: the same image runs on Nebius AI Cloud (`deploy/nebius.sh`),
and without the `MENUSMITH_STORE_*` variables the app simply uses local files.

## What the free tier can and can't do

Tested locally with Render's limits (`docker run --memory=512m --cpus=0.1`):

| Feature | Free tier |
|---|---|
| Browse Library / Fleet / How it works | ✅ |
| Forge a site whose menu is in the server HTML | ✅ ~45 s, peak ~155 MB |
| Forge a PDF menu / image menu | ✅ ~45 s, ~265 MB with pdf.js loaded |
| Re-run extractors written over a menu API (JSON) | ✅ (request replayed, no browser) |
| Forge a menu that only exists after JavaScript runs | ❌ no headless browser in the slim image — use the full `Dockerfile` (Nebius / any ≥1 GB host) |
| Fleet run (public: 10 demo sites) | ✅ ~2 min, $0 when nothing changed |
| Library survives restarts / sleep | ✅ restored from Supabase at startup |
| First request after 15 min idle | ⚠️ ~1 min cold start (Render spins free services down) |

## One-time setup (you)

1. **Render account** — sign up at render.com with your GitHub login (free plan; don't add a card).
2. **New → Blueprint** → pick the `PhilipFlo/menusmith` repo (allow Render to read it).
   Render reads `render.yaml` and asks for the secret values.
3. Paste each value from your local `.env` — open the file, or print the six lines in your
   own terminal:
   ```bash
   grep -E '^(NEBIUS_API_KEY|TAVILY_API_KEY|MENUSMITH_STORE_URL|MENUSMITH_STORE_KEY|MENUSMITH_STORE_TOKEN|MENUSMITH_ADMIN_TOKEN)=' .env
   ```
   Never paste them into chat, issues, or the repo.
4. **Apply** — the first build takes ~5 minutes. The URL looks like `https://menusmith-xxxx.onrender.com`.
5. **Nightly fleet** — GitHub → the repo → Settings → Secrets and variables → Actions → *New
   repository secret*, add the first five names above with the same values. Then Actions →
   *fleet* → *Run workflow* once to test.

## Running the full fleet on the live demo (owner only)

```bash
curl -N -X POST https://<your-app>.onrender.com/api/fleet/run \
  -H "authorization: Bearer $MENUSMITH_ADMIN_TOKEN" -H 'content-type: application/json' -d '{}'
```
