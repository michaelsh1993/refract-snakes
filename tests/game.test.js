import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_THEMES, LADDERS, LAST_SQUARE, SNAKES, createGame, isValidGame, nextRound, nextSeat, playRoll,
  HAND_MAX, PIECES, POWER_UPS, backToLobby, canChangeMode, choosePiece, configure, joinSeat, leaveSeat, startGame, toLobby, resolveMove, resolveRoll, rollDie, seatPlayers, setMode, skipTurn, startingSeat, usePower,
} from '../src/game.js';

const rolls = (state, dice) => dice.reduce((current, die) => playRoll(current, current.players[current.turn], die), state);

test('the board has distinct snakes and ladders that never chain or touch the ends', () => {
  const starts = [...Object.keys(LADDERS), ...Object.keys(SNAKES)].map(Number);
  const ends = [...Object.values(LADDERS), ...Object.values(SNAKES)];
  assert.equal(new Set(starts).size, starts.length);
  for (const start of starts) assert.ok(start > 1 && start < LAST_SQUARE && !ends.includes(start), `square ${start}`);
  for (const [from, to] of Object.entries(LADDERS)) assert.ok(to > Number(from) && to < LAST_SQUARE);
  for (const [from, to] of Object.entries(SNAKES)) assert.ok(to < Number(from) && to >= 1);
});

test('the board theme defaults to classic, rejects unknown names, and survives play', () => {
  assert.equal(createGame().theme, 'classic');
  assert.equal(createGame([1, 2], 'lava').theme, 'classic');
  for (const theme of BOARD_THEMES) {
    let state = createGame([1, 2], theme);
    state = nextRound(seatPlayers(playRoll({ ...state, positions: [94, 0, 0, 0] }, 1, 6), [1, 3]));
    assert.equal(state.theme, theme);
    assert.ok(isValidGame(state, [1, 3]));
  }
});

test('a turn that runs out passes on, even after a six, and the next roll clears the note', () => {
  let state = createGame([1, 2, 3]);
  state = skipTurn(state);
  assert.deepEqual([state.turn, state.lastSkip, state.skips], [1, 0, 1]);
  assert.ok(isValidGame(state, [1, 2, 3]));
  state = playRoll(state, 2, 6);
  assert.deepEqual([state.turn, state.lastSkip], [1, null]);
  state = skipTurn(state);
  assert.deepEqual([state.turn, state.lastSkip], [2, 1]);
  assert.ok(isValidGame(state, [1, 2, 3]));
  const alone = createGame([1, null]);
  assert.equal(skipTurn(alone), alone);
  const won = playRoll({ ...createGame(), positions: [94, 0, 0, 0] }, 1, 6);
  assert.equal(skipTurn(won), won);
  assert.equal(nextRound(state).lastSkip, null);
  for (const bad of [{ ...state, skips: -1 }, { ...state, skips: 99 }, { ...state, lastSkip: 7 }, { ...state, lastSkip: 0, skips: 0 }]) {
    assert.equal(isValidGame(bad, [1, 2, 3]), false);
  }
});

test('a fair die only rolls one to six', () => {
  const seen = new Set();
  for (let i = 0; i < 600; i += 1) seen.add(rollDie());
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6]);
});

test('rolls move the token, pass the turn, and sixes roll again', () => {
  let state = createGame([10, 20]);
  assert.deepEqual(state.players, [10, 20, null, null]);
  state = playRoll(state, 10, 3);
  assert.deepEqual(state.positions, [3, 0, 0, 0]);
  assert.equal(state.turn, 1);
  assert.deepEqual(state.lastRoll, { seat: 0, die: 3, steps: 3, from: 0, landed: 3, to: 3, via: null });
  state = playRoll(state, 20, 6);
  assert.equal(state.turn, 1);
  state = playRoll(state, 20, 2);
  assert.deepEqual(state.positions, [3, 8, 0, 0]);
  assert.equal(state.turn, 0);
  assert.equal(state.revision, 3);
  assert.equal(state.rolls, 3);
});

test('ladders lift, snakes drop, and the last square needs an exact roll', () => {
  assert.deepEqual(resolveRoll(0, 4), { landed: 4, to: 25, via: 'ladder' });
  assert.deepEqual(resolveRoll(25, 2), { landed: 27, to: 5, via: 'snake' });
  assert.deepEqual(resolveRoll(97, 5), { landed: 97, to: 97, via: 'overshoot' });
  assert.deepEqual(resolveRoll(97, 3), { landed: 100, to: 100, via: null });
  const state = playRoll({ ...createGame(), positions: [97, 0, 0, 0] }, 1, 5);
  assert.equal(state.positions[0], 97);
  assert.equal(state.turn, 1);
});

test('wrong players, bad dice, and finished rounds leave the state untouched', () => {
  const state = createGame();
  for (const [id, die] of [[2, 3], [null, 3], [undefined, 3], [1, 0], [1, 7], [1, 2.5], [1, '3']]) {
    assert.equal(playRoll(state, id, die), state);
  }
  const won = playRoll({ ...createGame(), positions: [94, 0, 0, 0] }, 1, 6);
  assert.equal(won.winner, 0);
  assert.equal(won.turn, 0);
  assert.deepEqual(won.scores, [1, 0, 0, 0]);
  assert.equal(playRoll(won, 1, 1), won);
  assert.equal(playRoll(won, 2, 1), won);
});

test('rounds rotate the opening seat past empty seats and keep scores', () => {
  const won = playRoll({ ...createGame([1, 2, null, 4]), positions: [94, 0, 0, 0] }, 1, 6);
  const second = nextRound(won);
  assert.deepEqual(second.positions, [0, 0, 0, 0]);
  assert.deepEqual([second.round, second.turn, second.winner, second.lastRoll], [2, 1, null, null]);
  assert.deepEqual(second.scores, [1, 0, 0, 0]);
  assert.equal(nextRound(second).turn, 3);
  assert.equal(startingSeat(5, [1, 2, null, null]), 0);
  assert.equal(nextSeat([1, null, null, 4], 0), 3);
  assert.equal(nextSeat([1, null, null, null], 0), 0);
});

test('seating keeps tokens with people, starts newcomers at zero, and passes on an empty turn', () => {
  const state = rolls(createGame([1, 2, 3]), [3, 5]);
  assert.equal(seatPlayers(state, [1, 2, 3, null]), state);
  const joined = seatPlayers(state, [1, 2, 3, 4]);
  assert.deepEqual(joined.positions, [3, 5, 0, 0]);
  assert.equal(joined.turn, 2);
  const left = seatPlayers(joined, [1, 2, null, 4]);
  assert.equal(left.turn, 3);
  assert.deepEqual(left.lastRoll, joined.lastRoll);
  const swapped = seatPlayers(left, [1, 9, null, 4]);
  assert.deepEqual(swapped.positions, [3, 0, 0, 0]);
  assert.equal(swapped.lastRoll, null);
  assert.ok(isValidGame(swapped, [1, 9, 4]));
  const won = playRoll({ ...createGame(), positions: [94, 0, 0, 0] }, 1, 6);
  const afterWin = seatPlayers(won, [1, null, null, null]);
  assert.deepEqual([afterWin.round, afterWin.winner, afterWin.positions[0]], [2, null, 0]);
  assert.ok(isValidGame(afterWin, [1]));
});

test('every reachable state validates', () => {
  let state = createGame([1, 2, 3]);
  let seed = 7;
  for (let i = 0; i < 4000; i += 1) {
    assert.ok(isValidGame(state, [1, 2, 3]), JSON.stringify(state));
    if (state.winner !== null) state = nextRound(state);
    else {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      state = playRoll(state, state.players[state.turn], seed % 6 + 1);
    }
  }
  assert.ok(state.round > 3);
});

test('validation rejects malformed and inconsistent states', () => {
  const state = rolls(createGame(), [3, 5]);
  const won = playRoll({ ...createGame(), positions: [94, 0, 0, 0] }, 1, 6);
  assert.ok(isValidGame(state, [1, 2]));
  assert.ok(isValidGame(won, [1, 2]));
  for (const bad of [
    null, 'state', {},
    { ...state, theme: 'lava' },
    { ...state, rolls: -1 },
    { ...state, rolls: 0 },
    { ...state, rolls: 99 },
    { ...state, rolls: '2' },
    { ...state, theme: undefined },
    { ...state, positions: [3, 5, 0] },
    { ...state, positions: [3, 101, 0, 0] },
    { ...state, positions: [4, 5, 0, 0] },
    { ...state, positions: [3, 5, 7, 0] },
    { ...state, positions: [3, 100, 0, 0] },
    { ...state, players: [1, 1, null, null] },
    { ...state, players: [1, 999, null, null] },
    { ...state, players: [1, null, null, null] },
    { ...state, turn: 2 },
    { ...state, turn: 4 },
    { ...state, scores: [-1, 0, 0, 0] },
    { ...state, scores: [1, 0, 0, 0] },
    { ...state, round: 0 },
    { ...state, revision: 0 },
    { ...state, winner: 1 },
    { ...state, lastRoll: { ...state.lastRoll, to: 6 } },
    { ...state, lastRoll: { ...state.lastRoll, die: 7 } },
    { ...state, lastRoll: { ...state.lastRoll, seat: 2 } },
    { ...state, lastRoll: { ...state.lastRoll, extra: 'x'.repeat(100) } },
    { ...state, lastRoll: { seat: 1, die: 6, steps: 6, from: 0, landed: 6, to: 6, via: null }, positions: [3, 6, 0, 0] },
    { ...state, lastRoll: { ...state.lastRoll, steps: 10 } },
    { ...state, mode: 'arcade' },
    { ...state, hands: [['rocket'], [], [], []] },
    { ...state, powerUsed: true },
    { ...won, winner: null },
    { ...won, lastRoll: null },
    { ...won, scores: [0, 0, 0, 0] },
  ]) assert.equal(isValidGame(bad, [1, 2]), false, JSON.stringify(bad));
});

// ---------- Chaos mode ----------
// A predictable stand-in for Math.random: always picks the first power-up and keeps shuffle order.
const first = () => 0;
const chaos = (players = [1, 2, 3], hands) => {
  const state = createGame(players, 'classic', 'chaos', first);
  return hands ? { ...state, hands } : state;
};
const calm = { frozen: 0, banana: false, double: false, shield: false };

test('chaos deals every seated player one attack and one power-up for themselves; classic deals none', () => {
  assert.deepEqual(createGame([1, 2]).hands, [[], [], [], []]);
  const state = chaos([1, 2, null, 4]);
  assert.deepEqual(state.hands.map((hand) => hand.length), [2, 2, 0, 2]);
  assert.ok(state.hands.flat().every((power) => POWER_UPS[power]));
  for (const hand of [state.hands[0], state.hands[1], state.hands[3]]) {
    assert.notEqual(POWER_UPS[hand[0]].aim, 'self');
    assert.equal(POWER_UPS[hand[1]].aim, 'self');
  }
  assert.ok(isValidGame(state, [1, 2, 4]));
  assert.deepEqual(nextRound(state, first).hands.map((hand) => hand.length), [2, 2, 0, 2]);
});

test('one power-up per turn, only by the player whose turn it is, aimed at a real rival', () => {
  const state = chaos([1, 2, 3], [['bite', 'swap'], ['swap'], [], []]);
  assert.equal(usePower(state, 2, 0, 0), state);
  assert.equal(usePower(state, 1, 0, 0), state);
  assert.equal(usePower(state, 1, 0, 3), state);
  assert.equal(usePower(state, 1, 5, 1), state);
  const classic = createGame([1, 2]);
  assert.equal(usePower(classic, 1, 0, 1), classic);
  const used = usePower(state, 1, 0, 1);
  assert.notEqual(used, state);
  assert.deepEqual(used.hands[0], ['swap']);
  assert.equal(used.powerUsed, true);
  assert.equal(usePower(used, 1, 0, 1), used);
  assert.ok(isValidGame(used, [1, 2, 3]));
  // The next roll starts a fresh turn, with a fresh chance to play.
  assert.equal(playRoll(used, 1, 2).powerUsed, false);
});

test('each power-up does what it says', () => {
  const at = (positions, hands, effects) => ({ ...chaos([1, 2, 3], hands), positions, ...(effects ? { effects } : {}) });
  // Rocket: 8 ahead, then any snake or ladder; never onto 100.
  assert.equal(usePower(at([10, 0, 0, 0], [['rocket'], [], [], []]), 1, 0).positions[0], 18);
  assert.equal(usePower(at([96, 0, 0, 0], [['rocket'], [], [], []]), 1, 0).positions[0], 41);
  assert.equal(usePower(at([90, 0, 0, 0], [['rocket'], [], [], []]), 1, 0).positions[0], 98);
  // Snake bite: back 10, and a ladder at the bottom still counts.
  assert.equal(usePower(at([0, 35, 0, 0], [['bite'], [], [], []]), 1, 0, 1).positions[1], 25);
  assert.equal(usePower(at([0, 7, 0, 0], [['bite'], [], [], []]), 1, 0, 1).positions[1], 1);
  // Swap.
  assert.deepEqual(usePower(at([10, 30, 0, 0], [['swap'], [], [], []]), 1, 0, 1).positions, [30, 10, 0, 0]);
  // Lightning: every rival back 6.
  assert.deepEqual(usePower(at([52, 30, 20, 0], [['lightning'], [], [], []]), 1, 0).positions, [52, 24, 14, 0]);
  // Shuffle keeps the same squares in play, just moved around.
  const shuffled = usePower(at([52, 30, 20, 0], [['shuffle'], [], [], []]), 1, 0, null, first);
  assert.deepEqual([...shuffled.positions].sort((a, b) => a - b), [0, 20, 30, 52]);
  assert.ok(isValidGame(shuffled, [1, 2, 3]));
  // Double dice and banana change the next roll, then wear off.
  const doubled = usePower(at([10, 0, 0, 0], [['double'], [], [], []]), 1, 0);
  const rolled = playRoll(doubled, 1, 3);
  assert.deepEqual([rolled.positions[0], rolled.lastRoll.steps, rolled.effects[0].double], [16, 6, false]);
  assert.ok(isValidGame(rolled, [1, 2, 3]));
  const peeled = playRoll({ ...at([0, 20, 0, 0], [[], [], [], []], [calm, { ...calm, banana: true }, calm, calm]), turn: 1 }, 2, 3);
  assert.deepEqual([peeled.positions[1], peeled.lastRoll.steps, peeled.effects[1].banana], [17, -3, false]);
  assert.ok(isValidGame(peeled, [1, 2, 3]));
});

test('freeze skips the next turn, and a shield blocks one hit', () => {
  let state = chaos([1, 2, 3], [['freeze'], ['shield'], [], []]);
  state = usePower(state, 1, 0, 1);
  assert.equal(state.effects[1].frozen, 1);
  state = playRoll(state, 1, 2);
  assert.deepEqual([state.turn, state.lastFrozen, state.effects[1].frozen], [2, [1], 0]);
  assert.ok(isValidGame(state, [1, 2, 3]));

  let shielded = { ...chaos([1, 2], [['bite', 'swap'], ['shield'], [], []]), positions: [10, 30, 0, 0] };
  shielded = playRoll(shielded, 1, 2);
  shielded = usePower(shielded, 2, 0);
  assert.equal(shielded.effects[1].shield, true);
  shielded = playRoll(shielded, 2, 1);
  const bitten = usePower(shielded, 1, 0, 1);
  assert.deepEqual([bitten.positions[1], bitten.effects[1].shield, bitten.lastPower.blocked], [31, false, [1]]);
});

test('the mode switches only before anyone moves or after a win, and restarts the round', () => {
  const classic = createGame([1, 2]);
  assert.ok(canChangeMode(classic));
  const chaotic = setMode(classic, 'chaos', first);
  assert.equal(chaotic.mode, 'chaos');
  assert.deepEqual(chaotic.hands.map((hand) => hand.length), [2, 2, 0, 0]);
  const moved = playRoll(chaotic, 1, 2);
  assert.equal(canChangeMode(moved), false);
  assert.equal(setMode(moved, 'classic'), moved);
  const won = playRoll({ ...chaotic, positions: [94, 0, 0, 0] }, 1, 6);
  const back = setMode(won, 'classic');
  assert.deepEqual([back.mode, back.round, back.winner, back.hands.flat().length], ['classic', 2, null, 0]);
  assert.ok(isValidGame(back, [1, 2]));
  assert.deepEqual(resolveMove(0, -5), { landed: 0, to: 0, via: null });
});

test('every reachable chaos state validates', () => {
  let seed = 5;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let state = createGame([1, 2, 3], 'jungle', 'chaos', random);
  for (let i = 0; i < 6000; i += 1) {
    assert.ok(isValidGame(state, [1, 2, 3]), JSON.stringify(state));
    if (state.winner !== null) state = nextRound(state, random);
    else if (!state.powerUsed && state.hands[state.turn].length && random() < 0.5) {
      const others = [0, 1, 2].filter((seat) => seat !== state.turn);
      state = usePower(state, state.players[state.turn], 0, others[Math.floor(random() * 2)], random);
    } else if (random() < 0.05) state = skipTurn(state);
    else state = playRoll(state, state.players[state.turn], Math.floor(random() * 6) + 1);
  }
  assert.ok(state.powers > 50);
});

// ---------- Lobby ----------

test('a lobby fills seats in order, picks pieces and options, and starts with two or more', () => {
  let state = createGame([], 'classic', 'classic', first, { phase: 'lobby' });
  assert.ok(isValidGame(state, [7, 8, 9]));
  assert.equal(startGame(state, 7), state);
  state = joinSeat(state, 7);
  assert.equal(joinSeat(state, 7), state);
  state = joinSeat(state, 9);
  assert.deepEqual([state.players, state.pieces], [[7, 9, null, null], ['counter', 'counter', null, null]]);
  state = choosePiece(state, 9, 'dino');
  assert.equal(choosePiece(state, 8, 'dino'), state);
  assert.equal(choosePiece(state, 9, 'lizard'), state);
  state = configure(state, 7, { mode: 'chaos', turnSeconds: 30, theme: 'jungle' });
  assert.equal(configure(state, 8, { mode: 'classic' }), state);
  assert.equal(configure(state, 7, { turnSeconds: 31 }), state);
  assert.ok(isValidGame(state, [7, 8, 9]));
  assert.equal(playRoll(state, 7, 3), state);
  state = startGame(state, 9, first);
  assert.deepEqual([state.phase, state.pieces[1], state.turnSeconds, state.hands[0].length], ['playing', 'dino', 30, 2]);
  assert.equal(joinSeat(state, 8), state);
  assert.equal(choosePiece(state, 7, 'duck'), state);
  assert.ok(isValidGame(state, [7, 8, 9]));
  // Back to the lobby only after a win; everything on the board resets.
  assert.equal(backToLobby(state, 7), state);
  const won = playRoll({ ...state, positions: [94, 0, 0, 0] }, 7, 6, first);
  const lobby = backToLobby(won, 9);
  assert.deepEqual([lobby.phase, lobby.round, lobby.scores, lobby.hands.flat().length, lobby.pieces], ['lobby', 1, [0, 0, 0, 0], 0, ['counter', 'dino', null, null]]);
  assert.ok(isValidGame(lobby, [7, 8, 9]));
  const left = leaveSeat(lobby, 7);
  assert.deepEqual([left.players, left.pieces], [[null, 9, null, null], [null, 'dino', null, null]]);
  assert.ok(isValidGame(toLobby(won), [7, 9]));
  assert.ok(Object.keys(PIECES).length >= 8);
});

test('validation rejects impossible lobbies, pieces and timers', () => {
  const lobby = joinSeat(createGame([], 'classic', 'classic', first, { phase: 'lobby' }), 1);
  for (const bad of [
    { ...lobby, phase: 'paused' },
    { ...lobby, turnSeconds: 4 },
    { ...lobby, turnSeconds: 31 },
    { ...lobby, pieces: ['dragon', null, null, null] },
    { ...lobby, pieces: ['counter', 'duck', null, null] },
    { ...lobby, positions: [3, 0, 0, 0] },
    { ...lobby, hands: [['rocket'], [], [], []], mode: 'chaos' },
  ]) assert.equal(isValidGame(bad, [1, 2]), false, JSON.stringify(bad));
});

test('in chaos, rolling a 3 adds a power-up, up to the limit', () => {
  let state = chaos([1, 2], [['bite'], [], [], []]);
  state = playRoll(state, 1, 3, first);
  assert.equal(state.hands[0].length, 2);
  assert.ok(POWER_UPS[state.lastBonus]);
  assert.ok(isValidGame(state, [1, 2]));
  const full = playRoll({ ...chaos([1, 2], [Array(HAND_MAX).fill('shield'), [], [], []]) }, 1, 3, first);
  assert.deepEqual([full.hands[0].length, full.lastBonus], [HAND_MAX, null]);
  assert.equal(playRoll(createGame([1, 2]), 1, 3).hands[0].length, 0);
  assert.equal(playRoll(state, 2, 2).lastBonus, null);
});
