/**
 * api/sync-matches.js
 * Vercel Serverless Function (also used as Cron — see vercel.json)
 *
 * Always returns JSON, never HTML.
 * Supabase client is created lazily inside the handler so missing
 * env vars produce a JSON error instead of a crash-HTML response.
 */

const { createClient } = require("@supabase/supabase-js");

const COMPETITION_ID = "2000"; // FIFA World Cup 2026 on football-data.org
const FD_BASE        = "https://api.football-data.org/v4";

// ── Broadcast mapping ─────────────────────────────────────────────────────────
const BROADCAST_MAP = {
  "ESPN": "Disney+", "ESPN2": "Disney+", "ESPN3": "Disney+",
  "ESPN+": "Disney+", "Disney+": "Disney+",
  "DSports": "DGO", "D Sports": "DGO", "DGO": "DGO",
  "Teleamazonas": "Teleamazonas",
  "TC Televisión": "TC", "TC": "TC",
  "Canal Uno": "Canal Uno",
};
const mapBroadcast = (raw) => (raw || []).map(b => BROADCAST_MAP[b] || "Ver Guía");

// ── Stage / status mapping ────────────────────────────────────────────────────
function mapStage(stage) {
  const s = (stage || "").toUpperCase();
  if (s.includes("GROUP"))                            return "GROUP";
  if (s.includes("16") || s.includes("ROUND OF 16")) return "R16";
  if (s.includes("QUARTER"))                          return "QF";
  if (s.includes("SEMI"))                             return "SF";
  if (s.includes("FINAL"))                            return "F";
  return stage || "GROUP";
}
function mapStatus(status) {
  const s = (status || "").toUpperCase();
  if (s === "SCHEDULED" || s === "TIMED") return "SCHEDULED";
  if (s === "IN_PLAY")   return "LIVE";
  if (s === "PAUSED")    return "HT";
  if (s === "FINISHED")  return "FT";
  if (s === "POSTPONED") return "POSTPONED";
  return status || "SCHEDULED";
}

// ── TLA → ISO2 ────────────────────────────────────────────────────────────────
const TLA_TO_ISO2 = {
  // CONCACAF
  USA:"us", MEX:"mx", CAN:"ca", PAN:"pa", HAI:"ht", CUW:"cw",
  // CONMEBOL
  ARG:"ar", BRA:"br", COL:"co", ECU:"ec", URU:"uy", PAR:"py",
  // UEFA
  FRA:"fr", ESP:"es", ENG:"gb-eng", POR:"pt", GER:"de", NED:"nl",
  BEL:"be", CRO:"hr", SUI:"ch", AUT:"at", SCO:"gb-sct", NOR:"no",
  SWE:"se", TUR:"tr", CZE:"cz", BIH:"ba",
  // CAF
  MAR:"ma", SEN:"sn", EGY:"eg", TUN:"tn", ALG:"dz", RSA:"za",
  CIV:"ci", GHA:"gh", CPV:"cv", COD:"cd",
  // AFC
  JPN:"jp", IRN:"ir", KOR:"kr", AUS:"au", UZB:"uz", JOR:"jo",
  QAT:"qa", SAU:"sa", IRQ:"iq",
  // OFC
  NZL:"nz",
};
const tlaToIso2 = (tla) =>
  TLA_TO_ISO2[(tla || "").toUpperCase()] || (tla || "??").toLowerCase().slice(0, 2);

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Always respond with JSON
  res.setHeader("Content-Type", "application/json");

  // ── 1. Check env vars ────────────────────────────────────────────────────────
  const FOOTBALL_API_KEY     = process.env.FOOTBALL_API_KEY;
  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CRON_SECRET          = process.env.CRON_SECRET;

  const missing = [];
  if (!FOOTBALL_API_KEY)     missing.push("FOOTBALL_API_KEY");
  if (!SUPABASE_URL)         missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");

  if (missing.length > 0) {
    return res.status(500).json({
      error: "Missing environment variables",
      missing,
      hint: "Set these in Vercel Dashboard → Project → Settings → Environment Variables",
    });
  }

  // ── 2. Auth check (cron secret, optional) ────────────────────────────────────
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized — invalid CRON_SECRET" });
  }

  // ── 3. Init Supabase lazily (after env var check) ────────────────────────────
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const now = new Date();
  console.log(`[sync-matches] Tick at ${now.toISOString()}`);

  try {
    // ── 4. Check active match window ──────────────────────────────────────────
    let inWindow = false;
    try {
      const { data: live } = await supabase
        .from("matches").select("id").or("status.eq.LIVE,status.eq.HT").limit(1);
      if (live && live.length > 0) {
        inWindow = true;
      } else {
        const windowStart = new Date(now.getTime() - 30 * 60 * 1000);
        const windowEnd   = new Date(now.getTime() + 30 * 60 * 1000);
        const { data: upcoming } = await supabase
          .from("matches").select("id").eq("status", "SCHEDULED")
          .gte("kickoff_utc", windowStart.toISOString())
          .lte("kickoff_utc", windowEnd.toISOString()).limit(1);
        inWindow = !!(upcoming && upcoming.length > 0);
      }
    } catch (windowErr) {
      console.warn("[sync-matches] match window check failed:", windowErr.message);
      // Continue anyway — if Supabase is down we still want to hit the API
      inWindow = true;
    }

    // Outside match window: only sync once per hour (minute 0–2)
    if (!inWindow && now.getUTCMinutes() > 2 && now.getUTCMinutes() < 58) {
      console.log("[sync-matches] No active match window — skipping this tick");
      return res.status(200).json({ skipped: true, reason: "no_match_window" });
    }

    // ── 5. Fetch matches from football-data.org ───────────────────────────────
    const dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateTo   = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const apiUrl   = `${FD_BASE}/competitions/${COMPETITION_ID}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    console.log(`[sync-matches] Fetching: ${apiUrl}`);

    const apiRes = await fetch(apiUrl, {
      headers: { "X-Auth-Token": FOOTBALL_API_KEY },
    });

    if (!apiRes.ok) {
      const body = await apiRes.text();
      return res.status(502).json({
        error: `football-data.org returned ${apiRes.status}`,
        body: body.slice(0, 500),
        url: apiUrl,
      });
    }

    const apiData = await apiRes.json();
    const matches  = apiData.matches || [];
    console.log(`[sync-matches] API returned ${matches.length} matches`);

    // ── 6. Upsert matches into Supabase ──────────────────────────────────────
    let matchCount = 0;
    if (matches.length > 0) {
      const rows = matches.map(m => ({
        id:                  String(m.id),
        home_team:           tlaToIso2(m.homeTeam?.tla),
        away_team:           tlaToIso2(m.awayTeam?.tla),
        home_score:          m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? null,
        away_score:          m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? null,
        kickoff_utc:         m.utcDate,
        status:              mapStatus(m.status),
        stage:               mapStage(m.stage),
        group_name:          m.group ? m.group.replace("GROUP_", "") : null,
        venue:               m.venue || null,
        broadcast_platforms: mapBroadcast(m.broadcastChannels?.map(b => b.name)),
        updated_at:          now.toISOString(),
      }));

      const { error: upsertErr } = await supabase
        .from("matches")
        .upsert(rows, { onConflict: "id" });

      if (upsertErr) {
        return res.status(500).json({
          error: "Supabase upsert failed",
          details: upsertErr.message,
        });
      }
      matchCount = rows.length;
    }

    // ── 7. Fetch + upsert standings (hourly or during match window) ───────────
    let standingCount = 0;
    if (now.getUTCMinutes() <= 2 || inWindow) {
      try {
        const stRes = await fetch(`${FD_BASE}/competitions/${COMPETITION_ID}/standings`, {
          headers: { "X-Auth-Token": FOOTBALL_API_KEY },
        });
        if (stRes.ok) {
          const stData = await stRes.json();
          const stRows = [];
          for (const group of stData.standings || []) {
            const gName = (group.group || "").replace("GROUP_", "") || "?";
            for (const entry of group.table || []) {
              stRows.push({
                group_name: gName,
                team:       tlaToIso2(entry.team?.tla),
                played:     entry.playedGames || 0,
                won:        entry.won  || 0,
                drawn:      entry.draw || 0,
                lost:       entry.lost || 0,
                gf:         entry.goalsFor     || 0,
                ga:         entry.goalsAgainst || 0,
                gd:         entry.goalDifference || 0,
                points:     entry.points || 0,
                updated_at: now.toISOString(),
              });
            }
          }
          if (stRows.length > 0) {
            const { error: stErr } = await supabase
              .from("standings")
              .upsert(stRows, { onConflict: "group_name,team" });
            if (!stErr) standingCount = stRows.length;
            else console.warn("[sync-matches] standings upsert warning:", stErr.message);
          }
        }
      } catch (stError) {
        console.warn("[sync-matches] standings fetch failed:", stError.message);
      }
    }

    console.log(`[sync-matches] Done — ${matchCount} matches, ${standingCount} standings`);
    return res.status(200).json({
      success:       true,
      matchCount,
      standingCount,
      inWindow,
      timestamp:     now.toISOString(),
      dateRange:     { from: dateFrom, to: dateTo },
    });

  } catch (err) {
    console.error("[sync-matches] Unhandled error:", err.message, err.stack);
    return res.status(500).json({
      error:   "Unhandled server error",
      message: err.message,
    });
  }
};
