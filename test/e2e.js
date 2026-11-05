'use strict';
/**
 * End-to-end test over the real HTTP API: one human-ish client and one agent client
 * play a full match in the same room.
 * Run: node test/e2e.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

const ok = (name, cond, extra = '') => {
  if (cond) console.log('ok  ' + name);
  else {
    failures++;
    console.log('FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function waitHealthy(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await call('GET', '/api/health');
      if (r.status === 200 && r.data.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), REVEAL_MS: '250' },
    stdio: 'ignore',
  });

  try {
    ok('server comes up', await waitHealthy());

    const rules = await call('GET', '/api/rules');
    ok('rules endpoint is public', rules.status === 200 && Array.isArray(rules.data.points));
    ok('rules mention banking', /bank/i.test(rules.data.summary));

    const created = await call('POST', '/api/rooms', { name: 'Host', seats: 2 });
    ok('room created', created.status === 201 && !!created.data.code, JSON.stringify(created.data));
    const code = created.data.code;
    const hostToken = created.data.you.token;

    const join = await call('POST', `/api/rooms/${code}/join`, { name: 'Agent', kind: 'agent' });
    ok('agent joins the same room', join.status === 201 && join.data.seatId === 's2', JSON.stringify(join.data));
    const agentToken = join.data.token;

    const full = await call('POST', `/api/rooms/${code}/join`, { name: 'Third' });
    ok('a third seat is refused in a 2-seat room', full.status === 409, String(full.status));

    const badStart = await call('POST', `/api/rooms/${code}/start`, { token: agentToken });
    ok('only the host can start', badStart.status === 403, String(badStart.status));

    const start = await call('POST', `/api/rooms/${code}/start`, { token: hostToken });
    ok('host starts the match', start.status === 200, JSON.stringify(start.data));

    let st = (await call('GET', `/api/rooms/${code}/state?token=${hostToken}`)).data;
    ok('match is playing round 1', st.status === 'playing' && st.round === 1, st.status);
    ok('each seat gets 3 troops', st.troops === 3 && st.bank === 0, `${st.troops}/${st.bank}`);
    ok('dealer hands out a deadline', st.msLeft > 0 && st.msLeft <= 20000, String(st.msLeft));

    const tooMany = await call('POST', `/api/rooms/${code}/move`, { token: hostToken, alloc: [2, 2, 2, 0, 0] });
    ok('overspending troops is rejected', tooMany.status === 400, String(tooMany.status));

    let loops = 0;
    let sawReveal = false;
    let hostCommits = 0;
    while (st.status !== 'done' && loops++ < 300) {
      if (st.status === 'playing') {
        const mine = st.seats.find((x) => x.id === 's1');
        if (!mine.moved) {
          const t = st.troops;
          const alloc = [t >= 1 ? 1 : 0, t >= 2 ? 1 : 0, 0, 0, 0];
          const moved = await call('POST', `/api/rooms/${code}/move`, { token: hostToken, alloc });
          ok(`host commit round ${st.round}`, moved.status === 200, JSON.stringify(moved.data));
          hostCommits++;
          if (hostCommits === 1) {
            const again = await call('POST', `/api/rooms/${code}/move`, { token: hostToken, alloc: [1, 0, 0, 0, 0] });
            ok('a second commit in the same round is refused', again.status === 409, String(again.status));
          }
          const theirs = await call('POST', `/api/rooms/${code}/move`, { token: agentToken, alloc: [0, 0, 1, 0, 0] });
          if (theirs.status !== 200) ok(`agent commit round ${st.round}`, false, JSON.stringify(theirs.data));
        }
      }
      if (st.lastRound) sawReveal = true;
      await sleep(120);
      st = (await call('GET', `/api/rooms/${code}/state?token=${hostToken}`)).data;
    }

    ok('match reaches a result', st.status === 'done', st.status);
    ok('a reveal was served to the clients', sawReveal);
    ok('winner is one of the seats', ['s1', 's2'].includes(st.winner), String(st.winner));

    const replay = await call('GET', `/api/rooms/${code}/replay`);
    ok('replay lists every round', replay.status === 200 && replay.data.rounds.length >= 8, String(replay.data && replay.data.rounds.length));
    ok('replay keeps allocations', replay.data.rounds.every((r) => r.entries.every((e) => e.alloc.length === 5)));

    const idx = await fetch(BASE + '/');
    ok('static client is served', idx.status === 200 && /HOLDFAST/i.test(await idx.text()));

    const badToken = await call('GET', `/api/rooms/${code}/state?token=nope`);
    ok('a bad token is refused', badToken.status === 403, String(badToken.status));

    const missing = await call('GET', '/api/rooms/ZZZZZ/state?token=nope');
    ok('an unknown room is a 404', missing.status === 404, String(missing.status));
  } finally {
    server.kill('SIGTERM');
  }

  console.log(failures ? `\n${failures} e2e check(s) failed` : '\nall e2e checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('e2e crashed:', e);
  process.exit(1);
});
