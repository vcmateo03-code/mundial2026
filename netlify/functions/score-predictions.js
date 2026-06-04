/**
 * score-predictions.js
 * Netlify Scheduled Function — runs every 5 minutes.
 *
 * Finds all FT matches that have unscored predictions, calculates points,
 * updates predictions.points_awarded, and recalculates users.total_points.
 *
 * Scoring rules:
 *   +5  exact score
 *   +2  correct result, score off by exactly 1 goal on either side
 *   +0  everything else
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function calcPoints(predHome, predAway, actHome, actAway) {
  if (actHome === null || actAway === null) return null; // match not finished

  // Exact score
  if (predHome === actHome && predAway === actAway) return 5;

  // Result direction
  const predResult = Math.sign(predHome - predAway); // 1 = home win, 0 = draw, -1 = away win
  const actResult  = Math.sign(actHome  - actAway);

  if (predResult !== actResult) return 0; // wrong result — 0 pts

  // Correct result: check if off by exactly 1 on either side
  const homeDiff = Math.abs(predHome - actHome);
  const awayDiff = Math.abs(predAway - actAway);

  if ((homeDiff === 1 && awayDiff === 0) ||
      (homeDiff === 0 && awayDiff === 1) ||
      (homeDiff === 1 && awayDiff === 1)) {
    return 2;
  }

  return 0;
}

exports.handler = async function() {
  console.log("[score-predictions] Running at", new Date().toISOString());

  try {
    // Get all FT matches
    const { data: ftMatches, error: matchErr } = await supabase
      .from("matches")
      .select("id, home_score, away_score, status")
      .eq("status", "FT")
      .not("home_score", "is", null);

    if (matchErr) throw matchErr;
    if (!ftMatches || ftMatches.length === 0) {
      console.log("[score-predictions] No FT matches found");
      return { statusCode: 200, body: JSON.stringify({ scored: 0 }) };
    }

    const matchIds = ftMatches.map(m => m.id);

    // Get unscored predictions for those matches
    const { data: preds, error: predErr } = await supabase
      .from("predictions")
      .select("id, user_id, match_id, predicted_home, predicted_away, points_awarded")
      .in("match_id", matchIds)
      .is("points_awarded", null);

    if (predErr) throw predErr;
    if (!preds || preds.length === 0) {
      console.log("[score-predictions] No unscored predictions found");
      return { statusCode: 200, body: JSON.stringify({ scored: 0 }) };
    }

    // Build match lookup
    const matchMap = {};
    for (const m of ftMatches) matchMap[m.id] = m;

    // Calculate points for each prediction
    const updates = [];
    const userPoints = {}; // user_id → delta points

    for (const pred of preds) {
      const match = matchMap[pred.match_id];
      if (!match) continue;

      const pts = calcPoints(pred.predicted_home, pred.predicted_away, match.home_score, match.away_score);
      if (pts === null) continue;

      updates.push({ id: pred.id, points_awarded: pts });
      userPoints[pred.user_id] = (userPoints[pred.user_id] || 0) + pts;
    }

    if (updates.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ scored: 0 }) };
    }

    // Batch update predictions
    for (const upd of updates) {
      await supabase
        .from("predictions")
        .update({ points_awarded: upd.points_awarded })
        .eq("id", upd.id);
    }

    // Recalculate total_points per user (sum all awarded predictions)
    const userIds = Object.keys(userPoints);
    for (const userId of userIds) {
      const { data: allPreds } = await supabase
        .from("predictions")
        .select("points_awarded")
        .eq("user_id", userId)
        .not("points_awarded", "is", null);

      const total = (allPreds || []).reduce((sum, p) => sum + (p.points_awarded || 0), 0);

      await supabase
        .from("users")
        .update({ total_points: total })
        .eq("id", userId);
    }

    console.log(`[score-predictions] Scored ${updates.length} predictions across ${userIds.length} users`);
    return {
      statusCode: 200,
      body: JSON.stringify({ scored: updates.length, usersUpdated: userIds.length })
    };

  } catch (err) {
    console.error("[score-predictions] Error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
