/**
 * sync-matches.js
 * Netlify Scheduled Function — runs every 2 minutes.
 *
 * Strategy:
 *  - During active match windows (30 min before kickoff → 30 min after FT):
 *      fetch live data from football-data.org, upsert into Supabase.
 *  - Outside match windows: run hourly refresh only (skip on non-hourly ticks).
 *  - All clients read exclusively from Supabase — never from the API directly.
 */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FOOTBALL_API_KEY    = process.env.FOOTBALL_API_KEY;
const COMPETITION_ID      = process.env.FOOTBALL_COMPETITION_ID || "2000";

// football-data.org base URL
const FD_BASE = "https://api.football-data.org/v4";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Broadcast mapping (API team names → platform badges) ─────────────────────
const BROADCAST_MAP = {
  ESPN:          "Disney+",
  "ESPN2":       "Disney+",
  "ESPN3":       "Disney+",
  "ESPN+":       "Disney+",
  "Disney+":     "Disney+",
  DSports:       "DGO",
  "D Sports":    "DGO",
  DGO:           "DGO",
  Teleamazonas:  "Teleamazonas",
  "TC Televisión":"TC",
  "TC":          "TC",
  "Canal Uno":   "Canal Uno",
};

function mapBroadcast(raw) {
  return (raw || []).map(b => BROADCAST_MAP[b] || "Ver Guía");
}

// ── Stage mapping ────────────────────────────────────────────────────────────
function mapStage(stage) {
  const s = (stage || "").toUpperCase();
  if (s.includes("GROUP"))          return "GROUP";
  if (s.includes("16") || s.includes("ROUND OF 16")) return "R16";
  if (s.includes("QUARTER"))        return "QF";
  if (s.includes("SEMI"))           return "SF";
  if (s.includes("FINAL"))          return "F";
  return stage || "GROUP";
}

// ── Status mapping ────────────────────────────────────────────────────────────
function mapStatus(status) {
  const s = (status || "").toUpperCase();
  if (s === "SCHEDULED" || s === "TIMED") return "SCHEDULED";
  if (s === "IN_PLAY")  return "LIVE";
  if (s === "PAUSED")   return "HT";
  if (s === "FINISHED") return "FT";
  if (s === "POSTPONED") return "POSTPONED";
  return status;
}

// ── ISO country code helper (football-data.org uses tla or crest URL) ────────
// football-data.org provides team.tla (3-letter) and team.crest (URL with flag)
// We extract the 2-letter ISO from the crest URL or use a manual map.
const TLA_TO_ISO2 = {
  ARG:"ar", BRA:"br", FRA:"fr", GER:"de", ESP:"es", POR:"pt",
  NED:"nl", BEL:"be", ENG:"gb-eng", ITA:"it", URU:"uy", COL:"co",
  CHI:"cl", PER:"pe", ECU:"ec", PAR:"py", BOL:"bo", VEN:"ve",
  USA:"us", MEX:"mx", CAN:"ca", CRC:"cr", PAN:"pa", HON:"hn",
  JAM:"jm", SLV:"sv",
  MAR:"ma", SEN:"sn", NGA:"ng", GHA:"gh", CMR:"cm", CIV:"ci",
  EGY:"eg", TUN:"tn", MLI:"ml", ALG:"dz",
  JPN:"jp", KOR:"kr", IRN:"ir", AUS:"au", SAU:"sa", QAT:"qa",
  UAE:"ae", JOR:"jo", IRQ:"iq",
  CRO:"hr", SRB:"rs", SUI:"ch", POL:"pl", DEN:"dk", SWE:"se",
  NOR:"no", SCO:"gb-sct", WAL:"gb-wls", TUR:"tr", UKR:"ua",
  SVK:"sk", SVN:"si", ROU:"ro", HUN:"hu", CZE:"cz", AUT:"at",
  ISL:"is", FIN:"fi", ALB:"al", GEO:"ge", NZL:"nz", FIJ:"fj",
};

function tlaToIso2(tla) {
  return TLA_TO_ISO2[(tla || "").toUpperCase()] || (tla || "??").toLowerCase().slice(0,2);
}

// ── Check if we are in an active match window ─────────────────────────────────
async function isMatchWindow() {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 30 * 60 * 1000);   // 30 min ago
  const windowEnd   = new Date(now.getTime() + 30 * 60 * 1000);   // 30 min ahead

  const { data, error } = await supabase
    .from("matches")
    .select("id")
    .or(`status.eq.LIVE,status.eq.HT`)
    .limit(1);

  if (data && data.length > 0) return true; // a match is live right now

  // Check if any match kicks off in the next 30 minutes
  const { data: upcoming } = await supabase
    .from("matches")
    .select("id")
    .eq("status", "SCHEDULED")
    .gte("kickoff_utc", windowStart.toISOString())
    .lte("kickoff_utc", windowEnd.toISOString())
    .limit(1);

  return upcoming && upcoming.length > 0;
}

// ── Fetch matches from football-data.org ──────────────────────────────────────
async function fetchFromAPI(dateFrom, dateTo) {
  const url = `${FD_BASE}/competitions/${COMPETITION_ID}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": FOOTBALL_API_KEY }
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`football-data.org error ${res.status}: ${txt}`);
  }
  return res.json();
}

// ── Fetch standings ───────────────────────────────────────────────────────────
async function fetchStandings() {
  const url = `${FD_BASE}/competitions/${COMPETITION_ID}/standings`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": FOOTBALL_API_KEY }
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Upsert matches into Supabase ──────────────────────────────────────────────
async function upsertMatches(apiMatches) {
  if (!apiMatches || apiMatches.length === 0) return;

  const rows = apiMatches.map(m => ({
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
    updated_at:          new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("matches")
    .upsert(rows, { onConflict: "id" });

  if (error) throw new Error(`Supabase upsert error: ${error.message}`);
  return rows.length;
}

// ── Upsert standings ──────────────────────────────────────────────────────────
async function upsertStandings(apiData) {
  if (!apiData?.standings) return;

  const rows = [];
  for (const group of apiData.standings) {
    const groupName = group.group?.replace("GROUP_", "") || "?";
    for (const entry of group.table || []) {
      rows.push({
        group_name: groupName,
        team:       tlaToIso2(entry.team?.tla),
        played:     entry.playedGames || 0,
        won:        entry.won  || 0,
        drawn:      entry.draw || 0,
        lost:       entry.lost || 0,
        gf:         entry.goalsFor     || 0,
        ga:         entry.goalsAgainst || 0,
        gd:         entry.goalDifference || 0,
        points:     entry.points || 0,
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (rows.length === 0) return;

  const { error } = await supabase
    .from("standings")
    .upsert(rows, { onConflict: "group_name,team" });

  if (error) console.warn("Standings upsert warning:", error.message);
  return rows.length;
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  const now = new Date();
  const isScheduledTick = event?.httpMethod === undefined; // cron calls have no httpMethod

  console.log(`[sync-matches] Tick at ${now.toISOString()}`);

  try {
    const inWindow = await isMatchWindow();

    // Outside match window: only sync once per hour (at :00 minutes ± 2 min)
    if (!inWindow) {
      const minutes = now.getUTCMinutes();
      if (minutes > 2 && minutes < 58) {
        console.log("[sync-matches] No active match window — skipping this tick");
        return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: "no_match_window" }) };
      }
    }

    // Fetch next 7 days of matches (and last 24h for live/recent)
    const dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateTo   = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const data = await fetchFromAPI(dateFrom, dateTo);
    const matchCount = await upsertMatches(data.matches);

    // Sync standings on hourly ticks
    let standingCount = 0;
    if (now.getUTCMinutes() <= 2 || inWindow) {
      const standingsData = await fetchStandings();
      standingCount = await upsertStandings(standingsData) || 0;
    }

    console.log(`[sync-matches] Upserted ${matchCount} matches, ${standingCount} standings`);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, matchCount, standingCount, timestamp: now.toISOString() })
    };

  } catch (err) {
    console.error("[sync-matches] Error:", err.message);
    // Don't throw — scheduled functions should not retry on error
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
