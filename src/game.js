export const LAST_SQUARE = 100;
export const MAX_PLAYERS = 4;
export const SEATS = Object.freeze([0, 1, 2, 3]);
// Board themes are cosmetic, but shared: everyone in a game sees the same board.
export const BOARD_THEMES = Object.freeze(['classic', 'christmas', 'jungle', 'space']);
export const boardTheme = (theme) => (BOARD_THEMES.includes(theme) ? theme : 'classic');

// Foot of each ladder → top, and head of each snake → tail.
export const LADDERS = Object.freeze({ 4: 25, 13: 46, 33: 49, 42: 63, 50: 69, 62: 81, 74: 92 });
export const SNAKES = Object.freeze({ 27: 5, 40: 3, 43: 18, 54: 31, 66: 45, 76: 58, 89: 53, 99: 41 });

const isSeat = (value) => Number.isInteger(value) && value >= 0 && value < MAX_PLAYERS;
const seatList = (players = []) => SEATS.map((seat) => players[seat] ?? null);

/** A fair die. The coordinating participant rolls for everyone in a shared game. */
export function rollDie() {
  const random = globalThis.crypto;
  if (random?.getRandomValues) {
    const bytes = new Uint8Array(1);
    do random.getRandomValues(bytes); while (bytes[0] >= 252);
    return bytes[0] % 6 + 1;
  }
  return Math.floor(Math.random() * 6) + 1;
}

/** The next occupied seat after `seat`, or `seat` itself when nobody else is seated. */
export function nextSeat(players, seat) {
  for (let step = 1; step <= MAX_PLAYERS; step += 1) {
    const candidate = (seat + step) % MAX_PLAYERS;
    if (players[candidate] !== null) return candidate;
  }
  return seat;
}

/** The opening seat rotates each round, skipping empty seats. */
export function startingSeat(round, players) {
  const preferred = (round - 1) % MAX_PLAYERS;
  return players[preferred] !== null ? preferred : nextSeat(players, preferred);
}

export function createGame(players = [1, 2], theme = 'classic') {
  const seats = seatList(players);
  return {
    theme: boardTheme(theme),
    positions: [0, 0, 0, 0],
    players: seats,
    turn: startingSeat(1, seats),
    winner: null,
    lastRoll: null,
    round: 1,
    scores: [0, 0, 0, 0],
    // Every roll ever thrown in this game. A roll is identified by this count, not by
    // the revision, which also moves for theme and seat changes.
    rolls: 0,
    // Turns that ran out of time, and the seat that last ran out (cleared by the next roll).
    skips: 0,
    lastSkip: null,
    revision: 0,
  };
}

/** Where a token ends up. The final square needs an exact roll. */
export function resolveRoll(from, die) {
  if (from + die > LAST_SQUARE) return { landed: from, to: from, via: 'overshoot' };
  const landed = from + die;
  if (LADDERS[landed] !== undefined) return { landed, to: LADDERS[landed], via: 'ladder' };
  if (SNAKES[landed] !== undefined) return { landed, to: SNAKES[landed], via: 'snake' };
  return { landed, to: landed, via: null };
}

export function playRoll(state, playerId, die) {
  if (state.winner !== null || !Number.isInteger(die) || die < 1 || die > 6 ||
      playerId === null || playerId === undefined || state.players[state.turn] !== playerId) return state;

  const seat = state.turn;
  const from = state.positions[seat];
  const move = resolveRoll(from, die);
  const positions = [...state.positions];
  positions[seat] = move.to;
  const won = move.to === LAST_SQUARE;
  const scores = [...state.scores];
  if (won) scores[seat] += 1;
  return {
    ...state,
    positions,
    scores,
    winner: won ? seat : null,
    // A six earns another roll.
    turn: won || die === 6 ? seat : nextSeat(state.players, seat),
    lastRoll: { seat, die, from, ...move },
    lastSkip: null,
    rolls: state.rolls + 1,
    revision: state.revision + 1,
  };
}

export function nextRound(state) {
  const round = state.round + 1;
  return {
    ...state,
    positions: [0, 0, 0, 0],
    turn: startingSeat(round, state.players),
    winner: null,
    lastRoll: null,
    lastSkip: null,
    round,
    revision: state.revision + 1,
  };
}

/** The player whose turn it is ran out of time: the turn passes to the next seat. */
export function skipTurn(state) {
  if (state.winner !== null || state.players[state.turn] === null) return state;
  const next = nextSeat(state.players, state.turn);
  if (next === state.turn) return state;
  return {
    ...state,
    turn: next,
    lastSkip: state.turn,
    skips: state.skips + 1,
    revision: state.revision + 1,
  };
}

/**
 * Apply a new seating. Tokens stay with the people who are still seated, a new
 * arrival starts from square zero, and a finished round makes way for a new one.
 */
export function seatPlayers(state, players) {
  const seats = seatList(players);
  const changed = SEATS.map((seat) => seats[seat] !== state.players[seat]);
  if (!changed.some(Boolean)) return state;
  if (state.winner !== null) return nextRound({ ...state, players: seats });
  return {
    ...state,
    players: seats,
    positions: state.positions.map((position, seat) => (changed[seat] ? 0 : position)),
    turn: seats[state.turn] === null ? nextSeat(seats, state.turn) : state.turn,
    lastRoll: state.lastRoll && changed[state.lastRoll.seat] ? null : state.lastRoll,
    lastSkip: state.lastSkip !== null && changed[state.lastSkip] ? null : state.lastSkip,
    revision: state.revision + 1,
  };
}

// Treat network state as untrusted, including internally inconsistent boards.
export function isValidGame(state, memberIds) {
  if (!state || typeof state !== 'object') return false;
  const { positions, players, scores, turn, winner, lastRoll, round, revision } = state;
  if (!BOARD_THEMES.includes(state.theme)) return false;
  if (!Number.isSafeInteger(state.rolls) || state.rolls < 0 || state.rolls > revision || (lastRoll !== null && state.rolls < 1)) return false;
  if (!Number.isSafeInteger(state.skips) || state.skips < 0 || state.skips > revision) return false;
  if (state.lastSkip !== null && (!isSeat(state.lastSkip) || state.skips < 1 || winner !== null)) return false;
  if (!Number.isSafeInteger(round) || round < 1 || !Number.isSafeInteger(revision) || revision < 0 || !isSeat(turn)) return false;
  for (const list of [positions, players, scores]) {
    if (!Array.isArray(list) || list.length !== MAX_PLAYERS) return false;
  }

  const seatedIds = players.filter((id) => id !== null);
  if (!seatedIds.every((id) => Number.isSafeInteger(id) && id >= 0 && (!memberIds || memberIds.includes(id)))) return false;
  if (new Set(seatedIds).size !== seatedIds.length) return false;
  if (memberIds && seatedIds.length !== Math.min(MAX_PLAYERS, memberIds.length)) return false;
  if (seatedIds.length && players[turn] === null) return false;

  for (const seat of SEATS) {
    const position = positions[seat];
    // A token never rests on the foot of a ladder or the head of a snake.
    if (!Number.isInteger(position) || position < 0 || position > LAST_SQUARE ||
        LADDERS[position] !== undefined || SNAKES[position] !== undefined) return false;
    if (players[seat] === null && position !== 0) return false;
    if (!Number.isSafeInteger(scores[seat]) || scores[seat] < 0) return false;
  }
  if (scores.reduce((sum, score) => sum + score, 0) > round - (winner === null ? 1 : 0)) return false;

  const finished = SEATS.filter((seat) => positions[seat] === LAST_SQUARE);
  if (winner === null) {
    if (finished.length) return false;
  } else if (!isSeat(winner) || finished.length !== 1 || finished[0] !== winner || players[winner] === null ||
      scores[winner] < 1 || turn !== winner || lastRoll?.seat !== winner) return false;

  if (lastRoll !== null) {
    if (!lastRoll || typeof lastRoll !== 'object' || !isSeat(lastRoll.seat) || players[lastRoll.seat] === null ||
        !Number.isInteger(lastRoll.die) || lastRoll.die < 1 || lastRoll.die > 6 ||
        !Number.isInteger(lastRoll.from) || lastRoll.from < 0 || lastRoll.from >= LAST_SQUARE) return false;
    const move = resolveRoll(lastRoll.from, lastRoll.die);
    if (move.landed !== lastRoll.landed || move.to !== lastRoll.to || move.via !== lastRoll.via ||
        Object.keys(lastRoll).length !== 6 || positions[lastRoll.seat] !== lastRoll.to) return false;
    // A six rolls again, unless that extra turn then ran out of time.
    if (lastRoll.die === 6 && turn !== lastRoll.seat && state.lastSkip === null) return false;
  }
  return revision >= round - 1 + (lastRoll ? 1 : 0);
}
