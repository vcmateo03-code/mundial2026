# ⚽ Mundial 2026

A production-ready World Cup 2026 web app with live scores, group standings, bracket, and a predictions leaderboard — built for Ecuador fans.

**Stack:** Vanilla HTML/CSS/JS · Supabase (PostgreSQL + Realtime) · Netlify (Serverless + Cron) · football-data.org API

---

## Features

- **Personalized home** — next match for your favorite team, followed teams, today's matches
- **Live scores** via Supabase Realtime (no polling from the client)
- **Smart API caching** — serverless function syncs every 2 min during matches; all clients read only from Supabase
- **Group standings** with qualification color coding
- **Tournament bracket** (fills in as teams advance)
- **Predictions leaderboard** with +5/+2/0 scoring
- **Ecuador broadcast badges** — Disney+, DGO, Teleamazonas, TC, Canal Uno
- **Dark glassmorphism UI**, mobile-first, Bebas Neue + DM Sans

---

## Setup

### 1. Supabase Project

1. Go to [supabase.com](https://supabase.com) → New Project
2. In **SQL Editor**, run the full contents of [`supabase/schema.sql`](supabase/schema.sql)
3. Go to **Settings → API** and copy:
   - Project URL → `SUPABASE_URL`
   - `anon` public key → `SUPABASE_ANON_KEY`
   - `service_role` secret key → `SUPABASE_SERVICE_KEY`
4. In **Database → Replication**, confirm `matches` table is added to the `supabase_realtime` publication (the schema SQL does this automatically)

### 2. football-data.org API Key

1. Register free at [football-data.org](https://www.football-data.org/client/register)
2. Copy your API token → `FOOTBALL_API_KEY`
3. The World Cup competition ID is typically `2000` — confirm at:
   `https://api.football-data.org/v4/competitions` (requires your token in `X-Auth-Token` header)
4. Free tier: 10 requests/minute, full match + standings data

### 3. Frontend Configuration

Open `index.html` and replace the two placeholder values near the top of the `<script>` block:

```js
const SUPABASE_URL      = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

### 4. Netlify Deployment

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Link to your Netlify site (or create new)
netlify init

# Set environment variables
netlify env:set SUPABASE_URL          "https://xxx.supabase.co"
netlify env:set SUPABASE_ANON_KEY     "eyJ..."
netlify env:set SUPABASE_SERVICE_KEY  "eyJ..."
netlify env:set FOOTBALL_API_KEY      "your-key"
netlify env:set FOOTBALL_COMPETITION_ID "2000"

# Deploy
netlify deploy --prod
```

Or connect your GitHub repo in the Netlify dashboard and set env vars under **Site Settings → Environment Variables**.

#### Scheduled Functions

The `netlify.toml` configures two cron jobs automatically:

| Function | Schedule | Purpose |
|---|---|---|
| `sync-matches` | Every 2 min | Fetches match data from API → upserts Supabase |
| `score-predictions` | Every 5 min | Scores FT matches, updates user points |

Netlify Scheduled Functions require the **[Netlify Scheduled Functions plugin](https://github.com/netlify/netlify-plugin-scheduled-functions)**. It is declared in `netlify.toml` and will be installed automatically on deploy.

> **API budget protection:** `sync-matches` skips ticks when no match is within a 30-min window, and only syncs once per hour outside match days. This keeps you well within the free tier's daily limits regardless of traffic.

### 5. Environment Variables Reference

Copy `.env.example` to `.env` for local dev (not needed for Netlify — use the dashboard):

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Public anon key (safe in frontend) |
| `SUPABASE_SERVICE_KEY` | Service role key — **server only, never expose to client** |
| `FOOTBALL_API_KEY` | football-data.org token |
| `FOOTBALL_COMPETITION_ID` | Competition ID (default: `2000` for FIFA WC) |

---

## Local Development

No build step needed — it's a static HTML file.

```bash
# Serve with Python (built-in)
python -m http.server 3000

# Or use the Netlify dev server (runs functions locally too)
netlify dev
```

For `netlify dev`, set your env vars in a `.env` file first.

---

## Project Structure

```
mundial/
├── index.html                          # Full SPA (HTML + CSS + JS)
├── netlify.toml                        # Build config + scheduled function cron
├── .env.example                        # Env var template
├── supabase/
│   └── schema.sql                      # Full DB schema + seed data
└── netlify/
    └── functions/
        ├── sync-matches.js             # API → Supabase sync (cron)
        └── score-predictions.js        # Points calculator (cron)
```

---

## How the Caching Architecture Works

```
football-data.org API
        │
        ▼  (every 2 min during matches, hourly otherwise)
sync-matches.js  ──upsert──►  Supabase `matches` table
                                        │
                              Realtime subscription
                                        │
                              ◄─────────────────────
                              All browser clients
                              (read-only from Supabase)
```

The external API is **never called from the browser**. All live data flows through the Netlify serverless function → Supabase → browser via Realtime WebSocket.

---

## Scoring Rules

| Result | Points |
|---|---|
| Exact score (e.g. predicted 2-1, actual 2-1) | **+5** |
| Correct winner/draw, off by 1 goal on either side | **+2** |
| Wrong result | **+0** |

Points are calculated by `score-predictions.js` when a match reaches `FT` status.

---

## Broadcast Badge Mapping

| API channel name | Badge shown | Color |
|---|---|---|
| ESPN / ESPN2 / ESPN3 / Disney+ | **Disney+** | Purple |
| DSports / D Sports / DGO | **DGO** | Blue |
| Teleamazonas | **Teleamazonas** | Green |
| TC Televisión | **TC** | Red |
| Canal Uno | **Canal Uno** | Orange |
| (anything else) | **Ver Guía** | Grey |

---

## Notes

- All times are displayed in **Ecuador time (America/Guayaquil, UTC-5)**
- Username is permanent once set
- The app gracefully shows "Próximamente" states when no API data is available yet
- Multiple simultaneous users all read the same Supabase data; each sees their own personalized home view based on `localStorage` user ID
