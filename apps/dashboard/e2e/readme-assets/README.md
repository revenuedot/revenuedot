# README assets

The screenshots, hero GIF and dashboard tour video in `docs/assets/readme/` come from the seeded e2e dashboard, enriched so the demo project "Scanner" reads like a real app. Rerun after a visual change to shared chrome; mixing old and new shots looks broken.

```bash
cd apps/dashboard && pnpm build
DB=$PWD/.readme-assets/pg                                            # a file-backed PGlite (one process at a time)
E2E_DATABASE_URL=pglite://$DB PORT=5500 npx tsx e2e/server.ts        # seeds, then stop it (Ctrl-C) once /__ready is 200
E2E_DATABASE_URL=pglite://$DB npx tsx e2e/readme-assets/enrich.ts    # ~360 App Store subscription chains over 120 days
E2E_SEED=off E2E_DATABASE_URL=pglite://$DB PORT=5500 npx tsx e2e/server.ts &   # start again without seeding
node e2e/readme-assets/prep.mjs        # support email, a paywall from the template, an experiment with results, the starter funnel
node e2e/readme-assets/xp-more.mjs     # more experiment customers, with a clear treatment lift
# stop the server, then:
BACKDATE=1 E2E_DATABASE_URL=pglite://$DB npx tsx e2e/readme-assets/enrich.ts   # spread the experiment customers' first visit over 27 days
# start the server again (E2E_SEED=off), then:
node e2e/readme-assets/capture.mjs [overview charts ...]   # 1440x900 at 2x, light and dark, into .readme-assets/raw/
node e2e/readme-assets/optimise.mjs .readme-assets/raw ../../docs/assets/readme   # 8-bit PNGs, each about 100 KB
node e2e/readme-assets/record-hero.mjs                     # 1280x800 tour with a cursor, into .readme-assets/hero.webm
```

Encode the tour (ffmpeg): `-ss 0.4 … -c:v libx264 -crf 28 -movflags +faststart hero.mp4`; the poster is the frame at 2.5 s as WebP (sharp); the GIF is `fps=15,scale=1280:-1` with `palettegen`/`paletteuse` (bayer dither), under 8 MB. The MP4 is uploaded to Cloudflare Stream and listed in `apps/site/src/lib/videos.mjs`; the log is `company/marketing/videos/README.md`.

Shots: `overview`, `charts` (MRR by product, Customers tab), `paywall-editor`, `experiments` (results), `funnels` (builder), `customer-center` (editor with the preview open), `integrations`, `customer`, `ai` (the scripted fake model answers "How is revenue doing this month?" with real numbers). `capture.mjs` scrubs this machine's host from the funnel's address.
