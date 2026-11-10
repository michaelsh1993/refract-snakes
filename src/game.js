export const LAST_SQUARE = 100;
export const MAX_PLAYERS = 4;
export const SEATS = Object.freeze([0, 1, 2, 3]);
// Board themes are cosmetic, but shared: everyone in a game sees the same board.
export const BOARD_THEMES = Object.freeze(['classic', 'christmas', 'jungle', 'space']);
export const boardTheme = (theme) => (BOARD_THEMES.includes(theme) ? theme : 'classic');
// Classic is plain snakes and ladders; Chaos deals everyone power-ups to use on each other.
export const GAME_MODES = Object.freeze(['classic', 'chaos']);

// Foot of each ladder → top, and head of each snake → tail.
export const LADDERS = Object.freeze({ 4: 25, 13: 46, 33: 49, 42: 63, 50: 69, 62: 81, 74: 92 });
export const SNAKES = Object.freeze({ 27: 5, 40: 3, 43: 18, 54: 31, 66: 45, 76: 58, 89: 53, 99: 41 });

/**
 * Chaos mode power-ups. `aim` says who it hits: 'self', one 'other' player, or 'all'
 * the other players. A shield blocks the next power-up aimed at its owner.
 */
export const POWER_UPS = Object.freeze({
  rocket: { name: 'Rocket', icon: '🚀', aim: 'self', blurb: 'Blast 8 squares ahead (never onto 100).' },
  double: { name: 'Double dice', icon: '🎲', aim: 'self', blurb: 'Your next roll counts twice.' },
  shield: { name: 'Shield', icon: '🛡️', aim: 'self', blurb: 'Blocks the next power-up used on you.' },
  bite: { name: 'Snake bite', icon: '🐍', aim: 'other', blurb: 'Send a rival back 10 squares.' },
  swap: { name: 'Swap', icon: '🔄', aim: 'other', blurb: 'Trade places with a rival.' },
  freeze: { name: 'Freeze', icon: '🧊', aim: 'other', blurb: 'A rival misses their next turn.' },
  banana: { name: 'Banana', icon: '🍌', aim: 'other', blurb: 'A rival’s next roll goes backwards.' },
  lightning: { name: 'Lightning', icon: '⚡', aim: 'all', blurb: 'Every rival slides back 6 squares.' },
  shuffle: { name: 'Shuffle', icon: '🌀', aim: 'all', blurb: 'Everyone swaps squares at random.' },
});
const POWER_IDS = Object.freeze(Object.keys(POWER_UPS));
// Chaos hands start with one power-up for yourself and one to use on others; every
// roll of a 3 adds another, up to HAND_MAX.
export const HAND_SIZE = 2;
export const HAND_MAX = 5;
const BONUS_ROLL = 3;
const SELF_POWERS = Object.freeze(Object.keys(POWER_UPS).filter((id) => POWER_UPS[id].aim === 'self'));
const ATTACK_POWERS = Object.freeze(Object.keys(POWER_UPS).filter((id) => POWER_UPS[id].aim !== 'self'));

// Playing pieces. 'counter' is the plain numbered counter; the rest are a little sillier.
export const PIECES = Object.freeze({
  counter: { name: 'Counter', icon: null },
  duck: { name: 'Duck', icon: '🦆' },
  dino: { name: 'Dino', icon: '🦖' },
  ufo: { name: 'UFO', icon: '🛸' },
  pizza: { name: 'Pizza', icon: '🍕' },
  ghost: { name: 'Ghost', icon: '👻' },
  octopus: { name: 'Octopus', icon: '🐙' },
  robot: { name: 'Robot', icon: '🤖' },
  cheese: { name: 'Cheese', icon: '🧀' },
  crown: { name: 'Crown', icon: '👑' },
});
const PIECE_IDS = Object.freeze(Object.keys(PIECES));
// How long each player has to throw, in seconds.
export const TURN_SECONDS = Object.freeze({ min: 5, max: 30, standard: 15 });
const isTurnSeconds = (value) => Number.isInteger(value) && value >= TURN_SECONDS.min && value <= TURN_SECONDS.max;
// 'lobby' while people join and pick options; 'playing' once the game starts.
export const PHASES = Object.freeze(['lobby', 'playing']);
const ROCKET_SQUARES = 8;
const BITE_SQUARES = 10;
const LIGHTNING_SQUARES = 6;
const MAX_FROZEN = 2;

const isSeat = (value) => Number.isInteger(value) && value >= 0 && value < MAX_PLAYERS;
const seatList = (players = []) => SEATS.map((seat) => players[seat] ?? null);
const calm = () => ({ frozen: 0, banana: false, double: false, shield: false });
const calmAll = () => SEATS.map(calm);

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

const pick = (list, random) => list[Math.floor(random() * list.length) % list.length];

/** A fresh hand for every seated player (Chaos mode only): one attack, one for yourself. */
function deal(players, mode, random) {
  return SEATS.map((seat) => (mode === 'chaos' && players[seat] !== null
    ? [pick(ATTACK_POWERS, random), pick(SELF_POWERS, random)]
    : []));
}

export function createGame(players = [1, 2], theme = 'classic', mode = 'classic', random = Math.random,
  { phase = 'playing', turnSeconds = TURN_SECONDS.standard, pieces } = {}) {
  const seats = seatList(players);
  const chosen = GAME_MODES.includes(mode) ? mode : 'classic';
  const lobby = phase === 'lobby';
  return {
    phase: lobby ? 'lobby' : 'playing',
    theme: boardTheme(theme),
    mode: chosen,
    turnSeconds: isTurnSeconds(turnSeconds) ? turnSeconds : TURN_SECONDS.standard,
    pieces: seats.map((id, seat) => (id === null ? null : PIECE_IDS.includes(pieces?.[seat]) ? pieces[seat] : 'counter')),
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
    // Turns that ran out of time, and the seat that last ran out.
    skips: 0,
    lastSkip: null,
    // What happened most recently: 'roll', 'skip', 'power', or null at the start of a round.
    lastEvent: null,
    // Players frozen out of their turn when it last passed on.
    lastFrozen: [],
    // Chaos mode: each seat's power-ups and lingering effects, whether this turn's
    // power-up has been used, and the last power-up played.
    hands: lobby ? SEATS.map(() => []) : deal(seats, chosen, random),
    effects: calmAll(),
    powerUsed: false,
    powers: 0,
    lastPower: null,
    // A power-up won by rolling a 3, for the message.
    lastBonus: null,
    revision: 0,
  };
}

/** Slide down a snake or up a ladder from the square a token lands on. */
function settle(landed) {
  if (LADDERS[landed] !== undefined) return { landed, to: LADDERS[landed], via: 'ladder' };
  if (SNAKES[landed] !== undefined) return { landed, to: SNAKES[landed], via: 'snake' };
  return { landed, to: landed, via: null };
}

/** Where a token ends up. The final square needs an exact roll. */
export function resolveRoll(from, die) {
  if (from + die > LAST_SQUARE) return { landed: from, to: from, via: 'overshoot' };
  return settle(from + die);
}

/** Like a roll, but `steps` may be negative: backwards moves stop at square 1. */
export function resolveMove(from, steps) {
  if (steps >= 0) return resolveRoll(from, steps);
  if (from === 0) return { landed: 0, to: 0, via: null };
  return settle(Math.max(1, from + steps));
}

/** Pass the turn on from `seat`, skipping (and thawing) anyone frozen. */
function passTurn(state, seat, effects) {
  const missed = [];
  let next = seat;
  for (let step = 0; step < MAX_PLAYERS; step += 1) {
    next = nextSeat(state.players, next);
    if (next !== seat && effects[next].frozen > 0) {
      effects[next] = { ...effects[next], frozen: effects[next].frozen - 1 };
      missed.push(next);
      continue;
    }
    break;
  }
  return { turn: next, missed };
}

export function playRoll(state, playerId, die, random = Math.random) {
  if (state.phase !== 'playing' || state.winner !== null || !Number.isInteger(die) || die < 1 || die > 6 ||
      playerId === null || playerId === undefined || state.players[state.turn] !== playerId) return state;

  const seat = state.turn;
  const from = state.positions[seat];
  const effects = state.effects.map((effect) => ({ ...effect }));
  const own = effects[seat];
  // Double dice and bananas apply to this roll, then wear off.
  let steps = own.double ? die * 2 : die;
  if (own.banana) steps = -steps;
  effects[seat] = { ...own, double: false, banana: false };
  const move = resolveMove(from, steps);
  const positions = [...state.positions];
  positions[seat] = move.to;
  const won = move.to === LAST_SQUARE;
  const scores = [...state.scores];
  if (won) scores[seat] += 1;
  // A six earns another roll.
  const passed = won || die === 6 ? { turn: seat, missed: [] } : passTurn(state, seat, effects);
  // Chaos: rolling a 3 wins another power-up.
  let hands = state.hands;
  let lastBonus = null;
  if (state.mode === 'chaos' && die === BONUS_ROLL && !won && state.hands[seat].length < HAND_MAX) {
    lastBonus = pick(POWER_IDS, random);
    hands = state.hands.map((hand, index) => (index === seat ? [...hand, lastBonus] : hand));
  }
  return {
    ...state,
    positions,
    scores,
    winner: won ? seat : null,
    turn: passed.turn,
    lastRoll: { seat, die, steps, from, ...move },
    lastSkip: null,
    lastEvent: 'roll',
    lastFrozen: passed.missed,
    effects,
    hands,
    lastBonus,
    powerUsed: false,
    rolls: state.rolls + 1,
    revision: state.revision + 1,
  };
}

export function nextRound(state, random = Math.random) {
  const round = state.round + 1;
  return {
    ...state,
    positions: [0, 0, 0, 0],
    turn: startingSeat(round, state.players),
    winner: null,
    lastRoll: null,
    lastSkip: null,
    lastEvent: null,
    lastFrozen: [],
    hands: deal(state.players, state.mode, random),
    effects: calmAll(),
    powerUsed: false,
    lastPower: null,
    lastBonus: null,
    round,
    revision: state.revision + 1,
  };
}

/** The player whose turn it is ran out of time: the turn passes to the next seat. */
export function skipTurn(state) {
  if (state.phase !== 'playing' || state.winner !== null || state.players[state.turn] === null) return state;
  const effects = state.effects.map((effect) => ({ ...effect }));
  const passed = passTurn(state, state.turn, effects);
  if (passed.turn === state.turn) return state;
  return {
    ...state,
    turn: passed.turn,
    lastSkip: state.turn,
    lastEvent: 'skip',
    lastBonus: null,
    lastFrozen: passed.missed,
    effects,
    powerUsed: false,
    skips: state.skips + 1,
    revision: state.revision + 1,
  };
}

/** The mode can change before anyone has moved in a round, or once a round is won. */
export function canChangeMode(state) {
  return state.winner !== null || (state.lastRoll === null && state.lastPower === null && state.positions.every((square) => square === 0));
}

/** Switch between Classic and Chaos, starting the round afresh in the new mode. */
export function setMode(state, mode, random = Math.random) {
  if (!GAME_MODES.includes(mode) || mode === state.mode || !canChangeMode(state)) return state;
  if (state.winner !== null) return nextRound({ ...state, mode }, random);
  return {
    ...state,
    mode,
    positions: [0, 0, 0, 0],
    turn: startingSeat(state.round, state.players),
    lastSkip: null,
    lastEvent: null,
    lastFrozen: [],
    hands: deal(state.players, mode, random),
    effects: calmAll(),
    powerUsed: false,
    lastPower: null,
    lastBonus: null,
    revision: state.revision + 1,
  };
}

// ---------- Lobby ----------
const seatOf = (state, id) => (id === null || id === undefined ? -1 : state.players.indexOf(id));

/** Take the first free seat, with the plain counter until a piece is picked. Lobby only. */
export function joinSeat(state, id) {
  if (state.phase !== 'lobby' || !Number.isSafeInteger(id) || id < 0 || seatOf(state, id) >= 0) return state;
  const seat = state.players.indexOf(null);
  if (seat < 0) return state;
  return {
    ...state,
    players: state.players.map((player, index) => (index === seat ? id : player)),
    pieces: state.pieces.map((piece, index) => (index === seat ? 'counter' : piece)),
    revision: state.revision + 1,
  };
}

/** Give up a seat to spectate instead. Lobby only. */
export function leaveSeat(state, id) {
  const seat = seatOf(state, id);
  if (state.phase !== 'lobby' || seat < 0) return state;
  return {
    ...state,
    players: state.players.map((player, index) => (index === seat ? null : player)),
    pieces: state.pieces.map((piece, index) => (index === seat ? null : piece)),
    scores: state.scores.map((score, index) => (index === seat ? 0 : score)),
    revision: state.revision + 1,
  };
}

/** Pick a playing piece. Lobby only. */
export function choosePiece(state, id, piece) {
  const seat = seatOf(state, id);
  if (state.phase !== 'lobby' || seat < 0 || !PIECE_IDS.includes(piece) || state.pieces[seat] === piece) return state;
  return { ...state, pieces: state.pieces.map((current, index) => (index === seat ? piece : current)), revision: state.revision + 1 };
}

/** Change the game options. Any seated player, lobby only. */
export function configure(state, id, { mode, turnSeconds, theme } = {}) {
  if (state.phase !== 'lobby' || seatOf(state, id) < 0) return state;
  const next = {
    mode: GAME_MODES.includes(mode) ? mode : state.mode,
    turnSeconds: isTurnSeconds(turnSeconds) ? turnSeconds : state.turnSeconds,
    theme: BOARD_THEMES.includes(theme) ? theme : state.theme,
  };
  if (next.mode === state.mode && next.turnSeconds === state.turnSeconds && next.theme === state.theme) return state;
  return { ...state, ...next, revision: state.revision + 1 };
}

/** Start the game with whoever is seated. Needs two players. */
export function startGame(state, id, random = Math.random) {
  if (state.phase !== 'lobby' || seatOf(state, id) < 0 || state.players.filter((player) => player !== null).length < 2) return state;
  return {
    ...state,
    phase: 'playing',
    positions: [0, 0, 0, 0],
    turn: startingSeat(state.round, state.players),
    winner: null,
    hands: deal(state.players, state.mode, random),
    effects: calmAll(),
    revision: state.revision + 1,
  };
}

/** Back to the lobby for a new game: seats, pieces, and options stay; the board and scores reset. */
export function toLobby(state) {
  return {
    ...state,
    phase: 'lobby',
    positions: [0, 0, 0, 0],
    winner: null,
    round: 1,
    scores: [0, 0, 0, 0],
    lastRoll: null,
    lastSkip: null,
    lastEvent: null,
    lastFrozen: [],
    hands: SEATS.map(() => []),
    effects: calmAll(),
    powerUsed: false,
    lastPower: null,
    lastBonus: null,
    revision: state.revision + 1,
  };
}

/** A seated player can take everyone back to the lobby once a round is won. */
export function backToLobby(state, id) {
  if (state.phase !== 'playing' || state.winner === null || seatOf(state, id) < 0) return state;
  return toLobby(state);
}

/**
 * Play the power-up in `slot` of the current player's hand, aimed at `target` when it
 * needs one. `random` only matters for Shuffle. Returns the same state if not allowed.
 */
export function usePower(state, playerId, slot, target = null, random = Math.random) {
  const seat = state.turn;
  if (state.phase !== 'playing' || state.mode !== 'chaos' || state.winner !== null || state.powerUsed || playerId === null || playerId === undefined ||
      state.players[seat] !== playerId || !Number.isInteger(slot)) return state;
  const power = state.hands[seat][slot];
  if (!power) return state;
  const { aim } = POWER_UPS[power];
  if (aim === 'other' && (!isSeat(target) || target === seat || state.players[target] === null)) return state;

  const positions = [...state.positions];
  const effects = state.effects.map((effect) => ({ ...effect }));
  const moves = [];
  const blocked = [];
  const move = (who, to) => {
    if (positions[who] !== to) moves.push([who, positions[who], to]);
    positions[who] = to;
  };
  // A shield soaks up the hit, and is used up doing it.
  const shielded = (who) => {
    if (!effects[who].shield) return false;
    effects[who] = { ...effects[who], shield: false };
    blocked.push(who);
    return true;
  };
  const rivals = SEATS.filter((other) => other !== seat && state.players[other] !== null);

  if (power === 'rocket') move(seat, settle(Math.min(positions[seat] + ROCKET_SQUARES, LAST_SQUARE - 1)).to);
  else if (power === 'double') effects[seat] = { ...effects[seat], double: true };
  else if (power === 'shield') effects[seat] = { ...effects[seat], shield: true };
  else if (aim === 'other') {
    if (!shielded(target)) {
      if (power === 'bite') move(target, resolveMove(positions[target], -BITE_SQUARES).to);
      else if (power === 'swap') {
        const mine = positions[seat];
        move(seat, positions[target]);
        move(target, mine);
      } else if (power === 'freeze') effects[target] = { ...effects[target], frozen: Math.min(MAX_FROZEN, effects[target].frozen + 1) };
      else if (power === 'banana') effects[target] = { ...effects[target], banana: true };
    }
  } else if (power === 'lightning') {
    for (const rival of rivals) if (!shielded(rival)) move(rival, resolveMove(positions[rival], -LIGHTNING_SQUARES).to);
  } else if (power === 'shuffle') {
    const caught = [seat, ...rivals.filter((rival) => !shielded(rival))];
    const squares = caught.map((who) => positions[who]);
    for (let i = squares.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1)) % (i + 1);
      [squares[i], squares[j]] = [squares[j], squares[i]];
    }
    const before = [...positions];
    caught.forEach((who, index) => { if (before[who] !== squares[index]) moves.push([who, before[who], squares[index]]); });
    caught.forEach((who, index) => { positions[who] = squares[index]; });
  }

  const hands = state.hands.map((hand) => [...hand]);
  hands[seat].splice(slot, 1);
  return {
    ...state,
    positions,
    effects,
    hands,
    powerUsed: true,
    powers: state.powers + 1,
    lastPower: { seat, power, target: aim === 'other' ? target : null, blocked, moves },
    lastEvent: 'power',
    lastBonus: null,
    revision: state.revision + 1,
  };
}

/**
 * Apply a new seating. Tokens stay with the people who are still seated, a new
 * arrival starts from square zero (with power-ups from the next round), and a
 * finished round makes way for a new one.
 */
export function seatPlayers(state, players, random = Math.random) {
  const seats = seatList(players);
  const changed = SEATS.map((seat) => seats[seat] !== state.players[seat]);
  if (!changed.some(Boolean)) return state;
  const pieces = state.pieces.map((piece, seat) => (seats[seat] === null ? null : changed[seat] ? 'counter' : piece));
  if (state.phase === 'lobby') return { ...state, players: seats, pieces, scores: state.scores.map((score, seat) => (changed[seat] ? 0 : score)), revision: state.revision + 1 };
  if (state.winner !== null) return nextRound({ ...state, players: seats, pieces }, random);
  return {
    ...state,
    players: seats,
    pieces,
    positions: state.positions.map((position, seat) => (changed[seat] ? 0 : position)),
    turn: seats[state.turn] === null ? nextSeat(seats, state.turn) : state.turn,
    lastRoll: state.lastRoll && changed[state.lastRoll.seat] ? null : state.lastRoll,
    lastSkip: state.lastSkip !== null && changed[state.lastSkip] ? null : state.lastSkip,
    lastEvent: (state.lastEvent === 'roll' && state.lastRoll && changed[state.lastRoll.seat]) ||
      (state.lastEvent === 'skip' && state.lastSkip !== null && changed[state.lastSkip]) ||
      (state.lastEvent === 'power' && state.lastPower && changed[state.lastPower.seat]) ? null : state.lastEvent,
    lastFrozen: state.lastFrozen.filter((seat) => !changed[seat]),
    lastPower: state.lastPower && changed[state.lastPower.seat] ? null : state.lastPower,
    powerUsed: state.lastPower && changed[state.lastPower.seat] ? false : state.powerUsed,
    hands: state.hands.map((hand, seat) => (changed[seat] ? [] : hand)),
    effects: state.effects.map((effect, seat) => (changed[seat] ? calm() : effect)),
    revision: state.revision + 1,
  };
}

const isEffect = (effect) => effect && typeof effect === 'object' && Object.keys(effect).length === 4 &&
  Number.isInteger(effect.frozen) && effect.frozen >= 0 && effect.frozen <= MAX_FROZEN &&
  typeof effect.banana === 'boolean' && typeof effect.double === 'boolean' && typeof effect.shield === 'boolean';
const ROLL_KEYS = ['seat', 'die', 'steps', 'from', 'landed', 'to', 'via'];
const isSquare = (value) => Number.isInteger(value) && value >= 0 && value <= LAST_SQUARE;

// Treat network state as untrusted, including internally inconsistent boards.
export function isValidGame(state, memberIds) {
  if (!state || typeof state !== 'object') return false;
  const { positions, players, scores, turn, winner, lastRoll, round, revision, mode, hands, effects, lastPower } = state;
  if (!BOARD_THEMES.includes(state.theme) || !GAME_MODES.includes(mode) || !PHASES.includes(state.phase) || !isTurnSeconds(state.turnSeconds)) return false;
  if (!Array.isArray(state.pieces) || state.pieces.length !== MAX_PLAYERS ||
      !state.pieces.every((piece, seat) => (state.players?.[seat] === null ? piece === null : PIECE_IDS.includes(piece)))) return false;
  if (state.lastBonus !== null && (!POWER_IDS.includes(state.lastBonus) || mode !== 'chaos' || state.lastEvent !== 'roll' || lastRoll?.die !== BONUS_ROLL)) return false;
  // Nothing has happened on the board while people are still in the lobby.
  if (state.phase === 'lobby' && (state.positions?.some?.((square) => square !== 0) || winner !== null || lastRoll !== null ||
      lastPower !== null || state.lastSkip !== null || state.lastEvent !== null || state.powerUsed ||
      state.hands?.some?.((hand) => hand.length))) return false;
  if (!Number.isSafeInteger(state.rolls) || state.rolls < 0 || state.rolls > revision || (lastRoll !== null && state.rolls < 1)) return false;
  if (!Number.isSafeInteger(state.skips) || state.skips < 0 || state.skips > revision) return false;
  if (!Number.isSafeInteger(state.powers) || state.powers < 0 || state.powers > revision) return false;
  if (state.lastSkip !== null && (!isSeat(state.lastSkip) || state.skips < 1 || winner !== null)) return false;
  if (![null, 'roll', 'skip', 'power'].includes(state.lastEvent) || typeof state.powerUsed !== 'boolean') return false;
  if (!Array.isArray(state.lastFrozen) || state.lastFrozen.length > MAX_PLAYERS - 1 || !state.lastFrozen.every(isSeat)) return false;
  if (!Number.isSafeInteger(round) || round < 1 || !Number.isSafeInteger(revision) || revision < 0 || !isSeat(turn)) return false;
  for (const list of [positions, players, scores, hands, effects]) {
    if (!Array.isArray(list) || list.length !== MAX_PLAYERS) return false;
  }

  const seatedIds = players.filter((id) => id !== null);
  if (!seatedIds.every((id) => Number.isSafeInteger(id) && id >= 0 && (!memberIds || memberIds.includes(id)))) return false;
  if (new Set(seatedIds).size !== seatedIds.length) return false;
  if (state.phase === 'playing' && seatedIds.length && players[turn] === null) return false;

  for (const seat of SEATS) {
    const position = positions[seat];
    // A token never rests on the foot of a ladder or the head of a snake.
    if (!Number.isInteger(position) || position < 0 || position > LAST_SQUARE ||
        LADDERS[position] !== undefined || SNAKES[position] !== undefined) return false;
    if (players[seat] === null && position !== 0) return false;
    if (!Number.isSafeInteger(scores[seat]) || scores[seat] < 0) return false;
    const hand = hands[seat];
    if (!Array.isArray(hand) || hand.length > HAND_MAX || !hand.every((power) => POWER_IDS.includes(power))) return false;
    if (!isEffect(effects[seat])) return false;
    // Classic games, and empty seats, carry no power-ups or effects.
    if ((mode === 'classic' || players[seat] === null) &&
        (hand.length || effects[seat].frozen || effects[seat].banana || effects[seat].double || effects[seat].shield)) return false;
  }
  if (scores.reduce((sum, score) => sum + score, 0) > round - (winner === null ? 1 : 0)) return false;

  const finished = SEATS.filter((seat) => positions[seat] === LAST_SQUARE);
  if (winner === null) {
    if (finished.length) return false;
  } else if (!isSeat(winner) || finished.length !== 1 || finished[0] !== winner || players[winner] === null ||
      scores[winner] < 1 || turn !== winner || lastRoll?.seat !== winner || state.lastEvent !== 'roll') return false;

  if (lastRoll !== null) {
    if (!lastRoll || typeof lastRoll !== 'object' || !isSeat(lastRoll.seat) || players[lastRoll.seat] === null ||
        !Number.isInteger(lastRoll.die) || lastRoll.die < 1 || lastRoll.die > 6 ||
        !Number.isInteger(lastRoll.from) || lastRoll.from < 0 || lastRoll.from >= LAST_SQUARE) return false;
    const keys = Object.keys(lastRoll);
    if (keys.length !== ROLL_KEYS.length || !ROLL_KEYS.every((key) => keys.includes(key))) return false;
    // Classic rolls move by the die; Chaos rolls may be doubled or sent backwards.
    const allowed = mode === 'chaos' ? [lastRoll.die, lastRoll.die * 2, -lastRoll.die, -lastRoll.die * 2] : [lastRoll.die];
    if (!allowed.includes(lastRoll.steps)) return false;
    const move = resolveMove(lastRoll.from, lastRoll.steps);
    if (move.landed !== lastRoll.landed || move.to !== lastRoll.to || move.via !== lastRoll.via) return false;
    // Straight after a roll, the token is where the roll left it, and a six rolls again.
    if (state.lastEvent === 'roll') {
      if (positions[lastRoll.seat] !== lastRoll.to) return false;
      if (lastRoll.die === 6 && turn !== lastRoll.seat) return false;
    }
  }
  if (state.lastEvent === 'roll' && lastRoll === null) return false;
  if (state.lastEvent === 'skip' && state.lastSkip === null) return false;

  if (lastPower !== null) {
    if (mode !== 'chaos' || !lastPower || typeof lastPower !== 'object' || Object.keys(lastPower).length !== 5 ||
        !isSeat(lastPower.seat) || !POWER_IDS.includes(lastPower.power) || state.powers < 1 ||
        !(lastPower.target === null || isSeat(lastPower.target)) ||
        !Array.isArray(lastPower.blocked) || lastPower.blocked.length > MAX_PLAYERS || !lastPower.blocked.every(isSeat) ||
        !Array.isArray(lastPower.moves) || lastPower.moves.length > MAX_PLAYERS ||
        !lastPower.moves.every((entry) => Array.isArray(entry) && entry.length === 3 && isSeat(entry[0]) && isSquare(entry[1]) && isSquare(entry[2]))) return false;
  }
  if (state.lastEvent === 'power' && (lastPower === null || !state.powerUsed)) return false;
  if (mode === 'classic' && (state.powerUsed || lastPower !== null)) return false;
  return revision >= round - 1 + (lastRoll ? 1 : 0);
}
