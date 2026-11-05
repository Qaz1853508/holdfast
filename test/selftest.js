'use strict';
/** Rule-level self-test. Run: node test/selftest.js */
const E = require('../src/engine');
const bot = require('../src/bot');

let passed = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('ok  ' + name); }
  else { fails.push(name + (extra ? ' — ' + extra : '')); console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
const zeros = () => E.emptyAlloc();

// 1. move space
check('legal move count for 3 troops is 56', E.legalMoves(3).length === 56, String(E.legalMoves(3).length));
check('legal move count for 4 troops is 126', E.legalMoves(4).length === 126, String(E.legalMoves(4).length));

// 2. validation
check('partial spend is legal (banking)', E.isValidAlloc([1, 1, 0, 0, 0], 3));
check('overspend is rejected', !E.isValidAlloc([1, 1, 1, 1, 0], 3));
check('negative troops are rejected', !E.isValidAlloc([-1, 1, 1, 0, 0], 3));
check('wrong lane count is rejected', !E.isValidAlloc([1, 1, 1], 3));

// 3. majority takes the lane
{
  const r = E.resolveRound(
    [{ seatId: 'a', alloc: [2, 1, 0, 0, 0] }, { seatId: 'b', alloc: [1, 0, 0, 0, 0] }],
    { a: zeros(), b: zeros() }
  );
  check('majority takes lane 0 and lane 1', r.gains.a === 5 && r.gains.b === 0, JSON.stringify(r.gains));
  check('overrun fires on 3-vs-empty', E.resolveRound(
    [{ seatId: 'a', alloc: [3, 0, 0, 0, 0] }, { seatId: 'b', alloc: [0, 0, 0, 0, 0] }],
    { a: zeros(), b: zeros() }
  ).lanes[0].overrun === true);
  check('overrun adds exactly one point', E.resolveRound(
    [{ seatId: 'a', alloc: [3, 0, 0, 0, 0] }, { seatId: 'b', alloc: [0, 0, 0, 0, 0] }],
    { a: zeros(), b: zeros() }
  ).gains.a === 4);
}

// 4. ties
{
  const nohist = E.resolveRound(
    [{ seatId: 'a', alloc: [1, 0, 0, 0, 0] }, { seatId: 'b', alloc: [1, 0, 0, 0, 0] }],
    { a: zeros(), b: zeros() }
  );
  check('a tie with no defender scores nobody', nohist.lanes[0].tie === true && nohist.gains.a === 0 && nohist.gains.b === 0);

  const defended = E.resolveRound(
    [{ seatId: 'a', alloc: [1, 0, 0, 0, 0] }, { seatId: 'b', alloc: [1, 0, 0, 0, 0] }],
    { a: [1, 0, 0, 0, 0], b: zeros() }
  );
  check('a tie goes to the side that held it (fortified)', defended.lanes[0].holder === 'a' && defended.gains.a === 3);
  check('fortification awards the base value only', defended.gains.a === 3);
}

// 5. banking
{
  const room = E.createRoom('TST01', [{ id: 's1', name: 'A', kind: 'human', left: false }, { id: 's2', name: 'B', kind: 'bot', left: false }]);
  E.startRound(room, Date.now());
  check('round 1 gives 3 troops', room.troopsFor.s1 === 3);
  E.submitMove(room, 's1', [2, 0, 0, 0, 0]);
  E.submitMove(room, 's2', [1, 1, 1, 0, 0]);
  E.resolveCurrent(room);
  check('unspent troop is banked', room.bank.s1 === 1, JSON.stringify(room.bank));
  E.startRound(room, Date.now());
  check('banked troop is available next round', room.troopsFor.s1 === 4, String(room.troopsFor.s1));
  E.submitMove(room, 's1', [1, 1, 1, 1, 0]);
  E.submitMove(room, 's2', [1, 1, 1, 0, 0]);
  E.resolveCurrent(room);
  check('bank is rebuilt from the unspent remainder', room.bank.s1 === 0, JSON.stringify(room.bank));
  E.startRound(room, Date.now());
  E.submitMove(room, 's1', [0, 0, 0, 0, 0]);
  E.submitMove(room, 's2', [0, 0, 0, 0, 0]);
  E.resolveCurrent(room);
  check('bank is capped at one troop', room.bank.s1 === 1, JSON.stringify(room.bank));
}

// 6. full matches
{
  const play = (seats) => {
    const room = E.createRoom('TST02', seats);
    E.startRound(room, Date.now());
    let guard = 0;
    while (room.status !== 'done' && guard++ < 20) {
      for (const s of E.aliveSeats(room)) {
        if (!room.pending[s.id]) E.submitMove(room, s.id, bot.chooseMove(room, s.id));
      }
      E.resolveCurrent(room);
      if (room.status !== 'done') E.startRound(room, Date.now());
    }
    return room;
  };
  const two = play([
    { id: 's1', name: 'A', kind: 'bot', left: false },
    { id: 's2', name: 'B', kind: 'bot', left: false },
  ]);
  check('2-player match finishes', two.status === 'done' && !!two.winner, two.status);
  check('2-player match has 8 or 9 rounds', two.round === 8 || two.round === 9, String(two.round));

  const four = play(['s1', 's2', 's3', 's4'].map((id) => ({ id, name: id, kind: 'bot', left: false })));
  check('4-player match finishes', four.status === 'done');
  check('4-player totals are non-negative', Object.values(four.totals).every((v) => v >= 0));
}

// 7. sudden death doubles points
{
  const room = E.createRoom('TST03', [{ id: 's1', name: 'A', left: false }, { id: 's2', name: 'B', left: false }]);
  room.round = room.maxRounds;
  room.status = 'playing';
  room.suddenDeath = true;
  room.multiplier = 2;
  room.troopsFor = { s1: 1, s2: 1 };
  room.pending = {};
  E.submitMove(room, 's1', [1, 0, 0, 0, 0]);
  E.submitMove(room, 's2', [0, 0, 0, 0, 0]);
  E.resolveCurrent(room);
  check('sudden death doubles the lane value', room.totals.s1 === 6, String(room.totals.s1));
}

// 8. the bot always returns a legal move
{
  const room = E.createRoom('TST04', [{ id: 's1', name: 'A', left: false }, { id: 's2', name: 'B', left: false }]);
  E.startRound(room, Date.now());
  let legal = true;
  for (let i = 0; i < 300; i++) {
    const mv = bot.chooseMove(room, 's2');
    if (!E.isValidAlloc(mv, room.troopsFor.s2)) { legal = false; break; }
  }
  check('bot never proposes an illegal move', legal);
}

console.log(`\n${passed} checks passed${fails.length ? `, ${fails.length} failed:\n - ` + fails.join('\n - ') : ''}`);
process.exit(fails.length ? 1 : 0);
