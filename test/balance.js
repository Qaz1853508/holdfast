'use strict';
/**
 * Balance probe: is there a single dominant strategy?
 * Every fixed strategy plays the reference bot; fixed strategies also play each
 * other round-robin. Run: node test/balance.js [gamesPerMatchup]
 */
const E = require('../src/engine');
const bot = require('../src/bot');

const T = (room, id) => (room.suddenDeath ? 1 : room.troopsFor[id] || room.troops);
const one = () => [1, 0, 0, 0, 0];

const FIXED = {
  'flat 1/1/1 (spend 3)': (room, id) => (T(room, id) >= 3 ? [1, 1, 1, 0, 0] : one()),
  'flat 1/1/1/1 (spend 4)': (room, id) => (T(room, id) >= 4 ? [1, 1, 1, 1, 0] : T(room, id) >= 3 ? [1, 1, 1, 0, 0] : one()),
  'burst 2/2 (spend 4)': (room, id) => (T(room, id) >= 4 ? [2, 2, 0, 0, 0] : T(room, id) >= 3 ? [1, 1, 1, 0, 0] : one()),
  'top-two 2/1 (spend 3)': (room, id) => (T(room, id) >= 3 ? [2, 1, 0, 0, 0] : one()),
  'all-in lane0': (room, id) => {
    const a = [0, 0, 0, 0, 0];
    a[0] = T(room, id);
    return a;
  },
  'spread low (1/1/0/0/1)': (room, id) => (T(room, id) >= 3 ? [1, 1, 0, 0, 1] : one()),
  random: (room, id, seed) => {
    const moves = E.legalMoves(T(room, id));
    return moves[Math.floor(seed() * moves.length)];
  },
};

function playGame(stratA, stratB, seed) {
  const seats = [
    { id: 's1', name: 'A', kind: 'bot', isBot: true, left: false },
    { id: 's2', name: 'B', kind: 'bot', isBot: true, left: false },
  ];
  const room = E.createRoom('BAL01', seats);
  E.startRound(room, Date.now());
  let guard = 0;
  while (room.status !== 'done' && guard++ < 20) {
    for (const s of E.aliveSeats(room)) {
      if (room.pending[s.id]) continue;
      const move = s.id === 's1' ? stratA(room, 's1', seed) : stratB(room, 's2', seed);
      const r = E.submitMove(room, s.id, move);
      if (!r.ok) throw new Error('illegal move from strategy: ' + r.error);
    }
    E.resolveCurrent(room);
    if (room.status !== 'done') E.startRound(room, Date.now());
  }
  return room.totals;
}

function rngFactory(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const games = Number(process.argv[2] || 400);
const names = Object.keys(FIXED);
const report = [];

for (const n of names) {
  let wins = 0;
  let draws = 0;
  let diff = 0;
  for (let g = 0; g < games; g++) {
    const seed = rngFactory(1000 + g);
    const t = playGame(
      (room, id, s) => FIXED[n](room, id, s),
      (room, id, s) => bot.chooseMove(room, id, s),
      seed
    );
    diff += t.s1 - t.s2;
    if (t.s1 > t.s2) wins++;
    else if (t.s1 === t.s2) draws++;
  }
  report.push({
    matchup: `${n} vs reference bot`,
    winRate: +(wins / games).toFixed(3),
    drawRate: +(draws / games).toFixed(3),
    avgMargin: +(diff / games).toFixed(2),
  });
}

for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    let wins = 0;
    let draws = 0;
    for (let g = 0; g < 200; g++) {
      const seed = rngFactory(5000 + g * 7 + i * 13 + j);
      const t = playGame(
        (r, id, s) => FIXED[names[i]](r, id, s),
        (r, id, s) => FIXED[names[j]](r, id, s),
        seed
      );
      if (t.s1 > t.s2) wins++;
      else if (t.s1 === t.s2) draws++;
    }
    report.push({
      matchup: `${names[i]} vs ${names[j]}`,
      winRate: +(wins / 200).toFixed(3),
      drawRate: +(draws / 200).toFixed(3),
      avgMargin: 0,
    });
  }
}

console.table(report);
const STRONG = ['flat 1/1/1 (spend 3)', 'flat 1/1/1/1 (spend 4)', 'burst 2/2 (spend 4)', 'top-two 2/1 (spend 3)', 'all-in lane0'];
const vsBot = report.filter((r) => r.matchup.includes('reference') && STRONG.some((n) => r.matchup.startsWith(n)));
const maxVsBot = Math.max(...vsBot.map((r) => r.winRate));
const minVsBot = Math.min(...vsBot.map((r) => r.winRate));
const fixedPairs = report.filter((r) => !r.matchup.includes('reference'));
const undefeated = fixedPairs.filter((r) => r.winRate >= 0.97 && (STRONG.some((n) => r.matchup.startsWith(n)) || r.matchup.includes(' vs ' + 'flat')));
console.log(`fixed strategies vs reference bot: best ${(maxVsBot * 100).toFixed(1)}% / worst ${(minVsBot * 100).toFixed(1)}%`);
console.log(`fixed-vs-fixed matchups won >=97%: ${undefeated.length ? undefeated.map((r) => r.matchup).join('; ') : 'none'}`);
const ok = maxVsBot <= 0.68 && minVsBot >= 0.22;
console.log(ok ? 'OK: no fixed strategy dominates the reference bot.' : 'WARNING: fixed strategy spread is too wide — retune.');
