/**
 * api/sync-matches.js
 * Vercel Cron Function — schedule: every 2 minutes (vercel.json)
 *
 * Strategy:
 *  - During active match windows (30 min before kickoff → 30 min after FT):
 *      fetch live data from football-data.org, upsert into Supabase.
 *  - Outside match windows: only sync on hourly ticks (minute <= 2).
 *  - All clients read exclusively from Supabase — never from the API directly.
 *
 * Vercel calls this via GET. Protect with CRON_SECRET env var.
 */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FOOTBALL_API_KEY     = process.env.FOOTBALL_API_KEY;
const COMPETITION_ID       = process.env.FOOTBALL_COMPETITION_ID || "2000";
const CRON_SECRET          = process.env.CRON_SECRET;

const FD_BASE = "https://api.football-data.org/v4";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Broadcast mapping ─────────────────────────────────────────────────────────
const BROADCAST_MAP = {
  ESPN: "Disney+", "ESPN2": "Disney+", "ESPN3": "Disney+", "ESPN+": "Disney+", "Disney+": "Disney+",
  DSports: "DGO", "D Sports": "DGO", DGO: "DGO",
  Teleamazonas: "Teleamazonas",
  "TC Televisión": "TC", TC: "TC",
  "Canal Uno": "Canal Uno",
};
function mapBroadcast(raw) {
  return (raw || []).map(b => BROADCAST_MAP[b] || "Ver Guía");
}

// ── Stage mapping ─────────────────────────────────────────────────────────────
function mapStage(stage) {
  const s = (stage || "").toUpperCase();
  if (s.includes("GROUP"))                       return "GROUP";
  if (s.includes("16") || s.includes("ROUND OF 16")) return "R16";
  if (s.includes("QUARTER"))                     return "QF";
  if (s.includes("SEMI"))                        return "SF";
  if (s.includes("FINAL"))                       return "F";
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

// ── ISO2 lookup ───────────────────────────────────────────────────────────────
const TLA_TO_ISO2 = {
  ARG:"ar",BRA:"br",FRA:"fr",GER:"de",ESP:"es",POR:"pt",NED:"nl",BEL:"be",
  ENG:"gb-eng",ITA:"it",URU:"uy",COL:"co",CHI:"cl",PER:"pe",ECU:"ec",PAR:"py",
  BOL:"bo",VEN:"ve",USA:"us",MEX:"mx",CAN:"ca",CRC:"cr",PAN:"pa",HON:"hn",
  JAM:"jm",SLV:"sv",MAR:"ma",SEN:"sn",NGA:"ng",GHA:"gh",CMR:"cm",CIV:"ci",
  EGY:"eg",TUN:"tn",MLI:"ml",ALG:"dz",JPN:"jp",KOR:"kr",IRN:"ir",AUS:"au",
  SAU:"sa",QAT:"qa",UAE:"ae",JOR:"jo",IRQ:"iq",CRO:"hr",SRB:"rs",SUI:"ch",
  POL:"pl",DEN:"dk",SWE:"se",NOR:"no",SCO:"gb-sct",WAL:"gb-wls",TUR:"tr",
  UKR:"ua",SVK:"sk",SVN:"si",ROU:"ro",HUN:"hu",CZE:"cz",AUT:"at",ISL:"is",
  FIN:"fi",ALB:"al",GEO:"ge",NZL:"nz",FIJ:"fj",
};
function tlaToIso2(tla) {
  return TLA_TO_ISO2[(tla || "").toUpperCase()] || (tla || "??").toLowerCase().slice(0, 2);
}

// ── Active match window check ─────────────────────────────────────────────────
async function isMatchWindow() {
  const { data: live } = await supabase
    .from("matches").select("id").or("status.eq.LIVE,status.eq.HT").limit(1);
  if (live && live.length > 0) return true;

  const now = new Date();
  const windowStart = new Date(now.getTime() - 30 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 30 * 60 * 1000);
  const { data: upcoming } = await supabase
    .from("matches").select("id").eq("status", "SCHEDULED")
    .gte("kickoff_utc", windowStart.toISOString())
    .lte("kickoff_utc", windowEnd.toISOString()).limit(1);
  return upcoming && upcoming.length > 0;
}

// ── Fetch from football-data.org ──────────────────────────────────────────────
async function fetchFromAPI(dateFrom, dateTo) {
  const res = await fetch(
    `${FD_BASE}/competitions/${COMPETITION_ID}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
    { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
  );
  if (!res.ok) throw new Error(`football-data.org ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchStandings() {
  const res = await fetch(
    `${FD_BASE}/competitions/${COMPETITION_ID}/standings`,
    { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
  );
  if (!res.ok) return null;
  return res.json();
}

// ── Upsert helpers ────────────────────────────────────────────────────────────
async function upsertMatches(apiMatches) {
  if (!apiMatches || apiMatches.length === 0) return 0;
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
  const { error } = await supabase.from("matches").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(`Supabase upsert: ${error.message}`);
  return rows.length;
}

async function upsertStandings(apiData) {
  if (!apiData?.standings) return 0;
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
  if (rows.length === 0) return 0;
  const { error } = await supabase.from("standings").upsert(rows, { onConflict: "group_name,team" });
  if (error) console.warn("Standings upsert warning:", error.message);
  return rows.length;
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Verify Vercel cron secret (set CRON_SECRET env var in Vercel dashboard)
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const now = new Date();
  console.log(`[sync-matches] Tick at ${now.toISOString()}`);

  try {
    const inWindow = await isMatchWindow();

    // Outside match window: only sync once per hour (minute 0–2)
    if (!inWindow && now.getUTCMinutes() > 2 && now.getUTCMinutes() < 58) {
      console.log("[sync-matches] No active match window — skipping");
      return res.status(200).json({ skipped: true, reason: "no_match_window" });
    }

    const dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateTo   = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const data = await fetchFromAPI(dateFrom, dateTo);
    const matchCount = await upsertMatches(data.matches);

    let standingCount = 0;
    if (now.getUTCMinutes() <= 2 || inWindow) {
      const standingsData = await fetchStandings();
      standingCount = await upsertStandings(standingsData);
    }

    console.log(`[sync-matches] Upserted ${matchCount} matches, ${standingCount} standings`);
    return res.status(200).json({ success: true, matchCount, standingCount, timestamp: now.toISOString() });

  } catch (err) {
    console.error("[sync-matches] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
