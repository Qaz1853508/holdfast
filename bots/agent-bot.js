'use strict';
/**
 * HOLDFAST sample agent bot — plays a full match over the public HTTP API.
 *
 *   node bots/agent-bot.js                       # opens its own table vs a bot
 *   node bots/agent-bot.js --join ABCDE --name Ada
 *
 * No dependencies: Node 18+ has global fetch.
 */

const BASE = process.env.HOLDFAST_URL || 'http://localhost:8080';

const arg = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || res.status);
  return data;
}

const POINTS = [3, 2, 2, 1, 1];

function legalMoves(troops) {
  const out = [];
  const cur = [0, 0, 0, 0, 0];
  const rec = (i, left) => {
    if (i === 4) { if (left <= troops) { cur[4] = left; out.push(cur.slice()); } return; }
    for (let v = 0; v <= Math.min(troops, left); v++) { cur[i] = v; rec(i + 1, left - v); }
  };
  rec(0, troops);
  return out;
}

/** Very small strategy: attack the lanes the opponents have been ignoring. */
function pickMove(state, meId) {
  const troops = state.troops;
  const means = POINTS.map(() => 1);
  const last = state.lastRound;
  if (last) {
    for (let i = 0; i < 5; i++) {
      const others = last.entries.filter((e) => e.seatId !== meId);
      means[i] = others.reduce((s, e) => s + e.alloc[i], 0) / Math.max(1, others.length);
    }
  }
  let best = null;
  for (const m of legalMoves(troops)) {
    let score = 0;
    for (let i = 0; i < 5; i++) {
      if (!m[i]) continue;
      const p = Math.max(0.05, Math.min(0.95, 1 - Math.exp(-m[i] / (means[i] + 0.4))));
      score += (POINTS[i] * state.multiplier) * p;
    }
    if (!best || score > best.score) best = { m, score };
  }
  return best.m;
}

(async () => {
  let code = arg('--join');
  let token;
  let meId;
  const name = arg('--name', 'Ada');

  if (code) {
    const r = await call('POST', `/api/rooms/${code.toUpperCase()}/join`, { name, kind: 'agent' });
    token = r.token;
    meId = r.seatId;
    code = r.code;
  } else {
    const r = await call('POST', `/api/rooms`, { name, seats: 2, vsBot: true });
    code = r.code;
    token = r.you.token;
    meId = r.you.seatId;
  }
  console.log(`seat ${meId} in room ${code} as ${name}`);

  let lastRound = -1;
  for (let guard = 0; guard < 600; guard++) {
    const st = await call('GET', `/api/rooms/${code}/state?token=${token}`);
    if (st.status === 'done') {
      const sorted = st.seats.slice().sort((a, b) => b.total - a.total);
      console.log('final:', sorted.map((s) => `${s.name}=${s.total}`).join(' '), '| winner:', st.winner);
      return;
    }
    if (st.status === 'playing' && st.round !== lastRound) {
      const me = st.seats.find((s) => s.id === meId);
      if (me && !me.moved) {
        const alloc = pickMove(st, meId);
        await call('POST', `/api/rooms/${code}/move`, { token, alloc });
        console.log(`round ${st.round}: sent [${alloc.join(' ')}]`);
        lastRound = st.round;
      }
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log('guard limit hit');
})().catch((e) => {
  console.error('bot failed:', e.message);
  process.exit(1);
});
