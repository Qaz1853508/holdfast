'use strict';
/**
 * HOLDFAST — pure game engine (no I/O, deterministic given inputs).
 * Shared by server, bots and tests.
 *
 * Rules (one paragraph):
 * Five strongpoints worth 3/2/2/1/1 are contested over 8 rounds. Each round you
 * command 3 fresh troops plus up to 1 troop you banked last round, and you split
 * them in secret across the strongpoints; every side reveals at once. Whoever
 * commits strictly more troops takes the strongpoint and its points, and a tie
 * for the most takes nothing (the troops are burned). Unspent troops are banked
 * for the next round, one at most. Committing 3+ against an empty strongpoint is
 * an Overrun (+1); a strongpoint you have held for two rounds running is
 * Fortified (+1). Most points after 8 rounds wins; a draw goes to one
 * sudden-death round worth double.
 *
 * Why banking exists: without it, "one troop on each of the three richest
 * strongpoints" is unbeatable, because 3 troops can cover exactly the three
 * highest-value lanes and no counter can win more than one of them. Banking
 * lets a player who reads the pattern mass 4 troops and crack a flat spread, so
 * no single allocation dominates. test/balance.js checks this empirically.
 */

const POINTS = [3, 2, 2, 1, 1];
const ROUNDS = 8;
const TROOPS = 3;
const BANK_CAP = 1;
const LANES = POINTS.length;
const MOVE_SECONDS = 20;
const SUDDEN_TROOPS = 1;

function emptyAlloc() {
  return new Array(LANES).fill(0);
}

/** Spread `troops` as evenly as possible over the lanes (defensive default). */
function evenAlloc(troops) {
  const a = emptyAlloc();
  for (let i = 0; i < troops; i++) a[i % LANES] += 1;
  return a;
}

/** An allocation is legal when it spends between 0 and `troops` (the rest banks). */
function isValidAlloc(a, troops) {
  if (!Array.isArray(a) || a.length !== LANES) return false;
  let sum = 0;
  for (const v of a) {
    if (!Number.isInteger(v) || v < 0 || v > troops) return false;
    sum += v;
  }
  return sum >= 0 && sum <= troops;
}

/** All allocations spending at most `troops` (bots / tests). */
function legalMoves(troops) {
  const out = [];
  const cur = emptyAlloc();
  (function rec(i, left) {
    if (i === LANES - 1) {
      for (let v = 0; v <= left; v++) {
        cur[i] = v;
        out.push(cur.slice());
      }
      return;
    }
    for (let v = 0; v <= left; v++) {
      cur[i] = v;
      rec(i + 1, left - v);
    }
  })(0, troops);
  return out;
}

/**
 * Resolve one round.
 * @param {{seatId:string, alloc:number[]}[]} entries
 * @param {Object<string,number[]>} strengths  seatId -> consecutive holds per lane (before this round)
 * @param {number} multiplier  points multiplier (2 in sudden death)
 */
function resolveRound(entries, strengths, multiplier = 1) {
  const lanes = [];
  const gains = {};
  for (const e of entries) gains[e.seatId] = 0;
  const nextStrengths = {};
  for (const e of entries) nextStrengths[e.seatId] = emptyAlloc();

  for (let lane = 0; lane < LANES; lane++) {
    const base = POINTS[lane] * multiplier;
    let best = 0;
    for (const e of entries) best = Math.max(best, e.alloc[lane]);

    let holder = null;
    let fortified = false;
    if (best > 0) {
      const leaders = entries.filter((e) => e.alloc[lane] === best);
      if (leaders.length === 1) {
        holder = leaders[0];
      } else {
        // Fortified: on a tie for the most, the side that held this strongpoint
        // last round keeps it. Defender advantage, but no bonus points, so a
        // leader cannot snowball into an unassailable position.
        const defenders = leaders.filter(
          (e) => (strengths[e.seatId] ? strengths[e.seatId][lane] || 0 : 0) >= 1
        );
        if (defenders.length === 1) {
          holder = defenders[0];
          fortified = true;
        }
      }
    }

    const detail = {
      lane,
      base,
      top: best,
      holder: holder ? holder.seatId : null,
      tie: best > 0 && !holder,
      overrun: false,
      fortified: false,
      points: 0,
    };

    if (holder) {
      const prev = strengths[holder.seatId] ? strengths[holder.seatId][lane] || 0 : 0;
      const opponentsAllZero = entries.every(
        (e) => e.seatId === holder.seatId || e.alloc[lane] === 0
      );
      const overrun = best >= 3 && opponentsAllZero;
      const pts = base + (overrun ? 1 : 0);
      detail.overrun = overrun;
      detail.fortified = fortified || (prev >= 2 && false);
      detail.points = pts;
      gains[holder.seatId] += pts;
      nextStrengths[holder.seatId][lane] = prev + 1;
    }
    lanes.push(detail);
  }
  return { lanes, gains, strengths: nextStrengths };
}

/** Build a fresh room state. */
function createRoom(code, seats, opts = {}) {
  const ids = seats.map((s) => s.id);
  const totals = {};
  const strengths = {};
  const bank = {};
  const troopsFor = {};
  for (const id of ids) {
    totals[id] = 0;
    strengths[id] = emptyAlloc();
    bank[id] = 0;
    troopsFor[id] = TROOPS;
  }
  return {
    code,
    createdAt: Date.now(),
    status: 'lobby',
    round: 0,
    maxRounds: opts.maxRounds || ROUNDS,
    troops: TROOPS,
    bank,
    troopsFor,
    multiplier: 1,
    suddenDeath: false,
    seats: seats.map((s) => ({ ...s })),
    totals,
    strengths,
    history: [],
    pending: {},
    deadline: 0,
    winner: null,
    finishedAt: 0,
  };
}

function aliveSeats(room) {
  return room.seats.filter((s) => !s.left);
}

function startRound(room, now = Date.now()) {
  room.status = 'playing';
  room.round += 1;
  room.pending = {};
  for (const s of aliveSeats(room)) {
    room.troopsFor[s.id] = room.suddenDeath ? SUDDEN_TROOPS : TROOPS + (room.bank[s.id] || 0);
  }
  const dur = room.suddenDeath ? Math.min(MOVE_SECONDS, 15) : MOVE_SECONDS;
  room.deadline = now + dur * 1000;
}

function missingSeats(room) {
  return aliveSeats(room)
    .filter((s) => !room.pending[s.id])
    .map((s) => s.id);
}

function submitMove(room, seatId, alloc) {
  const seat = room.seats.find((s) => s.id === seatId);
  if (!seat || seat.left) return { ok: false, error: 'no_such_seat' };
  if (room.status !== 'playing') return { ok: false, error: 'not_playing' };
  if (room.pending[seatId]) return { ok: false, error: 'already_moved' };
  const troops = room.troopsFor[seatId] || TROOPS;
  if (!isValidAlloc(alloc, troops)) {
    return { ok: false, error: `invalid_alloc: spend 0..${troops} troops across ${LANES} lanes` };
  }
  room.pending[seatId] = alloc.slice();
  return { ok: true };
}

/** Fill every silent seat with a legal default (used on timeout). */
function autoFill(room, filler) {
  for (const id of missingSeats(room)) {
    room.pending[id] = filler(id, room.troopsFor[id] || TROOPS, room);
  }
}

/** Resolve the current round; returns a replay record. */
function resolveCurrent(room) {
  for (const s of aliveSeats(room)) {
    if (!room.pending[s.id]) room.pending[s.id] = evenAlloc(room.troopsFor[s.id] || TROOPS);
  }
  const entries = aliveSeats(room).map((s) => ({
    seatId: s.id,
    alloc: room.pending[s.id].slice(),
  }));
  const { lanes, gains, strengths } = resolveRound(entries, room.strengths, room.multiplier);
  for (const id of Object.keys(gains)) room.totals[id] += gains[id];
  room.strengths = strengths;

  // bank the unspent troops, up to the cap
  for (const e of entries) {
    if (room.suddenDeath) {
      room.bank[e.seatId] = 0;
      continue;
    }
    const spent = e.alloc.reduce((a, b) => a + b, 0);
    const available = room.troopsFor[e.seatId] || TROOPS;
    room.bank[e.seatId] = Math.max(0, Math.min(BANK_CAP, available - spent));
  }

  const record = {
    round: room.round,
    suddenDeath: room.suddenDeath,
    multiplier: room.multiplier,
    entries: entries.map((e) => ({ seatId: e.seatId, alloc: e.alloc })),
    lanes,
    gains,
    bank: { ...room.bank },
  };
  room.history.push(record);
  room.pending = {};

  const lastRegulationRound = room.round >= room.maxRounds && !room.suddenDeath;
  if (lastRegulationRound) {
    const ranked = rank(room);
    const top = ranked[0];
    const tied = ranked.filter((r) => r.total === top.total);
    if (tied.length > 1) {
      room.suddenDeath = true;
      room.multiplier = 2;
      room.troops = SUDDEN_TROOPS;
      record.draw = tied.map((t) => t.seatId);
    } else {
      room.status = 'done';
      room.winner = top.seatId;
      room.finishedAt = Date.now();
    }
  } else if (room.suddenDeath && room.round > room.maxRounds) {
    const ranked = rank(room);
    const clear = ranked.length > 1 ? ranked[0].total > ranked[1].total : ranked.length === 1;
    room.status = 'done';
    room.winner = clear ? ranked[0].seatId : null;
    room.finishedAt = Date.now();
  }
  return record;
}

function rank(room) {
  return aliveSeats(room)
    .map((s) => ({ seatId: s.id, total: room.totals[s.id] }))
    .sort((a, b) => b.total - a.total);
}

function publicState(room, forSeatId = null, now = Date.now()) {
  const reveal = room.history.length ? room.history[room.history.length - 1] : null;
  const standings = rank(room);
  return {
    code: room.code,
    status: room.status,
    round: room.round,
    maxRounds: room.maxRounds,
    troops: room.suddenDeath ? SUDDEN_TROOPS : room.troopsFor[forSeatId] || TROOPS,
    bank: room.bank[forSeatId] || 0,
    points: POINTS,
    bankCap: BANK_CAP,
    multiplier: room.multiplier,
    suddenDeath: room.suddenDeath,
    deadline: room.deadline,
    msLeft: Math.max(0, room.deadline - now),
    seats: room.seats.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      left: !!s.left,
      total: room.totals[s.id],
      bank: room.bank[s.id] || 0,
      troops: room.suddenDeath ? SUDDEN_TROOPS : room.troopsFor[s.id] || TROOPS,
      moved: !!room.pending[s.id],
      standing: standings.findIndex((r) => r.seatId === s.id) + 1,
    })),
    lastRound: reveal,
    winner: room.winner,
  };
}

module.exports = {
  POINTS,
  ROUNDS,
  TROOPS,
  BANK_CAP,
  LANES,
  MOVE_SECONDS,
  SUDDEN_TROOPS,
  emptyAlloc,
  evenAlloc,
  isValidAlloc,
  legalMoves,
  resolveRound,
  createRoom,
  startRound,
  submitMove,
  autoFill,
  resolveCurrent,
  missingSeats,
  aliveSeats,
  publicState,
  rank,
};
