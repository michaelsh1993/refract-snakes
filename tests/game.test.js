import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_THEMES, LADDERS, LAST_SQUARE, SNAKES, createGame, isValidGame, nextRound, nextSeat, playRoll,
  resolveRoll, rollDie, seatPlayers, startingSeat,
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
  assert.deepEqual(state.lastRoll, { seat: 0, die: 3, from: 0, landed: 3, to: 3, via: null });
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
    { ...state, lastRoll: { seat: 1, die: 6, from: 0, landed: 6, to: 6, via: null }, positions: [3, 6, 0, 0] },
    { ...won, winner: null },
    { ...won, lastRoll: null },
    { ...won, scores: [0, 0, 0, 0] },
  ]) assert.equal(isValidGame(bad, [1, 2]), false, JSON.stringify(bad));
});
