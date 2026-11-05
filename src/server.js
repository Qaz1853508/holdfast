'use strict';
/**
 * HOLDFAST server — zero dependencies (Node 22 builtins only).
 *
 * Human play:  browser at /  (create/join a room with a 5-char code)
 * Agent play:  plain HTTP + JSON, see API.md
 *
 *   POST /api/rooms                 {name, seats?}      -> {code, you:{seatId,token}}
 *   POST /api/rooms                 {name, vsBot:true}  -> instantly starts a 2-seat game
 *   POST /api/rooms/:code/join      {name}              -> {seatId, token}
 *   GET  /api/rooms/:code/state?token=                  -> public state + your seat
 *   POST /api/rooms/:code/move      {token, alloc[5]}   -> {ok:true}
 *   POST /api/rooms/:code/start     {token}             -> fills empty seats with bots
 *   GET  /api/rooms/:code/replay                        -> full round-by-round log
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./engine');
const bot = require('./bot');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, '..', 'public');
const ROOM_TTL = 3 * 3600 * 1000;
const REVEAL_MS = Number(process.env.REVEAL_MS || 2200); // how long the reveal stays on screen before the next round

/** @type {Map<string, any>} */
const rooms = new Map();

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
const token = () => crypto.randomBytes(12).toString('hex');

function seatName(seat) {
  return seat.name;
}

function createRoom(name, seats = 2, kind = 'human') {
  const code = newCode();
  const roster = [];
  for (let i = 0; i < seats; i++) {
    roster.push({
      id: 's' + (i + 1),
      name: i === 0 ? name : 'Seat ' + (i + 1),
      kind: i === 0 ? kind : 'open',
      token: i === 0 ? token() : null,
      isBot: false,
      left: false,
    });
  }
  const room = E.createRoom(code, roster);
  room.hostSeat = 's1';
  room.tickAt = 0;
  room.revealUntil = 0;
  room.botPlan = {};
  rooms.set(code, room);
  return room;
}

function fillBots(room) {
  const names = ['Fuller', 'Bishop', 'Kestrel', 'Marlow'];
  let n = 0;
  for (const s of room.seats) {
    if (!s.token) {
      s.name = names[n++ % names.length] + (n > 4 ? ' ' + n : '');
      s.kind = 'bot';
      s.isBot = true;
      s.token = token();
    }
  }
  return room;
}

function beginGame(room, now = Date.now()) {
  fillBots(room);
  room.status = 'playing';
  E.startRound(room, now);
  planBots(room, now);
  return room;
}

function planBots(room, now) {
  room.botPlan = {};
  for (const s of room.seats) {
    if (!s.isBot || s.left) continue;
    room.botPlan[s.id] = now + 1400 + Math.random() * 3400;
  }
}

function botMove(room, seatId) {
  const alloc = bot.chooseMove(room, seatId);
  E.submitMove(room, seatId, alloc);
}

function tick(now) {
  for (const [code, room] of rooms) {
    if (room.status === 'lobby') continue;

    if (room.status === 'playing') {
      // bots think on their own clock
      for (const s of room.seats) {
        if (s.isBot && !s.left && !room.pending[s.id] && room.botPlan[s.id] <= now) {
          botMove(room, s.id);
        }
      }
      const humansMissing = E.missingSeats(room).some((id) => {
        const s = room.seats.find((x) => x.id === id);
        return s && !s.isBot;
      });
      const allIn = E.missingSeats(room).length === 0;
      const timedOut = now >= room.deadline;
      // if every human has moved and only bots are pending, let bots finish fast
      if (allIn || timedOut) {
        E.autoFill(room, (id) => bot.chooseMove(room, id));
        E.resolveCurrent(room);
        room.revealUntil = now + REVEAL_MS;
        if (room.status !== 'done') room.status = 'reveal';
        else room.status = 'done';
        continue;
      }
      if (!humansMissing && !allIn) {
        // everyone human is done: shorten the wait so the bots can answer
        for (const id of Object.keys(room.botPlan)) room.botPlan[id] = Math.min(room.botPlan[id], now + 600);
      }
      continue;
    }

    if (room.status === 'reveal' && now >= room.revealUntil) {
      if (room.round >= room.maxRounds + (room.suddenDeath ? 1 : 0) && room.suddenDeath) {
        room.status = 'done';
        continue;
      }
      room.status = 'playing';
      E.startRound(room, now);
      planBots(room, now);
      continue;
    }
  }
  // GC
  for (const [code, room] of rooms) {
    const last = Math.max(room.createdAt, room.finishedAt || 0, room.revealUntil || 0);
    if (now - last > ROOM_TTL) rooms.delete(code);
  }
}

/* ------------------------------- HTTP layer ------------------------------- */

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      if (!d) return resolve({});
      try {
        resolve(JSON.parse(d));
      } catch {
        resolve({ __bad: true });
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': rel === 'index.html' ? 'no-store' : 'public, max-age=60',
    });
    res.end(buf);
  });
}

function seatByToken(room, t) {
  if (!t) return null;
  return room.seats.find((s) => s.token === t) || null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  try {
    if (p === '/api/health') {
      return json(res, 200, {
        ok: true,
        rooms: rooms.size,
        uptime: Math.round(process.uptime()),
        version: '1.0.0',
      });
    }

    if (p === '/api/rules') {
      return json(res, 200, {
        points: E.POINTS,
        rounds: E.ROUNDS,
        troops: E.TROOPS,
        bankCap: E.BANK_CAP,
        moveSeconds: E.MOVE_SECONDS,
        summary:
          'Five strongpoints worth 3/2/2/1/1 are contested over 8 rounds. Each round you command 3 fresh troops plus up to 1 banked from last round, and split them in secret; everything reveals at once. Strictly more troops takes the strongpoint and its points, and a tie for the most takes nothing - unless one of the tied sides held it last round, which keeps it (Fortified, base points only). Spending 3+ on a strongpoint nobody else touches is an Overrun (+1). Unspent troops bank for next round, one at most. Most points after 8 rounds wins; a draw goes to one sudden-death round worth double.',
        api: {
          create: 'POST /api/rooms {name, seats, vsBot?}',
          join: 'POST /api/rooms/:code/join {name, kind?}',
          state: 'GET /api/rooms/:code/state?token=...',
          move: 'POST /api/rooms/:code/move {token, alloc:[5 ints], sum<=troops}',
          replay: 'GET /api/rooms/:code/replay',
        },
      });
    }

    if (p === '/api/rooms' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.__bad) return json(res, 400, { error: 'bad_json' });
      const name = String(b.name || 'Player').slice(0, 18);
      const seats = Math.max(2, Math.min(4, Number(b.seats) || 2));
      const room = createRoom(name, seats);
      if (b.vsBot) beginGame(room);
      return json(res, 201, {
        code: room.code,
        you: { seatId: 's1', token: room.seats[0].token, name },
        status: room.status,
        url: `/?room=${room.code}`,
        api: `/api/rooms/${room.code}/state?token=${room.seats[0].token}`,
      });
    }

    if (p === '/api/rooms' && req.method === 'GET') {
      const list = [...rooms.values()]
        .filter((r) => r.status === 'lobby')
        .map((r) => ({
          code: r.code,
          seats: r.seats.length,
          taken: r.seats.filter((s) => s.token).length,
        }));
      return json(res, 200, { rooms: list });
    }

    const m = p.match(/^\/api\/rooms\/([A-Z0-9]{5})(?:\/(join|state|move|start|replay|leave))?$/);
    if (m) {
      const room = rooms.get(m[1]);
      if (!room) return json(res, 404, { error: 'room_not_found' });
      const action = m[2] || 'state';

      if (action === 'state' && req.method === 'GET') {
        const rawToken = u.searchParams.get('token');
        const seat = seatByToken(room, rawToken);
        if (rawToken && !seat) return json(res, 403, { error: 'bad_token' });
        const st = E.publicState(room, seat ? seat.id : null);
        st.you = seat ? { seatId: seat.id, name: seat.name, kind: seat.kind } : null;
        st.suddenDeathPending = room.suddenDeath;
        return json(res, 200, st);
      }

      if (action === 'replay' && req.method === 'GET') {
        return json(res, 200, {
          code: room.code,
          seats: room.seats.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
          totals: room.totals,
          winner: room.winner,
          rounds: room.history,
        });
      }

      if (action === 'join' && req.method === 'POST') {
        const b = await readBody(req);
        if (room.status !== 'lobby') return json(res, 409, { error: 'already_started' });
        const free = room.seats.find((s) => !s.token);
        if (!free) return json(res, 409, { error: 'room_full' });
        free.token = token();
        free.name = String(b.name || 'Player').slice(0, 18);
        free.kind = b.kind === 'agent' ? 'agent' : 'human';
        return json(res, 201, { seatId: free.id, token: free.token, name: free.name, code: room.code, url: `/?room=${room.code}` });
      }

      if (action === 'start' && req.method === 'POST') {
        const b = await readBody(req);
        if (room.status !== 'lobby') return json(res, 409, { error: 'already_started' });
        const asker = seatByToken(room, b.token);
        if (!asker) return json(res, 403, { error: 'bad_token' });
        if (room.hostSeat && asker.id !== room.hostSeat) return json(res, 403, { error: 'not_host' });
        beginGame(room);
        return json(res, 200, { ok: true, status: room.status });
      }

      if (action === 'move' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.__bad) return json(res, 400, { error: 'bad_json' });
        const seat = seatByToken(room, b.token);
        if (!seat) return json(res, 403, { error: 'bad_token' });
        const preStatus = room.status;
        const r = E.submitMove(room, seat.id, b.alloc);
        if (!r.ok) {
          const code = /already_moved|not_playing|not_seated|done/.test(r.error) ? 409 : 400;
          return json(res, code, { error: r.error, status: preStatus });
        }
        const resolvedNow = preStatus === 'playing' && room.status !== 'playing';
        return json(res, 200, {
          ok: true,
          round: room.round,
          resolved: resolvedNow,
          waiting: E.missingSeats(room).map((x) => x.id),
          status: room.status,
        });
      }

      if (action === 'leave' && req.method === 'POST') {
        const b = await readBody(req);
        const seat = seatByToken(room, b.token);
        if (!seat) return json(res, 403, { error: 'bad_token' });
        seat.left = true;
        if (!room.seats.some((s) => !s.left && !s.isBot && s.token)) room.status = 'done';
        return json(res, 200, { ok: true });
      }
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    return serveStatic(req, res, p);
  } catch (err) {
    return json(res, 500, { error: 'server_error', message: String(err && err.message) });
  }
});

setInterval(() => {
  try {
    tick(Date.now());
  } catch (e) {
    console.error('tick error', e);
  }
}, 250).unref?.();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`HOLDFAST listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = { server, rooms, createRoom, beginGame, tick };
