/**
 * api/score-predictions.js
 * Vercel Cron Function — schedule: every 5 minutes (vercel.json)
 *
 * Finds FT matches with unscored predictions, calculates points,
 * updates predictions.points_awarded, recalculates users.total_points.
 *
 * Scoring:
 *   +5  exact score
 *   +2  correct result, score off by exactly 1 on either side
 *   +0  everything else
 */

const { createClient } = require("@supabase/supabase-js");

const supabase    = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CRON_SECRET = process.env.CRON_SECRET;

function calcPoints(predHome, predAway, actHome, actAway) {
  if (actHome === null || actAway === null) return null;

  // Exact score
  if (predHome === actHome && predAway === actAway) return 5;

  // Result direction
  const predResult = Math.sign(predHome - predAway);
  const actResult  = Math.sign(actHome  - actAway);
  if (predResult !== actResult) return 0;

  // Correct result: off by 1 on either side
  const homeDiff = Math.abs(predHome - actHome);
  const awayDiff = Math.abs(predAway - actAway);
  if ((homeDiff === 1 && awayDiff === 0) ||
      (homeDiff === 0 && awayDiff === 1) ||
      (homeDiff === 1 && awayDiff === 1)) return 2;

  return 0;
}

module.exports = async function handler(req, res) {
  // Verify Vercel cron secret
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[score-predictions] Running at", new Date().toISOString());

  try {
    // Get all finished matches with scores
    const { data: ftMatches, error: matchErr } = await supabase
      .from("matches")
      .select("id, home_score, away_score")
      .eq("status", "FT")
      .not("home_score", "is", null);

    if (matchErr) throw matchErr;
    if (!ftMatches || ftMatches.length === 0) {
      return res.status(200).json({ scored: 0 });
    }

    // Get unscored predictions for those matches
    const { data: preds, error: predErr } = await supabase
      .from("predictions")
      .select("id, user_id, match_id, predicted_home, predicted_away")
      .in("match_id", ftMatches.map(m => m.id))
      .is("points_awarded", null);

    if (predErr) throw predErr;
    if (!preds || preds.length === 0) {
      return res.status(200).json({ scored: 0 });
    }

    const matchMap = Object.fromEntries(ftMatches.map(m => [m.id, m]));
    const userPointDeltas = {};
    const updates = [];

    for (const pred of preds) {
      const match = matchMap[pred.match_id];
      if (!match) continue;
      const pts = calcPoints(pred.predicted_home, pred.predicted_away, match.home_score, match.away_score);
      if (pts === null) continue;
      updates.push({ id: pred.id, points_awarded: pts });
      userPointDeltas[pred.user_id] = (userPointDeltas[pred.user_id] || 0) + pts;
    }

    if (updates.length === 0) return res.status(200).json({ scored: 0 });

    // Write points to each prediction
    for (const upd of updates) {
      await supabase.from("predictions").update({ points_awarded: upd.points_awarded }).eq("id", upd.id);
    }

    // Recalculate each affected user's total from the full prediction set
    for (const userId of Object.keys(userPointDeltas)) {
      const { data: allPreds } = await supabase
        .from("predictions")
        .select("points_awarded")
        .eq("user_id", userId)
        .not("points_awarded", "is", null);

      const total = (allPreds || []).reduce((sum, p) => sum + (p.points_awarded || 0), 0);
      await supabase.from("users").update({ total_points: total }).eq("id", userId);
    }

    console.log(`[score-predictions] Scored ${updates.length} predictions, ${Object.keys(userPointDeltas).length} users updated`);
    return res.status(200).json({
      scored: updates.length,
      usersUpdated: Object.keys(userPointDeltas).length,
    });

  } catch (err) {
    console.error("[score-predictions] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
