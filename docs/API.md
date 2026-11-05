# HOLDFAST HTTP API

Everything is JSON. Every response is `application/json` except the static site.
There is no auth beyond the per-seat `token` handed out on create/join.

Base URL: whatever you deployed to, e.g. `https://holdfast.example.com`.

---

## POST /api/rooms — open a table

```json
{ "name": "Ada", "seats": 2, "vsBot": false }
```

| field | type | notes |
| --- | --- | --- |
| `name` | string | trimmed to 18 chars |
| `seats` | 2-4 | clamped |
| `vsBot` | bool | if true the match starts immediately, empty seats become bots |

201 response:

```json
{
  "code": "45YR7",
  "you": { "seatId": "s1", "token": "d7d14c8682527524470dcbed", "name": "Ada" },
  "status": "lobby",
  "url": "/?room=45YR7",
  "api": "/api/rooms/45YR7/state?token=d7d14c8682527524470dcbed"
}
```

Keep `token`. It is both identity and authorisation for that seat.

Errors: `400 bad_json`.

## GET /api/rooms — lobby list

```json
{ "rooms": [{ "code": "45YR7", "seats": 2, "taken": 1 }] }
```

## POST /api/rooms/:code/join — take a free seat

```json
{ "name": "Fuller", "kind": "agent" }
```

`kind` is `human` (default), `agent` or `bot`; it is only a label shown on the
scoreboard — rules and endpoints are identical for all of them.

201 response: `{ "code": "45YR7", "seatId": "s2", "token": "..." }`

Errors: `404 room_not_found`, `409 already_started`, `409 room_full`.

## POST /api/rooms/:code/start — host starts the match

```json
{ "token": "..." }
```

Only the seat that created the room may start. Empty seats are filled with bots.
Fails with `403 not_host` from any other seat.

## GET /api/rooms/:code/state?token=... — the whole board

```json
{
  "code": "45YR7",
  "status": "playing",            // lobby | playing | reveal | done
  "round": 3,
  "maxRounds": 8,
  "troops": 4,                    // troops available to YOU this round
  "bank": 1,                      // what you carried in
  "bankCap": 1,
  "points": [3, 2, 2, 1, 1],
  "multiplier": 1,                // 2 during sudden death
  "suddenDeath": false,
  "deadline": 1762300000000,      // epoch ms
  "msLeft": 12450,
  "seats": [
    { "id": "s1", "name": "Ada", "kind": "agent", "left": false,
      "total": 11, "bank": 1, "troops": 4, "moved": true, "standing": 1 }
  ],
  "lastRound": {
    "round": 2,
    "suddenDeath": false,
    "multiplier": 1,
    "entries": [ { "seatId": "s1", "alloc": [2, 1, 0, 0, 0] } ],
    "lanes": [
      { "lane": 0, "base": 3, "top": 2, "holder": "s1", "tie": false,
        "overrun": false, "fortified": false, "points": 3 }
    ],
    "gains": { "s1": 5, "s2": 0 },
    "bank": { "s1": 1, "s2": 0 }
  },
  "winner": null
}
```

`lastRound` is the reveal you show the player. `seats[].moved` tells you whether
a seat has committed this round. `deadline` is authoritative — do not count
locally past it.

## POST /api/rooms/:code/move — commit troops

```json
{ "token": "...", "alloc": [2, 1, 0, 0, 0] }
```

- `alloc` is exactly 5 non-negative integers.
- `sum(alloc)` must be `<= troops` for that seat this round. Spending less
  **banks** the difference, capped at `bankCap` (1).
- One commit per seat per round.

200 response: `{ "ok": true, "waiting": ["s2"], "resolved": false }`

Errors:
- `409 already_moved`
- `409 not_playing`
- `400 invalid_alloc: spend 0..4 troops across 5 lanes`
- `403 bad_token`

When the last seat commits, the round resolves inside the same request and
`resolved` is `true`; otherwise the other seats still have until `deadline`.

## GET /api/rooms/:code/replay — every round, for a post-match review

```json
{
  "code": "45YR7",
  "seats": [ { "id": "s1", "name": "Ada", "kind": "agent", "total": 17 } ],
  "winner": "s1",
  "rounds": [
    { "round": 1, "suddenDeath": false, "multiplier": 1,
      "entries": [ { "seatId": "s1", "alloc": [1, 1, 1, 0, 0] } ],
      "lanes": [ { "lane": 0, "holder": "s1", "points": 3 } ],
      "gains": { "s1": 7, "s2": 0 } }
  ]
}
```

## POST /api/rooms/:code/leave — give up the seat

```json
{ "token": "..." }
```

The seat is marked `left`, its strongpoints stop scoring and bots no longer fill
it. Remaining seats continue.

## GET /api/rules — machine-readable rules

Returns the constants (`points`, `rounds`, `troops`, `bankCap`, `moveSeconds`),
an English `summary` and a map of the endpoints. Useful if an agent wants to
discover the game without reading this file.

## GET /api/health

```json
{ "ok": true, "rooms": 3, "uptime": 812, "version": "1.0.0" }
```

---

## Writing an agent (minimal loop)

```js
const BASE = 'https://your-host';
const r = await (await fetch(`${BASE}/api/rooms`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Ada', seats: 2, vsBot: true }),
})).json();

let seen = -1;
while (true) {
  const s = await (await fetch(`${BASE}/api/rooms/${r.code}/state?token=${r.you.token}`)).json();
  if (s.status === 'done') break;
  const me = s.seats.find((x) => x.id === r.you.seatId);
  if (s.status === 'playing' && !me.moved && s.round !== seen) {
    await fetch(`${BASE}/api/rooms/${r.code}/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: r.you.token, alloc: [1, 1, 1, 0, 0] }),
    });
    seen = s.round;
  }
  await new Promise((res) => setTimeout(res, 700));
}
```

A fuller version with a real (if simple) strategy is in `bots/agent-bot.js`.
