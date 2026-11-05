'use strict';
/* HOLDFAST client — no framework, no build step. */
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) {
      try { return JSON.parse(localStorage.getItem('holdfast:' + k) || 'null'); } catch { return null; }
    },
    set(k, v) { localStorage.setItem('holdfast:' + k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem('holdfast:' + k); },
  };

  const S = {
    code: null,
    token: null,
    name: '',
    state: null,
    alloc: [0, 0, 0, 0, 0],
    localDeadline: 0,
    lastRoundSeen: -1,
    submittedRound: -1,
    busy: false,
    pollMs: 900,
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* noop */ }
    if (!res.ok) throw new Error((data && (data.error || data.message)) || res.status);
    return data;
  }

  const toast = (msg) => { $('hint').textContent = msg; };

  /* ------------------------------- lobby ------------------------------- */
  let seatCount = 2;
  document.querySelectorAll('#seatPick button').forEach((b) => {
    b.addEventListener('click', () => {
      seatCount = Number(b.dataset.seats);
      document.querySelectorAll('#seatPick button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });

  $('btnCreate').addEventListener('click', async () => {
    const name = ($('createName').value || 'Commander').trim().slice(0, 18);
    try {
      const r = await api('/api/rooms', { method: 'POST', body: { name, seats: seatCount } });
      enter(r.code, r.you.token, name);
    } catch (e) { alert('Could not open a table: ' + e.message); }
  });

  $('btnSolo').addEventListener('click', async () => {
    const name = ($('createName').value || 'Commander').trim().slice(0, 18);
    try {
      const r = await api('/api/rooms', { method: 'POST', body: { name, seats: 2, vsBot: true } });
      enter(r.code, r.you.token, name);
    } catch (e) { alert('Could not start a match: ' + e.message); }
  });

  $('btnJoin').addEventListener('click', () => joinRoom($('joinCode').value, $('joinName').value));

  async function joinRoom(codeRaw, nameRaw) {
    const code = (codeRaw || '').trim().toUpperCase();
    if (code.length !== 5) return alert('A room code is 5 characters.');
    let name = (nameRaw || '').trim();
    if (!name) name = 'Player';
    try {
      const r = await api(`/api/rooms/${code}/join`, { method: 'POST', body: { name } });
      enter(code, r.token, name);
    } catch (e) {
      if (e.message === 'already_started') {
        alert('That match has already started. Ask the host for a fresh table.');
      } else alert('Join failed: ' + e.message);
    }
  }

  $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

  function enter(code, token, name) {
    S.code = code;
    S.token = token;
    S.name = name;
    store.set('session', { code, token, name });
    history.replaceState(null, '', '/?room=' + code);
    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    $('result').classList.add('hidden');
    $('roomCode').textContent = code;
    $('replayLink').href = `/api/rooms/${code}/replay`;
    S.lastRoundSeen = -1;
    poll(true);
  }

  /* ------------------------------- polling ------------------------------- */
  let pollTimer = null;
  async function poll(immediate) {
    clearTimeout(pollTimer);
    if (!S.code || !S.token) return;
    try {
      const st = await api(`/api/rooms/${S.code}/state?token=${S.token}`);
      apply(st);
      S.pollMs = 900;
    } catch (e) {
      S.pollMs = Math.min(6000, S.pollMs * 1.8);
      if (String(e.message).includes('room_not_found')) {
        toast('That table is gone. Returning to the lobby.');
        leave(false);
        return;
      }
    }
    pollTimer = setTimeout(() => poll(false), S.pollMs);
  }

  function apply(st) {
    S.state = st;
    const me = st.seats.find((s) => s.id === (st.you && st.you.seatId));
    S.status = st.status;

    if (st.status === 'lobby') {
      renderLobbyGame(st);
      return;
    }
    if (st.round !== S.lastRoundSeen) {
      if (st.round > S.lastRoundSeen) {
        S.alloc = [0, 0, 0, 0, 0];
        S.submittedRound = -1;
      }
      S.lastRoundSeen = st.round;
    }
    const localMsLeft = Math.max(0, st.deadline - Date.now());
    S.localDeadline = Date.now() + (st.status === 'playing' ? localMsLeft : Math.min(localMsLeft, 1200));

    renderScore(st, me);
    renderLanes(st, me);
    renderReveal(st, me);
    const moved = !!(me && me.moved);
    if (moved) S.submittedRound = st.round;
    $('roundNo').textContent = st.suddenDeath ? 'Sudden death' : 'Round ' + st.round;
    $('roundMeta').textContent =
      (st.suddenDeath ? 'of ' + st.maxRounds + ' · 1 troop · double points' : 'of ' + st.maxRounds + ' · ' + st.troops + ' troops' + (st.bank ? ' (1 banked)' : ''));
    refreshCommit(st, moved);
    $('hint').textContent = moved
      ? 'Troops committed. Reveal when everyone is in.'
      : st.status === 'reveal'
      ? 'Reveal — next round is coming.'
      : `Tap a strongpoint to add a troop. Hold one back to bank it for next round (cap ${st.bankCap}).`;

    if (st.status === 'done') renderResult(st);
  }

  function renderLobbyGame(st) {
    renderScore(st, null);
    $('roundNo').textContent = 'Waiting room';
    $('roundMeta').textContent = 'code ' + st.code;
    $('btnCommit').disabled = true;
    $('btnCommit').textContent = 'Start match';
    const seatsTaken = st.seats.filter((s) => !s.left).length;
    $('hint').textContent = `Share the code ${st.code} — ${seatsTaken} seat(s) filled. Starting fills the rest with bots.`;
    $('btnCommit').disabled = false;
  }

  function renderScore(st, me) {
    const box = $('scorebar');
    box.innerHTML = st.seats
      .filter((s) => !s.left || st.status === 'done')
      .map((s) => {
        const isMe = me && s.id === me.seatId;
        const kind = s.kind === 'bot' ? '<span class="badge bot">bot</span>'
          : s.kind === 'agent' ? '<span class="badge agent">agent</span>' : '';
        return `<div class="score ${isMe ? 'me' : ''}">
          <div class="nm">${esc(s.name)} ${kind}</div>
          <div class="pt">${s.total}</div>
          <div class="st">${st.status === 'playing' ? (s.moved ? 'ready' : 'thinking') : st.status}</div>
        </div>`;
      })
      .join('');
    $('resultScores').innerHTML = box.innerHTML;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderLanes(st, me) {
    const box = $('lanes');
    const last = st.lastRound;
    const reveal = st.status === 'reveal' || st.status === 'done';
    const myId = me ? me.seatId : null;
    box.innerHTML = st.points
      .map((pts, i) => {
        const mine = S.alloc[i];
        let enemyLine = '';
        let cls = '';
        if (last && reveal) {
          const others = last.entries.filter((e) => e.seatId !== myId);
          const theirBest = others.reduce((m, e) => Math.max(m, e.alloc[i]), 0);
          const mineRevealed = last.entries.find((e) => e.seatId === myId);
          const myShown = mineRevealed ? mineRevealed.alloc[i] : 0;
          const laneInfo = last.lanes[i];
          if (laneInfo.holder === myId) cls = 'won';
          else if (laneInfo.holder) cls = 'lost';
          enemyLine = `<div class="enemy">they sent ${theirBest === 1 ? 1 : theirBest}${laneInfo.tie ? ' · tie, nobody scores' : ''}${laneInfo.holder === myId ? ' · you hold' : laneInfo.holder ? ' · they hold' : ''}${laneInfo.overrun ? ' · overrun' : ''}${laneInfo.fortified ? ' · fortified' : ''}</div>`;
          if (laneInfo.points) {
            enemyLine += `<div class="pts">+${laneInfo.points}</div>`;
          }
        } else {
          enemyLine = `<div class="enemy unknown">hidden</div>`;
        }
        const pips = [0, 1, 2]
          .slice(0, Math.max(st.troops, 1))
          .map((n) => `<div class="pip ${n < mine ? 'filled' : ''}">${n < mine ? n + 1 : ''}</div>`)
          .join('');
        return `<div class="lane ${cls} ${mine ? 'mine' : ''}" data-lane="${i}">
          <div class="val">Strongpoint <b>${pts}</b></div>
          <div class="pips">${pips}</div>
          ${enemyLine}
          <span class="plus">+</span>
        </div>`;
      })
      .join('');

    box.querySelectorAll('.lane').forEach((el) => {
      el.addEventListener('click', (e) => {
        const i = Number(el.dataset.lane);
        if (e.shiftKey || e.altKey) return bump(i, -1);
        const used = S.alloc.reduce((a, b) => a + b, 0);
        if (used >= st.troops) return bump(i, -1);
        bump(i, +1);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        bump(Number(el.dataset.lane), -1);
      });
    });
  }

  function refreshCommit(st, moved) {
    const spent = S.alloc.reduce((a, b) => a + b, 0);
    const left = st.troops - spent;
    $('troopsLeft').textContent = left;
    $('btnCommit').disabled = moved || st.status !== 'playing' || S.busy;
    $('btnCommit').textContent = moved
      ? 'Committed — waiting'
      : left === 0
      ? 'Commit ' + st.troops + ' troops'
      : 'Commit · bank ' + Math.min(left, st.bankCap);
  }

  function bump(i, delta) {
    const st = S.state;
    if (!st || st.status !== 'playing') return;
    const me = st.seats.find((s) => s.id === (st.you && st.you.seatId));
    if (me && me.moved) return;
    const used = S.alloc.reduce((a, b) => a + b, 0);
    const next = S.alloc.slice();
    next[i] = Math.max(0, Math.min(st.troops, next[i] + delta));
    if (next.reduce((a, b) => a + b, 0) > st.troops) return;
    S.alloc = next;
    renderLanes(st, me);
    refreshCommit(st, false);
  }

  $('btnClear').addEventListener('click', () => {
    S.alloc = [0, 0, 0, 0, 0];
    if (S.state) {
      renderLanes(S.state, S.state.seats.find((x) => x.id === (S.state.you && S.state.you.seatId)));
      refreshCommit(S.state, false);
    }
  });

  function renderReveal(st, me) {
    const box = $('reveal');
    const last = st.lastRound;
    if (!last || (st.status !== 'reveal' && st.status !== 'done')) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const myId = me ? me.seatId : null;
    const rows = st.points
      .map((pts, i) => {
        const mine = (last.entries.find((e) => e.seatId === myId) || { alloc: [] }).alloc[i] || 0;
        const others = last.entries.filter((e) => e.seatId !== myId);
        const theirs = others.map((e) => e.alloc[i]).join(' / ');
        const lane = last.lanes[i];
        const who = !lane.holder ? (lane.tie ? 'tied' : 'empty') : lane.holder === myId ? 'you' : 'them';
        return `<div class="row">
          <div class="a">${mine}</div>
          <div class="mid">${pts} pts · ${who}${lane.points ? ` <span class="gain">+${lane.points}</span>` : ''}</div>
          <div class="b">${theirs || '0'}</div>
        </div>`;
      })
      .join('');
    box.innerHTML = `<h4>Round ${last.round} reveal · your troops vs theirs</h4>${rows}`;
  }

  $('btnCommit').addEventListener('click', async () => {
    const st = S.state;
    if (!st) return;
    if (st.status === 'lobby') return startMatch();
    if (S.busy) return;
    S.busy = true;
    try {
      await api(`/api/rooms/${S.code}/move`, {
        method: 'POST',
        body: { token: S.token, alloc: S.alloc },
      });
      await poll(true);
    } catch (e) {
      toast('Move rejected: ' + e.message);
    } finally {
      S.busy = false;
    }
  });

  async function startMatch() {
    try {
      await api(`/api/rooms/${S.code}/start`, { method: 'POST', body: { token: S.token } });
      S.lastRoundSeen = -1;
      poll(true);
    } catch (e) { toast('Could not start: ' + e.message); }
  }

  function renderResult(st) {
    $('game').classList.add('hidden');
    $('result').classList.remove('hidden');
    const me = st.seats.find((s) => s.id === (st.you && st.you.seatId));
    const winner = st.winner ? st.seats.find((s) => s.id === st.winner) : null;
    $('resultTitle').textContent = winner
      ? winner.id === (me && me.seatId) ? 'You hold the field.' : `${winner.name} holds the field.`
      : 'Stalemate — nobody holds the field.';
    renderScore(st, me);
    loadReplay();
  }

  async function loadReplay() {
    try {
      const r = await api(`/api/rooms/${S.code}/replay`);
      $('replayBox').innerHTML = r.rounds
        .map((rd) => {
          const lanes = rd.lanes
            .map((l) => `${l.lane + 1}:${l.holder ? l.holder + '+ ' + l.points : l.tie ? 'tie' : '—'}`)
            .join(' · ');
          const ents = rd.entries.map((e) => `${e.seatId}[${e.alloc.join('')}]`).join(' ');
          return `<div class="rr"><b>Round ${rd.round}${rd.suddenDeath ? ' (sudden death)' : ''}</b> ${esc(ents)}<br>${esc(lanes)}</div>`;
        })
        .join('');
    } catch { /* ignore */ }
  }

  $('btnAgain').addEventListener('click', () => { leave(true); });

  $('btnLeave').addEventListener('click', () => leave(true));

  async function leave(goLobby) {
    clearTimeout(pollTimer);
    if (S.code && S.token) {
      try { await api(`/api/rooms/${S.code}/leave`, { method: 'POST', body: { token: S.token } }); } catch { /* ignore */ }
    }
    store.del('session');
    S.code = null; S.token = null; S.state = null;
    history.replaceState(null, '', '/');
    if (goLobby !== false) {
      $('game').classList.add('hidden');
      $('result').classList.add('hidden');
      $('lobby').classList.remove('hidden');
      $('btnCommit').disabled = true;
    }
  }

  /* --------------------------- local countdown --------------------------- */
  setInterval(() => {
    const st = S.state;
    if (!st) return;
    if (st.status !== 'playing') return;
    const left = Math.max(0, Math.round((S.localDeadline - Date.now()) / 1000));
    $('timerText').textContent = left + 's';
    const total = st.suddenDeath ? 15 : 20;
    $('timerFill').style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
  }, 250);

  /* ------------------------------- boot ------------------------------- */
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  const saved = store.get('session');
  if (saved && saved.code && saved.token && (!roomParam || roomParam.toUpperCase() === saved.code)) {
    enter(saved.code, saved.token, saved.name);
  } else if (roomParam) {
    $('joinCode').value = roomParam.toUpperCase();
    $('joinName').focus();
  }
})();
