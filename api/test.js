/**
 * api/test.js
 * Diagnostic endpoint — returns env var presence (never values) and
 * does a live ping to football-data.org to verify the API key works.
 *
 * Visit: https://your-vercel-domain.vercel.app/api/test
 */

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const FOOTBALL_API_KEY     = process.env.FOOTBALL_API_KEY;
  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY;
  const CRON_SECRET          = process.env.CRON_SECRET;

  // ── Env var presence (names only, never values) ───────────────────────────
  const envStatus = {
    FOOTBALL_API_KEY:     FOOTBALL_API_KEY     ? "✅ set" : "❌ MISSING",
    SUPABASE_URL:         SUPABASE_URL         ? "✅ set" : "❌ MISSING",
    SUPABASE_SERVICE_KEY: SUPABASE_SERVICE_KEY ? "✅ set" : "❌ MISSING",
    SUPABASE_ANON_KEY:    SUPABASE_ANON_KEY    ? "✅ set" : "❌ MISSING",
    CRON_SECRET:          CRON_SECRET          ? "✅ set" : "⚠️ not set (optional)",
  };

  // ── Live ping: football-data.org competitions list ────────────────────────
  let apiPing = { status: "not_tested", reason: "FOOTBALL_API_KEY missing" };
  if (FOOTBALL_API_KEY) {
    try {
      const pingRes = await fetch(
        "https://api.football-data.org/v4/competitions/2000",
        { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
      );
      const pingBody = await pingRes.json();
      apiPing = {
        status:       pingRes.ok ? "✅ ok" : "❌ error",
        httpStatus:   pingRes.status,
        competition:  pingBody.name || null,
        currentSeason: pingBody.currentSeason?.startDate || null,
        error:        pingRes.ok ? null : (pingBody.message || pingBody.error || null),
      };
    } catch (e) {
      apiPing = { status: "❌ fetch_failed", error: e.message };
    }
  }

  // ── Live ping: Supabase ───────────────────────────────────────────────────
  let supabasePing = { status: "not_tested", reason: "SUPABASE_URL or SERVICE_KEY missing" };
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const { createClient } = require("@supabase/supabase-js");
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const { data, error } = await sb.from("matches").select("id").limit(1);
      supabasePing = {
        status:     error ? "❌ error" : "✅ ok",
        rowsFound:  data ? data.length : 0,
        error:      error ? error.message : null,
      };
    } catch (e) {
      supabasePing = { status: "❌ exception", error: e.message };
    }
  }

  return res.status(200).json({
    timestamp:     new Date().toISOString(),
    nodeVersion:   process.version,
    env:           envStatus,
    footballApi:   apiPing,
    supabase:      supabasePing,
    syncEndpoint:  "/api/sync-matches",
    instructions:  "If any env shows ❌ MISSING, go to Vercel → Project → Settings → Environment Variables and add it, then redeploy.",
  });
};
