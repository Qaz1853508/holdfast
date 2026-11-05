'use strict';
/**
 * Reference opponent ("Fuller").
 *
 * It plays a best response to a *model of your last few rounds*: for every legal
 * allocation, it simulates the round against each of the shapes you have used
 * lately (plus a flat prior before it knows anything), and keeps the allocation
 * that maximises its own points minus yours. A small amount of sampling keeps it
 * from becoming a predictable machine — which is the whole point of the game.
 */
const E = require('./engine');

const POINTS = E.POINTS;

const config = { noise: 0.18, blunder: 0.15, history: 3, bankChance: 0.75, bankSlack: 0.6 };

/** What a player with no information might do. */
function priors(troops) {
  const out = [
    [1, 1, 1, 0, 0],
    [2, 1, 0, 0, 0],
    [3, 0, 0, 0, 0],
    [1, 1, 0, 0, 1],
  ];
  if (troops >= 4) out.push([1, 1, 1, 1, 0], [2, 2, 0, 0, 0], [2, 1, 1, 0, 0]);
  return out.filter((a) => E.isValidAlloc(a, troops));
}

/** Shapes the opponents have actually played, most recent first. */
function recentShapes(room, meId, limit = config.history) {
  const shapes = [];
  for (let i = room.history.length - 1; i >= 0 && shapes.length < limit; i--) {
    const rd = room.history[i];
    for (const e of rd.entries) {
      if (e.seatId !== meId && e.alloc.some((v) => v > 0)) shapes.push(e.alloc);
    }
  }
  return shapes;
}

function opponentLaneMeans(room, meId) {
  const sums = new Array(E.LANES).fill(0);
  let n = 0;
  for (const rd of room.history) {
    for (const e of rd.entries) {
      if (e.seatId === meId) continue;
      for (let i = 0; i < E.LANES; i++) sums[i] += e.alloc[i];
      n++;
    }
  }
  return sums.map((s) => s / Math.max(1, n));
}

/** My points minus theirs if I play `mine` and they play `theirs`. */
function margin(room, meId, mine, theirs) {
  const oppId = '__opp__';
  const entries = [
    { seatId: meId, alloc: mine },
    { seatId: oppId, alloc: theirs },
  ];
  // Symmetric: neither side is credited with a streak it has not earned yet,
  // otherwise the bot over-values its own tempo and walks every fixed strategy.
  const strengths = { [meId]: E.emptyAlloc(), [oppId]: E.emptyAlloc() };
  const { gains } = E.resolveRound(entries, strengths, room.multiplier);
  return (gains[meId] || 0) - (gains[oppId] || 0);
}

function evaluate(room, meId, troops, models) {
  let best = null;
  for (const mine of E.legalMoves(troops)) {
    let total = 0;
    for (const m of models) total += margin(room, meId, mine, m);
    const score = total / models.length;
    if (!best || score > best.score) best = { alloc: mine, score };
  }
  return best;
}

function chooseMove(room, meId, rng = Math.random) {
  const available = room.suddenDeath ? 1 : room.troopsFor[meId] || room.troops;
  const shapes = recentShapes(room, meId);
  const models = shapes.length ? shapes.concat(priors(available)) : priors(available);

  // Compare spending everything with banking one troop for a heavier next round.
  const spendAll = evaluate(room, meId, available, models);
  let pick = spendAll;
  if (!room.suddenDeath && available > 1) {
    const bankOne = evaluate(room, meId, available - 1, models);
    // a banked troop is worth roughly one extra point of tempo next round
    if (bankOne.score >= spendAll.score - config.bankSlack && rng() < config.bankChance) pick = bankOne;
  }

  // a deliberate share of outright random moves: it keeps the bot beatable and
  // stops a human from farming one fixed pattern all game
  if (rng() < config.blunder) {
    const all = E.legalMoves(available);
    return all[Math.floor(rng() * all.length)];
  }
  if (rng() < config.noise) {
    const options = E.legalMoves(available)
      .map((m) => ({ alloc: m, score: models.reduce((acc, mm) => acc + margin(room, meId, m, mm), 0) / models.length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return options[Math.floor(rng() * options.length)].alloc;
  }
  return pick.alloc;
}

module.exports = { chooseMove, opponentLaneMeans, margin, config };
