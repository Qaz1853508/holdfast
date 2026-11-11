# HOLDFAST

A 10-minute turn-based strongpoint game where **a human and an AI agent can sit in the same match**, built for the Taskmarket "human + agent shared-match" brief.

- **Play:** `https://4f88febbb9f425.lhr.life`  (paste a link, get a 5-character room code, share it)
- **Code:** plain Node.js 18+, **zero runtime dependencies**, one process, no build step
- **API:** `GET /api/rules` · `docs/API.md` · a working example agent in `bots/agent-bot.js`

---

## The game in one paragraph

Five strongpoints worth **3 / 2 / 2 / 1 / 1** are contested over **8 rounds**. Each round you command **3 fresh troops plus up to 1 you banked last round**, and you split them in secret across the strongpoints; everyone reveals at once. Whoever commits **strictly more** troops takes the strongpoint and its points, and a tie for the most takes **nothing** — unless one of the tied sides held it last round, which keeps it (**Fortified**, base points only). Putting **3 or more** troops on a strongpoint nobody else touches is an **Overrun** (+1). Unspent troops are **banked** for the next round, one at most. Most points after 8 rounds wins; a draw goes to **one sudden-death round worth double**.

### Why banking exists (design note)

The first version of the rules had no banking, and it was broken: with 3 troops and five lanes worth 3/2/2/1/1, "one troop on each of the three richest strongpoints" (`1,1,1,0,0`) covers exactly the three highest-value lanes, and **no legal counter can win more than two of them** — a fixed strategy beat the reference bot 99.8% of the time. Banking fixes it: a player who reads the pattern can hold a troop and arrive with 4, which is enough to break a flat spread by taking two strongpoints outright.

`test/balance.js` is the empirical check, not an opinion. Every fixed strategy plays the reference bot 400 times:

| Fixed strategy | Win rate vs bot |
| --- | --- |
| flat `1,1,1` | 56% |
| flat `1,1,1,1` (4 troops) | 56% |
| burst `2,2` (4 troops) | 56% |
| top-two `2,1` | 40% |
| all-in `3,0,0,0,0` | 32% |
| uniformly random | 1% |

Nothing a player can set and forget clears ~56%, and every strategy that wins big can be countered: `flat 1,1,1` wins 100% against `all-in`, and `3,0,0,0,0` loses 100% against `flat 1,1,1`. That counter-play is the point — the game is a reading contest, not a spreadsheet.

## Human and agent in one match

The brief asks for a match where a person and an AI agent play each other, so the two are first-class citizens of the same room:

- A seat carries a `kind`: `human`, `agent` or `bot`. The server does not care which is which — same endpoints, same rules, same clock.
- The clock is the only thing that differs in spirit: **20 seconds per round**, so an agent must answer inside the same window a person does.
- Agents talk to the game over plain HTTP + JSON. `bots/agent-bot.js` is a complete, dependency-free example: it joins a room, waits for its turn, computes an allocation and commits it. ~120 lines.
- A missing player never stalls the table: seats that go silent are filled by the reference bot on the deadline, and disconnected seats can be taken over.

## Architecture

```
src/engine.js   pure rules: resolveRound, createRoom, startRound, submitMove,
                resolveCurrent, publicState — no I/O, fully unit-testable
src/bot.js      reference opponent: best response to a model of your last rounds
src/server.js   zero-dependency HTTP server: REST + static hosting + round clock
public/         lobby, board, reveal, replay — vanilla JS, no framework
test/selftest.js 23 rule-level checks (node test/selftest.js)
test/balance.js  empirical "no dominant strategy" probe (node test/balance.js)
test/e2e.js      full HTTP match over the real endpoints (node test/e2e.js)
bots/agent-bot.js  a complete agent client
```

State is in memory: a room is a plain object, deleted after it finishes. No database, no accounts, nothing to migrate — the whole service is one `node src/server.js`.

## Run it

```bash
node src/server.js          # http://localhost:8080
node test/selftest.js       # 23 checks
node test/balance.js 400    # balance probe
node test/e2e.js            # full match through the HTTP API
node bots/agent-bot.js      # an agent plays a bot end to end
```

## API (short version)

```bash
# 1. open a table (2-4 seats). vsBot:true starts immediately against the reference bot
curl -s -X POST localhost:8080/api/rooms -H 'content-type: application/json' \
     -d '{"name":"Ada","seats":2}'
# -> {"code":"45YR7","you":{"seatId":"s1","token":"..."}}

# 2. join from another process (an agent, another browser, curl)
curl -s -X POST localhost:8080/api/rooms/45YR7/join -H 'content-type: application/json' \
     -d '{"name":"Fuller","kind":"agent"}'

# 3. the host starts, then everyone reads state and commits
curl -s -X POST localhost:8080/api/rooms/45YR7/start -H 'content-type: application/json' -d '{"token":"..."}'
curl -s 'localhost:8080/api/rooms/45YR7/state?token=...'
curl -s -X POST localhost:8080/api/rooms/45YR7/move -H 'content-type: application/json' \
     -d '{"token":"...","alloc":[2,1,0,0,0]}'   # sum may be < troops: the rest banks
```

See `docs/API.md` for every field, including the `season`/replay shape.

## How I used AI, and where it stops

I used an AI assistant to write this codebase and to run the balance experiments; the game design, the banking rule and the balance targets are mine, and every claim in this README comes from a script in `test/` that a reviewer can rerun.

What is **not** automated: the reference bot is a heuristic, not a learned policy; there is no matchmaking, no accounts and no anti-cheat. An agent can play perfectly legally and still be a bad sport (it could stall until the clock fills its move) — the server resolves that by filling silent seats, not by judging intent.

## Limits, stated plainly

- In-memory state: a restart drops open rooms.
- No persistence, no leaderboard, no auth. Room codes are the only secret.
- One process. Fine for a shared-match demo; not a sharded service.
- The board is tuned for 2 players; 3-4 seats work and are tested, but the points split is balanced for two.
