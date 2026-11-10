import { BOARD_THEMES, GAME_MODES, MAX_PLAYERS, createGame, isValidGame, nextRound, playRoll, rollDie as fairDie, seatPlayers, setMode as switchMode, skipTurn, usePower } from './game.js';

export const GAME_PROTOCOL = 'refract-snakes-and-ladders/1';

const validId = (id) => Number.isSafeInteger(id) && id >= 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const syncToken = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function normalizePeople(people) {
  if (!Array.isArray(people)) return null;
  const seen = new Set();
  const result = [];
  for (const person of people) {
    if (!person || !validId(person.id) || seen.has(person.id)) return null;
    seen.add(person.id);
    result.push({
      id: person.id,
      name: typeof person.name === 'string' ? person.name : `Player ${person.id}`,
      avatarUrl: typeof person.avatarUrl === 'string' ? person.avatarUrl : null,
    });
  }
  return result;
}

function browserStorage() {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

// The host takes at most one theme change per second, so rapid switching cannot flood the
// relay (Refract allows about 20 messages a second) and drown out the rolls.
export const THEME_COOLDOWN_MS = 1000;

// Each player has TURN_MS to throw. After a roll the clock waits TURN_SETTLE_MS for the
// previous throw to land, and the host allows TURN_GRACE_MS for a throw already on its way.
export const TURN_MS = 15000;
export const TURN_SETTLE_MS = 3000;
export const TURN_GRACE_MS = 1500;

// A pending turn clock must never keep a Node process (such as the test runner) alive.
function defaultTimer(run, ms) {
  const timer = setTimeout(run, ms);
  timer?.unref?.();
  return timer;
}

export function createSession({
  send, onChange, storage = browserStorage(), rollDie = fairDie, theme: preferredTheme = 'classic',
  now = () => Date.now(), setTimer = defaultTimer, clearTimer = (timer) => clearTimeout(timer),
  // Deals power-ups and shuffles squares. Only the host's matters.
  random = Math.random,
}) {
  // A new game starts on this viewer's preferred board; the host's copy wins once connected.
  let state = createGame([], preferredTheme);
  let self = null;
  let participants = [];
  let earlyParticipants = null;
  let sessionId = null;
  let hostId = null;
  let connected = false;
  let notice = '';
  let destroyed = false;
  let acceptedHostId = null;
  let pendingSync = null;
  let lastThemeAt = -Infinity;
  let lastModeAt = -Infinity;
  let turnTimer = null;
  let turnKey = null;
  let timedRolls = null;

  const ids = () => participants.map((person) => person.id);
  const isHost = () => self !== null && self.id === hostId;
  const isMember = (id) => participants.some((person) => person.id === id);
  const seated = (id) => id !== null && state.players.includes(id);
  const enoughPlayers = () => state.players.filter((id) => id !== null).length >= 2;
  const storageKey = () => `${GAME_PROTOCOL}:${JSON.stringify([sessionId, self?.id])}`;

  function persist() {
    if (!storage || !connected || !isValidGame(state, ids())) return;
    try {
      storage.setItem(storageKey(), JSON.stringify({ state, hostId, members: ids() }));
    } catch { /* A disabled or full browser store must not prevent live play. */ }
  }

  // People keep their seats; the earliest unseated participants fill empty ones.
  function assignSeats() {
    const members = ids();
    const players = state.players.map((id) => (members.includes(id) ? id : null));
    for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
      if (players[seat] === null) players[seat] = members.find((id) => !players.includes(id)) ?? null;
    }
    return players;
  }

  function restore() {
    if (!storage) return;
    try {
      const raw = storage.getItem(storageKey());
      if (!raw || raw.length > 10000) return;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved.members) || !saved.members.every(validId) || saved.hostId !== saved.members[0] ||
          new Set(saved.members).size !== saved.members.length || !isValidGame(saved.state, saved.members)) return;
      const fresh = state;
      state = saved.state;
      if (isHost()) {
        state = seatPlayers(state, assignSeats(), random);
        if (!isValidGame(state, ids())) state = fresh;
      }
    } catch { /* Ignore invalid or unavailable saved state. */ }
  }

  // Only the host keeps time. A new turn (a roll, a skip, a new round, or a new player in
  // the seat) restarts the clock; theme changes do not.
  function armTurnTimer() {
    const active = !destroyed && connected && isHost() && enoughPlayers() && state.winner === null && state.players[state.turn] !== null;
    const key = active ? JSON.stringify([state.round, state.rolls, state.skips, state.turn, state.players]) : null;
    if (key === turnKey) return;
    if (turnTimer !== null) clearTimer(turnTimer);
    turnTimer = null;
    const afterRoll = timedRolls !== null && state.rolls !== timedRolls;
    turnKey = key;
    timedRolls = state.rolls;
    if (!active) return;
    turnTimer = setTimer(() => {
      turnTimer = null;
      if (destroyed || !isHost() || turnKey !== key) return;
      const next = skipTurn(state);
      if (next === state) return;
      state = next;
      notice = '';
      emit();
      snapshot();
    }, (afterRoll ? TURN_SETTLE_MS : 0) + TURN_MS + TURN_GRACE_MS);
  }

  function emit() {
    if (destroyed) return;
    armTurnTimer();
    persist();
    onChange({
      state: clone(state), self: self && { ...self },
      participants: participants.map((person) => ({ ...person })),
      hostId, isHost: isHost(), connected, notice,
    });
  }

  function transmit(kind, data = {}, to) {
    if (destroyed || !sessionId || !self || !isMember(self.id)) return;
    send({ protocol: GAME_PROTOCOL, sessionId, hostId, kind, ...data }, to);
  }

  function snapshot(to, replyTo) {
    transmit('state', { state: clone(state), members: ids(), ...(replyTo ? { replyTo } : {}) }, to);
  }

  function restingNotice() {
    if (!self || !isMember(self.id)) return 'You are no longer in this activity.';
    if (!connected) return 'Synchronizing the game…';
    if (!enoughPlayers()) return 'Waiting for another player to join.';
    return '';
  }

  function updateRoster(people) {
    const next = normalizePeople(people);
    if (!next || destroyed) return;
    if (!self) {
      earlyParticipants = next;
      return;
    }
    const oldHost = hostId;
    const oldMembers = ids();
    participants = next;
    hostId = participants[0]?.id ?? null;
    const changed = !same(oldMembers, ids());
    const leadershipChanged = oldHost !== hostId;
    if (!isMember(self.id)) {
      connected = false;
      notice = restingNotice();
      emit();
      return;
    }

    if (isHost()) {
      // The game carries on through arrivals, departures, and a change of host:
      // a newcomer starts from square zero and a departed token leaves the board.
      const reseated = seatPlayers(state, assignSeats(), random);
      const seatsChanged = reseated !== state;
      state = reseated;
      if (leadershipChanged && oldHost !== null) notice = 'The host left. The game carries on from here.';
      else notice = seatsChanged ? 'Player seats updated.' : '';
      connected = true;
      acceptedHostId = hostId;
      notice = restingNotice() || notice;
      emit();
      if (changed) snapshot();
    } else {
      if (leadershipChanged || !isValidGame(state, ids())) {
        connected = false;
        acceptedHostId = null;
      }
      notice = restingNotice();
      emit();
      if (changed) sync();
    }
  }

  function init(message) {
    if (destroyed || !message || typeof message.sessionId !== 'string' || !message.sessionId ||
        !message.self || !validId(message.self.id)) return;
    const nextParticipants = normalizePeople(message.participants);
    if (!nextParticipants || !nextParticipants.some((person) => person.id === message.self.id)) return;
    if (sessionId === message.sessionId && self?.id === message.self.id) {
      self = normalizePeople([message.self])[0];
      updateRoster(message.participants);
      sync();
      return;
    }
    sessionId = message.sessionId;
    pendingSync = null;
    self = normalizePeople([message.self])[0];
    participants = nextParticipants;
    hostId = participants[0]?.id ?? null;
    state = createGame(ids().slice(0, MAX_PLAYERS), preferredTheme);
    restore();
    acceptedHostId = isHost() ? hostId : null;
    connected = isHost();
    notice = restingNotice();
    emit();
    if (earlyParticipants) {
      const pending = earlyParticipants;
      earlyParticipants = null;
      updateRoster(pending);
    }
    sync();
  }

  function sync() {
    if (destroyed || !self || !isMember(self.id)) return;
    if (isHost()) snapshot();
    else {
      pendingSync = syncToken();
      transmit('sync', { requestId: pendingSync }, hostId === null ? undefined : [hostId]);
    }
  }

  function applyAction(from, data) {
    // Theme and seat updates move the revision, so they must not void a roll request in flight.
    // The roll count still stops a duplicate or stale request from rolling twice.
    if (!seated(from) || !enoughPlayers() || data.round !== state.round) return false;
    if (data.kind === 'roll') {
      if (data.rolls !== state.rolls) return false;
      // Only the coordinator throws the die, so a guest cannot choose its own roll.
      if (state.winner !== null || state.players[state.turn] !== from) return false;
      const next = playRoll(state, from, rollDie());
      if (next === state) return false;
      state = next;
    } else if (data.kind === 'rematch' && state.winner !== null) {
      state = nextRound(state, random);
    } else if (data.kind === 'power') {
      // One power-up per turn: the power count stops a duplicate request playing twice.
      if (data.powers !== state.powers || data.rolls !== state.rolls) return false;
      const next = usePower(state, from, data.slot, data.target ?? null, random);
      if (next === state) return false;
      state = next;
    } else if (data.kind === 'mode') {
      if (now() - lastModeAt < THEME_COOLDOWN_MS) return false;
      const next = switchMode(state, data.mode, random);
      if (next === state) return false;
      lastModeAt = now();
      state = next;
    } else return false;
    notice = '';
    emit();
    snapshot();
    return true;
  }

  function applyTheme(theme) {
    if (now() - lastThemeAt < THEME_COOLDOWN_MS) return;
    lastThemeAt = now();
    state = { ...state, theme, revision: state.revision + 1 };
    emit();
    snapshot();
  }

  function receive(from, data) {
    if (destroyed || !self || !isMember(self.id) || !isMember(from) || !data || typeof data !== 'object' ||
        data.protocol !== GAME_PROTOCOL || data.sessionId !== sessionId || data.hostId !== hostId) return;

    if (data.kind === 'sync') {
      if (isHost() && typeof data.requestId === 'string' && data.requestId.length <= 200) snapshot([from], data.requestId);
      return;
    }
    if (data.kind === 'state') {
      if (isHost() || from !== hostId || !Array.isArray(data.members) ||
          !same(data.members, ids()) || !isValidGame(data.state, ids())) return;
      const requested = pendingSync !== null && data.replyTo === pendingSync;
      if (acceptedHostId === hostId && !requested && (data.state.revision < state.revision ||
          (data.state.revision === state.revision && !same(data.state, state)))) {
        // A fresh request distinguishes a reloaded host from delayed old packets.
        sync();
        return;
      }
      state = clone(data.state);
      pendingSync = null;
      acceptedHostId = hostId;
      connected = true;
      notice = restingNotice();
      emit();
      return;
    }
    if (isHost() && data.kind === 'theme') {
      // Cosmetic, so anyone in the activity may change it, spectators included.
      // Ignored requests need no reply: the picker always shows the game's current theme.
      if (typeof data.theme === 'string' && BOARD_THEMES.includes(data.theme) && data.theme !== state.theme) applyTheme(data.theme);
      return;
    }
    if (isHost() && ['roll', 'rematch', 'power', 'mode'].includes(data.kind)) {
      if (!applyAction(from, data)) snapshot([from]);
    }
  }

  function action(kind, extra = {}) {
    if (destroyed || !self || !connected || !isMember(self.id)) return;
    if (!seated(self.id)) {
      notice = 'You are watching. A seat opens when a player leaves.';
      emit();
      return;
    }
    if (!enoughPlayers()) {
      notice = 'Waiting for another player to join.';
      emit();
      return;
    }
    if (kind === 'roll' && (state.winner !== null || state.players[state.turn] !== self.id)) return;
    if (kind === 'rematch' && state.winner === null) return;
    if (kind === 'power' && (state.mode !== 'chaos' || state.powerUsed || state.players[state.turn] !== self.id)) return;
    if (kind === 'mode' && (!GAME_MODES.includes(extra.mode) || extra.mode === state.mode)) return;
    const data = {
      kind, round: state.round,
      ...(kind === 'roll' || kind === 'power' ? { rolls: state.rolls } : {}),
      ...(kind === 'power' ? { powers: state.powers, slot: extra.slot, target: extra.target ?? null } : {}),
      ...(kind === 'mode' ? { mode: extra.mode } : {}),
    };
    if (isHost()) applyAction(self.id, data);
    else transmit(kind, data, [hostId]);
  }

  function setTheme(theme) {
    if (destroyed || !self || !connected || !isMember(self.id) || !BOARD_THEMES.includes(theme) || theme === state.theme) return;
    if (isHost()) applyTheme(theme);
    else transmit('theme', { theme }, [hostId]);
  }

  return {
    init,
    setTheme,
    setParticipants: updateRoster,
    receive,
    roll: () => action('roll'),
    rematch: () => action('rematch'),
    // Chaos mode: play the power-up in a hand slot, aimed at a seat when it needs one.
    usePower: (slot, target = null) => action('power', { slot, target }),
    // Any seated player may switch modes before anyone moves, or between rounds.
    setMode: (mode) => action('mode', { mode }),
    sync,
    destroy() {
      destroyed = true;
      if (turnTimer !== null) clearTimer(turnTimer);
      turnTimer = null;
    },
  };
}
