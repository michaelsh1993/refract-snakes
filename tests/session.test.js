import test from 'node:test';
import assert from 'node:assert/strict';
import { playRoll } from '../src/game.js';
import { createSession, GAME_PROTOCOL, TURN_GRACE_MS, TURN_MS, TURN_SETTLE_MS } from '../src/session.js';

const person = (id) => ({ id, name: `Player ${id}`, avatarUrl: null });
const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

/**
 * An in-memory Refract call. `initialIds` open the activity; unless `lobby` is true, up to
 * four of them take seats and the first starts the game. `dice` is the queue of upcoming
 * rolls; once it is empty a fixed sequence takes over.
 */
function network(initialIds = [1, 2], { persistence = true, dice = [], lobby = false } = {}) {
  const clients = new Map();
  const queue = [];
  const sent = [];
  const stores = new Map();
  let memberIds = [...initialIds];
  let sessionId = 'test-session';
  let seed = 11;
  // A fake clock and fake timers, run only by net.advance().
  let clock = 0;
  let timers = [];

  function add(id) {
    if (!stores.has(id)) stores.set(id, memoryStorage());
    const client = { view: null, rolled: 0 };
    client.session = createSession({
      storage: persistence ? stores.get(id) : null,
      now: () => clock,
      random: () => 0,
      setTimer(run, ms) { const timer = { at: clock + ms, run }; timers.push(timer); return timer; },
      clearTimer(timer) { timers = timers.filter((other) => other !== timer); },
      rollDie() {
        client.rolled += 1;
        if (dice.length) return dice.shift();
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % 6 + 1;
      },
      send(data, to) {
        const message = { from: id, data: structuredClone(data), to };
        queue.push(message);
        sent.push(message);
      },
      onChange(view) { client.view = view; },
    });
    clients.set(id, client);
    return client;
  }

  function init(id) {
    clients.get(id).session.init({ sessionId, self: person(id), participants: memberIds.map(person) });
  }

  function flush() {
    let count = 0;
    while (queue.length) {
      assert.ok(count++ < 1000, 'message exchange must settle');
      const { from, data, to } = queue.shift();
      for (const [id, client] of clients) {
        if (id !== from && (!to || to.includes(id)) && memberIds.includes(id)) client.session.receive(from, structuredClone(data));
      }
    }
  }

  const call = (id, method, ...args) => { clients.get(id).session[method](...args); flush(); };

  for (const id of initialIds) add(id);
  for (const id of initialIds) init(id);
  flush();

  const net = {
    clients, sent, queue, flush, init, dice,
    view: (id) => clients.get(id).view,
    state: () => clients.get(memberIds[0]).view.state,
    sit: (id) => call(id, 'join'),
    stand: (id) => call(id, 'spectate'),
    piece: (id, piece) => call(id, 'choosePiece', piece),
    options(id, options) { clock += 500; call(id, 'setOptions', options); },
    start: (id) => call(id, 'start'),
    roll: (id) => call(id, 'roll'),
    rematch: (id) => call(id, 'rematch'),
    lobby: (id) => call(id, 'backToLobby'),
    power: (id, slot, target) => call(id, 'usePower', slot, target),
    theme(id, theme, { wait = true } = {}) {
      if (wait) clock += 1500;
      call(id, 'setTheme', theme);
    },
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        clock = due.at;
        due.run();
        flush();
      }
      clock = until;
    },
    timers: () => timers.length,
    // Whoever holds the turn keeps rolling until somebody reaches the last square.
    playToWin() {
      for (let count = 0; net.state().winner === null; count += 1) {
        assert.ok(count < 5000, 'a round must finish');
        net.roll(net.state().players[net.state().turn]);
      }
      return net.state().winner;
    },
    // Someone opens the activity.
    arrive(id) {
      memberIds.push(id);
      for (const client of clients.values()) client.session.setParticipants(memberIds.map(person));
      add(id);
      init(id);
      flush();
    },
    // Someone closes the activity.
    leave(id) {
      clients.get(id).session.destroy();
      clients.delete(id);
      memberIds = memberIds.filter((member) => member !== id);
      for (const client of clients.values()) client.session.setParticipants(memberIds.map(person));
      flush();
    },
    reload(id) {
      clients.get(id).session.destroy();
      add(id);
      init(id);
      flush();
    },
    newSession() {
      sessionId = 'new-session';
      for (const id of memberIds) init(id);
      flush();
    },
    packet(kind, extra = {}) {
      const state = net.state();
      return { protocol: GAME_PROTOCOL, sessionId, hostId: memberIds[0], kind, round: state.round, rolls: state.rolls, ...extra };
    },
    assertConverged() {
      const host = clients.get(memberIds[0]).view;
      for (const client of clients.values()) {
        assert.equal(client.view.connected, true);
        assert.deepEqual(client.view.state, host.state);
        assert.equal(client.view.hostId, memberIds[0]);
      }
    },
  };

  if (!lobby) {
    for (const id of initialIds) net.sit(id);
    if (net.state().players.filter((id) => id !== null).length >= 2) net.start(initialIds[0]);
  }
  return net;
}

// ---------- Lobby ----------

test('the lobby: nobody is seated until they join, a fifth person spectates, and anyone seated can start', () => {
  const net = network([1, 2, 3, 4, 5], { lobby: true });
  assert.equal(net.state().phase, 'lobby');
  assert.deepEqual(net.state().players, [null, null, null, null]);
  net.start(1);
  assert.equal(net.state().phase, 'lobby');
  for (const id of [3, 1, 5, 2, 4]) net.sit(id);
  assert.deepEqual(net.state().players, [3, 1, 5, 2]);
  net.stand(5);
  assert.deepEqual(net.state().players, [3, 1, null, 2]);
  net.sit(4);
  assert.deepEqual(net.state().players, [3, 1, 4, 2]);
  // Spectators cannot start or change the options.
  net.stand(4);
  net.options(4, { mode: 'chaos' });
  net.start(4);
  assert.deepEqual([net.state().phase, net.state().mode], ['lobby', 'classic']);
  net.assertConverged();
  net.start(2);
  assert.equal(net.state().phase, 'playing');
  assert.deepEqual(net.state().players, [3, 1, null, 2]);
  net.assertConverged();
});

test('pieces and options are picked in the lobby and locked once the game starts', () => {
  const net = network([1, 2, 3], { lobby: true });
  net.sit(1);
  net.sit(2);
  net.piece(1, 'duck');
  net.piece(2, 'not-a-piece');
  net.piece(3, 'dino');
  assert.deepEqual(net.state().pieces, ['duck', 'counter', null, null]);
  net.options(2, { mode: 'chaos', turnSeconds: 8, theme: 'space' });
  net.options(1, { turnSeconds: 99 });
  net.options(1, { turnSeconds: 4 });
  assert.deepEqual([net.state().mode, net.state().turnSeconds, net.state().theme], ['chaos', 8, 'space']);
  net.start(1);
  net.options(1, { mode: 'classic', turnSeconds: 20 });
  net.piece(1, 'ghost');
  assert.deepEqual([net.state().mode, net.state().turnSeconds, net.state().pieces[0]], ['chaos', 8, 'duck']);
  // Chaos deals one attack and one power-up for yourself.
  assert.deepEqual(net.state().hands.map((hand) => hand.length), [2, 2, 0, 0]);
  net.assertConverged();
});

test('nobody joins halfway: late arrivals spectate until the game returns to the lobby', () => {
  const net = network([1, 2], { dice: [3, 5] });
  net.roll(1);
  net.arrive(3);
  assert.deepEqual(net.state().players, [1, 2, null, null]);
  assert.match(net.view(3).notice, /spectating/);
  net.roll(3);
  net.clients.get(3).session.join();
  net.flush();
  assert.deepEqual(net.state().players, [1, 2, null, null]);
  net.roll(2);
  assert.deepEqual(net.state().positions, [3, 5, 0, 0]);
  net.playToWin();
  net.lobby(3);
  assert.equal(net.state().phase, 'playing');
  net.lobby(2);
  assert.deepEqual([net.state().phase, net.state().round, net.state().scores, net.state().positions], ['lobby', 1, [0, 0, 0, 0], [0, 0, 0, 0]]);
  net.sit(3);
  assert.deepEqual(net.state().players, [1, 2, 3, null]);
  net.start(3);
  assert.equal(net.state().phase, 'playing');
  net.assertConverged();
});

// ---------- Playing ----------

test('the host rolls for everyone: its own turns, guest requests, and never for spectators', () => {
  const net = network([1, 2, 3, 4, 5], { dice: [3, 5, 2] });
  assert.deepEqual(net.state().players, [1, 2, 3, 4]);
  net.roll(1);
  net.roll(2);
  net.roll(5);
  assert.deepEqual(net.state().positions, [3, 5, 0, 0]);
  assert.equal(net.state().turn, 2);
  assert.match(net.view(5).notice, /spectating/);
  assert.equal(net.clients.get(2).rolled, 0);
  assert.deepEqual(net.dice, [2]);
  net.assertConverged();
});

test('host rejects wrong-turn, spectator, stale, spoofed and chosen-die proposals', () => {
  const net = network([1, 2, 3, 4, 5], { dice: [2] });
  const host = net.clients.get(1).session;
  const base = net.state().revision;
  for (const [from, packet] of [
    [2, net.packet('roll')],
    [5, net.packet('roll', { playerId: 1 })],
    [99, net.packet('roll')],
    [1, net.packet('roll', { rolls: -1 })],
    [1, net.packet('roll', { rolls: 1 })],
    [1, net.packet('roll', { round: 2 })],
    [1, net.packet('roll', { sessionId: 'old' })],
    [1, net.packet('roll', { protocol: 'other-app/1' })],
    [1, net.packet('roll', { hostId: 2 })],
    [1, net.packet('move', { index: 0 })],
    [1, net.packet('rematch')],
    [5, net.packet('join')],
  ]) host.receive(from, packet);
  net.flush();
  assert.equal(net.state().revision, base);
  assert.deepEqual(net.dice, [2]);
  const proposal = net.packet('roll', { die: 6 });
  host.receive(1, proposal);
  host.receive(1, proposal);
  net.flush();
  assert.equal(net.state().revision, base + 1);
  assert.equal(net.state().positions[0], 2);
  net.assertConverged();
});

test('host reload restores the saved game and remains playable', () => {
  const net = network([1, 2], { dice: [3, 5, 2] });
  net.roll(1);
  net.roll(2);
  const before = net.state().revision;
  net.reload(1);
  assert.equal(net.state().revision, before);
  net.roll(1);
  net.assertConverged();
  assert.deepEqual(net.view(2).state.positions, [5, 5, 0, 0]);
});

test('a host reload with storage disabled resynchronizes on a fresh lobby instead of deadlocking', () => {
  const net = network([1, 2], { persistence: false, dice: [3, 5, 2, 1] });
  net.roll(1);
  net.roll(2);
  net.reload(1);
  assert.equal(net.state().phase, 'lobby');
  net.assertConverged();
  net.sit(1);
  net.sit(2);
  net.start(2);
  net.roll(1);
  net.roll(2);
  assert.deepEqual(net.view(2).state.positions, [2, 1, 0, 0]);
  net.assertConverged();
});

test('duplicate initialization preserves a live game', () => {
  const net = network([1, 2], { dice: [3] });
  net.roll(1);
  const before = net.state().revision;
  net.init(1);
  net.init(2);
  net.flush();
  assert.equal(net.state().revision, before);
  assert.equal(net.view(2).state.positions[0], 3);
  net.assertConverged();
});

test('malformed, wrong-host, wrong-roster and stale snapshots do not alter the game', () => {
  const net = network([1, 2, 3], { dice: [3] });
  const old = structuredClone(net.state());
  net.roll(1);
  const current = structuredClone(net.view(2).state);
  const guest = net.clients.get(2).session;
  const valid = net.packet('state', { members: [1, 2, 3], state: current });
  for (const packet of [null, {}, { ...valid, state: {} }, { ...valid, members: [1, 2] },
    { ...valid, state: { ...current, positions: [100, 100, 100, 100] } },
    { ...valid, state: { ...current, scores: [-1, 0, 0, 0] } },
    { ...valid, state: { ...current, players: [1, 999, 3, null] } },
    { ...valid, state: { ...current, turnSeconds: 2 } },
    { ...valid, state: { ...current, phase: 'lobby' } },
    { ...valid, sessionId: 'wrong-session' }, { ...valid, state: old },
  ]) guest.receive(1, packet);
  guest.receive(3, { ...valid, state: playRoll(current, 2, 4) });
  assert.deepEqual(net.view(2).state, current);
  net.flush();
  net.assertConverged();
});

test('a completed round can be rematched once by any seated player', () => {
  const net = network([1, 2, 3, 4, 5]);
  net.rematch(1);
  assert.equal(net.state().round, 1);
  const winner = net.playToWin();
  assert.equal(net.state().positions[winner], 100);
  const finished = net.state().revision;
  net.roll(net.state().players[winner]);
  assert.equal(net.state().revision, finished);
  net.rematch(5);
  assert.equal(net.state().round, 1);
  const stale = net.packet('rematch');
  net.rematch(3);
  net.clients.get(1).session.receive(2, stale);
  net.flush();
  assert.equal(net.state().round, 2);
  assert.equal(net.state().turn, 1);
  assert.deepEqual(net.state().positions, [0, 0, 0, 0]);
  assert.equal(net.state().scores[winner], 1);
  net.roll(2);
  net.assertConverged();
});

test('a player who leaves gives up their seat for good, and a game left with one player returns to the lobby', () => {
  const net = network([1, 2, 3, 4, 5], { dice: [3] });
  net.roll(1);
  assert.equal(net.state().turn, 1);
  net.leave(2);
  assert.deepEqual(net.state().players, [1, null, 3, 4]);
  assert.deepEqual(net.state().positions, [3, 0, 0, 0]);
  assert.equal(net.state().turn, 2);
  net.leave(3);
  net.leave(4);
  assert.equal(net.state().phase, 'lobby');
  assert.deepEqual(net.state().players, [1, null, null, null]);
  assert.match(net.view(1).notice, /lobby/);
  net.assertConverged();
});

test('host departure elects the first remaining member and the game carries on', () => {
  const net = network([1, 2, 3], { dice: [3, 5, 2] });
  net.roll(1);
  net.roll(2);
  const oldPacket = net.packet('state', { state: structuredClone(net.state()), members: [1, 2, 3] });
  net.leave(1);
  assert.equal(net.view(2).isHost, true);
  assert.deepEqual(net.state().players, [null, 2, 3, null]);
  assert.deepEqual(net.state().positions, [0, 5, 0, 0]);
  assert.equal(net.state().turn, 2);
  assert.match(net.view(2).notice, /left/);
  net.clients.get(3).session.receive(1, oldPacket);
  net.roll(3);
  assert.deepEqual(net.state().positions, [0, 5, 2, 0]);
  net.assertConverged();
});

test('host recovery converges even when the new host missed the previous last roll', () => {
  const net = network([1, 2, 3], { dice: [3] });
  const before = net.state().revision;
  net.clients.get(1).session.roll();
  const last = net.queue.pop();
  net.clients.get(3).session.receive(last.from, last.data);
  assert.equal(net.view(2).state.revision, before);
  assert.equal(net.view(3).state.revision, before + 1);
  net.leave(1);
  net.assertConverged();
  assert.deepEqual(net.view(3).state.players, [null, 2, 3, null]);
});

test('a new activity session starts in a fresh lobby and ignores old-session traffic', () => {
  const net = network([1, 2], { dice: [3] });
  net.roll(1);
  const old = net.packet('roll');
  net.newSession();
  net.clients.get(1).session.receive(2, old);
  assert.equal(net.state().phase, 'lobby');
  assert.deepEqual(net.state().players, [null, null, null, null]);
  net.assertConverged();
});

test('roster events before init are buffered, and destroy prevents further work', () => {
  let view;
  const sent = [];
  const session = createSession({ storage: null, send: (packet) => sent.push(packet), onChange: (next) => { view = next; } });
  session.setParticipants([person(1), person(2), person(3)]);
  session.init({ sessionId: 'a', self: person(1), participants: [person(1), person(2)] });
  assert.equal(view.participants.length, 3);
  session.join();
  assert.deepEqual(view.state.players, [1, null, null, null]);
  const before = sent.length;
  session.destroy();
  session.roll();
  session.sync();
  session.init({ sessionId: 'b', self: person(1), participants: [person(1), person(2)] });
  assert.equal(sent.length, before);
});

test('unavailable or corrupt browser storage never prevents a live game', () => {
  for (const storage of [
    { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } },
    { getItem() { return '{not json'; }, setItem() {} },
    { getItem() { return JSON.stringify({ state: {}, members: [1, 2], hostId: 1 }); }, setItem() {} },
  ]) {
    let view;
    const session = createSession({ storage, rollDie: () => 3, send() {}, onChange: (next) => { view = next; } });
    session.init({ sessionId: 'a', self: person(1), participants: [person(1), person(2)] });
    session.join();
    session.choosePiece('robot');
    assert.deepEqual([view.state.players[0], view.state.pieces[0]], [1, 'robot']);
  }
});

// ---------- Themes ----------

test('anyone in the activity can change the shared board theme, and it outlasts rounds and reloads', () => {
  const net = network([1, 2, 3, 4, 5], { dice: [3] });
  net.theme(2, 'jungle');
  assert.equal(net.view(5).state.theme, 'jungle');
  net.theme(5, 'space');
  assert.equal(net.view(1).state.theme, 'space');
  net.theme(1, 'christmas');
  net.assertConverged();
  const host = net.clients.get(1).session;
  const before = net.state().revision;
  for (const theme of ['lava', 42, null, 'christmas']) host.receive(2, net.packet('theme', { theme }));
  net.flush();
  assert.equal(net.state().revision, before);
  net.roll(1);
  net.reload(1);
  net.reload(3);
  net.leave(2);
  assert.equal(net.state().theme, 'christmas');
  net.playToWin();
  net.rematch(1);
  assert.equal(net.state().theme, 'christmas');
  net.assertConverged();
});

test('theme spam is rate limited and never voids, replays, or skips a roll', () => {
  const net = network([1, 2, 3], { dice: [3, 2] });
  net.roll(1);
  assert.equal(net.state().turn, 1);
  // Sam asks to roll; before the host sees it, the board theme changes.
  const request = { from: 2, packet: net.packet('roll') };
  net.theme(3, 'space');
  const sentBefore = net.sent.length;
  for (let i = 0; i < 20; i += 1) net.theme(i % 2 ? 2 : 3, i % 2 ? 'jungle' : 'christmas', { wait: false });
  // Only Sam's and Taylor's requests went out; the host broadcast nothing for them.
  assert.ok(net.sent.slice(sentBefore).every((message) => message.from !== 1));
  assert.equal(net.state().theme, 'space');
  net.clients.get(1).session.receive(request.from, request.packet);
  net.flush();
  assert.deepEqual(net.state().positions, [3, 2, 0, 0]);
  assert.equal(net.state().rolls, 2);
  assert.equal(net.state().turn, 2);
  // Replaying the same request cannot roll Sam twice.
  net.clients.get(1).session.receive(request.from, request.packet);
  net.flush();
  assert.equal(net.state().rolls, 2);
  net.assertConverged();
});

test('the host starts a new lobby on its preferred board', () => {
  const sent = [];
  let view;
  const session = createSession({ storage: null, theme: 'space', send: (packet) => sent.push(packet), onChange: (next) => { view = next; } });
  session.init({ sessionId: 'a', self: person(1), participants: [person(1), person(2)] });
  assert.equal(view.state.theme, 'space');
  assert.equal(view.state.phase, 'lobby');
  assert.equal(sent.at(-1).state.theme, 'space');
});

// ---------- Turn clock ----------

test('a turn times out on the host, passes on, and restarts for every new turn but not for themes', () => {
  const net = network([1, 2, 3], { dice: [3] });
  const limit = TURN_MS + TURN_GRACE_MS;
  net.advance(limit - 1);
  assert.equal(net.state().turn, 0);
  net.advance(1);
  assert.deepEqual([net.state().turn, net.state().lastSkip], [1, 0]);
  net.assertConverged();
  // A theme change does not give Sam more time.
  net.advance(5000);
  net.theme(2, 'jungle', { wait: false });
  net.advance(limit - 5000);
  assert.equal(net.state().turn, 2);
  // A roll starts a fresh turn, with time for the throw to land first.
  net.roll(3);
  assert.equal(net.state().turn, 0);
  net.advance(TURN_SETTLE_MS + limit - 1);
  assert.equal(net.state().turn, 0);
  net.advance(1);
  assert.equal(net.state().turn, 1);
  assert.equal(net.state().skips, 3);
  net.assertConverged();
});

test('the lobby sets the turn length, and there is no clock in the lobby or between rounds', () => {
  const net = network([1, 2], { lobby: true });
  assert.equal(net.timers(), 0);
  net.sit(1);
  net.sit(2);
  net.options(1, { turnSeconds: 5 });
  net.start(2);
  assert.equal(net.timers(), 1);
  net.advance(5000 + TURN_GRACE_MS - 1);
  assert.equal(net.state().turn, 0);
  net.advance(1);
  assert.equal(net.state().turn, 1);
  net.playToWin();
  assert.equal(net.timers(), 0);
  net.advance(TURN_MS * 3);
  assert.equal(net.state().skips, 1);
  net.rematch(2);
  assert.equal(net.timers(), 1);
  net.assertConverged();
});

test('a new host takes over the clock', () => {
  const net = network([1, 2, 3]);
  net.leave(1);
  assert.equal(net.view(2).isHost, true);
  const turn = net.state().turn;
  net.advance(TURN_MS + TURN_GRACE_MS);
  assert.notEqual(net.state().turn, turn);
  net.assertConverged();
});

// ---------- Chaos ----------

test('chaos: hands are dealt at the start, a 3 earns another, and power-ups sync once per turn', () => {
  const net = network([1, 2, 3, 4, 5], { lobby: true, dice: [3, 2] });
  for (const id of [1, 2, 3, 4, 5]) net.sit(id);
  net.options(5, { mode: 'chaos' });
  assert.equal(net.state().mode, 'classic');
  net.options(2, { mode: 'chaos' });
  net.start(1);
  assert.equal(net.state().mode, 'chaos');
  assert.deepEqual(net.state().hands.map((hand) => hand.length), [2, 2, 2, 2]);
  net.assertConverged();
  // Only the player whose turn it is can play, once per turn.
  net.power(2, 0, 0);
  assert.equal(net.state().powers, 0);
  const power = net.state().hands[0][0];
  const target = ['bite', 'swap', 'freeze', 'banana'].includes(power) ? 1 : null;
  net.power(1, 0, target);
  assert.equal(net.state().powers, 1);
  assert.equal(net.state().hands[0].length, 1);
  net.power(1, 0, target);
  assert.equal(net.state().powers, 1);
  // Rolling a 3 wins another power-up.
  net.roll(1);
  assert.equal(net.state().hands[0].length, 2);
  assert.ok(net.state().lastBonus);
  // A replayed power-up request is refused.
  net.clients.get(1).session.receive(2, net.packet('power', { slot: 0, target: 0, powers: 0, rolls: 0 }));
  net.flush();
  assert.equal(net.state().powers, 1);
  net.assertConverged();
});
