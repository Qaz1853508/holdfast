'use strict';
const E = require('../src/engine');
const bot = require('../src/bot');

const T = (room, id) => (room.suddenDeath ? 1 : room.troopsFor[id] || room.troops);
const one = () => [1, 0, 0, 0, 0];
const FLAT = (room, id) => (T(room, id) >= 3 ? [1, 1, 1, 0, 0] : one());
const BURST = (room, id) => (T(room, id) >= 4 ? [2, 2, 0, 0, 0] : T(room, id) >= 3 ? [1, 1, 1, 0, 0] : one());
const RND = (room, id, seed) => { const m = E.legalMoves(T(room, id)); return m[Math.floor(seed() * m.length)]; };

function rngFactory(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

function game(a, b, seed) {
  const room = E.createRoom('T', [{ id: 's1', name: 'A', kind: 'bot', left: false }, { id: 's2', name: 'B', kind: 'bot', left: false }]);
  E.startRound(room, Date.now());
  let g = 0;
  while (room.status !== 'done' && g++ < 20) {
    for (const s of E.aliveSeats(room)) {
      if (room.pending[s.id]) continue;
      const mv = s.id === 's1' ? a(room, 's1', seed) : b(room, 's2', seed);
      const r = E.submitMove(room, s.id, mv);
      if (!r.ok) throw new Error(r.error);
    }
    E.resolveCurrent(room);
    if (room.status !== 'done') E.startRound(room, Date.now());
  }
  return room.totals;
}

const N = Number(process.argv[2] || 120);
const rows = [];
for (const blunder of [0.1, 0.15, 0.2, 0.25, 0.3]) {
  for (const hist of [2]) {
    bot.config.blunder = blunder; bot.config.history = hist;
    const out = {};
    for (const [nm, strat] of [['flat', FLAT], ['burst', BURST], ['random', RND]]) {
      let w = 0;
      for (let g = 0; g < N; g++) {
        const t = game((r, id, s) => strat(r, id, s), (r, id, s) => bot.chooseMove(r, id, s), rngFactory(900 + g));
        if (t.s1 > t.s2) w++;
      }
      out[nm] = +(w / N).toFixed(2);
    }
    rows.push({ blunder, hist, ...out });
  }
}
console.table(rows);
