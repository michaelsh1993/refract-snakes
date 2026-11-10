import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_PROTOCOL, connectActivity } from '../src/bridge.js';

const HOST_ORIGIN = 'https://refract.example';
const ALEX = { id: 1, name: 'Alex', avatarUrl: null };
const SAM = { id: 2, name: 'Sam', avatarUrl: 'https://refract.example/sam.png' };

function init(overrides = {}) {
  return {
    protocol: ACTIVITY_PROTOCOL,
    type: 'init',
    sessionId: 'session-one',
    channelId: 42,
    self: ALEX,
    participants: [ALEX, SAM],
    theme: 'dark',
    ...overrides,
  };
}

function harness({ topLevel = false } = {}) {
  const sent = [];
  const received = { init: [], participants: [], messages: [] };
  const listeners = new Set();
  const host = { postMessage: (message, origin) => sent.push({ message, origin }) };
  const scope = {
    parent: host,
    postMessage: host.postMessage,
    addEventListener(type, listener) {
      assert.equal(type, 'message');
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'message');
      listeners.delete(listener);
    },
  };
  if (topLevel) scope.parent = scope;
  const client = connectActivity({
    scope,
    onInit: (message) => received.init.push(message),
    onParticipants: (people) => received.participants.push(people),
    onMessage: (from, data) => received.messages.push({ from, data }),
  });
  return {
    sent,
    received,
    listeners,
    client,
    scope,
    emit(data, { source = scope.parent, origin = HOST_ORIGIN } = {}) {
      for (const listener of listeners) listener({ source, origin, data });
    },
  };
}

test('ignores foreign windows, protocols, malformed initialization, and opaque origins', () => {
  const h = harness();
  h.emit(init(), { source: {} });
  h.emit(init({ protocol: 'another-activity/1' }));
  h.emit(null);
  h.emit([]);
  h.emit('init');
  const invalid = [
    { sessionId: '' },
    { sessionId: 1 },
    { channelId: 0 },
    { channelId: 1.5 },
    { self: { ...ALEX, id: '1' } },
    { self: { ...ALEX, avatarUrl: undefined } },
    { participants: [SAM] },
    { participants: [ALEX, ALEX] },
    { participants: [{ ...ALEX, name: null }] },
    { participants: [ALEX, { ...SAM, id: Number.MAX_SAFE_INTEGER + 1 }] },
    { participants: {} },
    { theme: 'system' },
  ];
  for (const overrides of invalid) h.emit(init(overrides), { origin: 'https://invalid.example' });
  h.emit(init(), { origin: 'null' });
  h.emit(init(), { origin: '' });
  assert.equal(h.received.init.length, 0);

  h.emit(init());
  assert.deepEqual(h.received.init, [init()]);
  h.client.ready();
  assert.equal(h.sent.at(-1).origin, HOST_ORIGIN, 'invalid initialization must not pin its origin');
});

test('ignores rosters and relayed messages before initialization, then validates their shapes', () => {
  const h = harness();
  const roster = { protocol: ACTIVITY_PROTOCOL, type: 'participants', participants: [ALEX] };
  const message = { protocol: ACTIVITY_PROTOCOL, type: 'message', from: 2, data: { move: 4 } };
  h.emit(roster);
  h.emit(message);
  h.client.broadcast({ move: 0 });
  assert.deepEqual(h.received.participants, []);
  assert.deepEqual(h.received.messages, []);
  assert.equal(h.sent.length, 1, 'only ready is sent before initialization');

  h.emit(init());
  h.emit({ ...roster, participants: [ALEX, ALEX] });
  h.emit({ ...message, from: '2' });
  h.emit({ ...message, from: -1 });
  h.emit({ protocol: ACTIVITY_PROTOCOL, type: 'message', from: 2 });
  h.emit(roster);
  h.emit(message);
  assert.deepEqual(h.received.participants, [[ALEX]]);
  assert.deepEqual(h.received.messages, [{ from: 2, data: { move: 4 } }]);
});

test('pins the valid host origin while accepting repeated and new-session initialization', () => {
  const h = harness();
  h.emit(init());
  h.emit(init({ theme: 'light' }));
  h.emit(init({ sessionId: 'session-two' }));
  h.emit(init({ sessionId: 'foreign-session' }), { origin: 'https://other.example' });
  h.emit({ protocol: ACTIVITY_PROTOCOL, type: 'participants', participants: [ALEX] }, { origin: 'https://other.example' });
  h.emit({ protocol: ACTIVITY_PROTOCOL, type: 'message', from: 2, data: 'forged' }, { source: {} });
  h.emit({ protocol: ACTIVITY_PROTOCOL, type: 'message', from: 2, data: 'forged' }, { origin: 'https://other.example' });
  assert.deepEqual(h.received.init.map((value) => [value.sessionId, value.theme]), [
    ['session-one', 'dark'],
    ['session-one', 'light'],
    ['session-two', 'dark'],
  ]);
  assert.deepEqual(h.received.participants, []);
  assert.deepEqual(h.received.messages, []);
});

test('sends ready to a wildcard initially, then sends ready, broadcast, and close to the host origin', () => {
  const h = harness();
  h.client.ready();
  assert.deepEqual(h.sent, [
    { message: { protocol: ACTIVITY_PROTOCOL, type: 'ready' }, origin: '*' },
    { message: { protocol: ACTIVITY_PROTOCOL, type: 'ready' }, origin: '*' },
  ]);
  h.emit(init());
  h.client.ready();
  h.client.broadcast({ move: 4 });
  h.client.broadcast({ state: 'snapshot' }, [2]);
  h.client.broadcast({ noRecipients: true }, []);
  h.client.close();
  assert.deepEqual(h.sent.slice(2), [
    { message: { protocol: ACTIVITY_PROTOCOL, type: 'ready' }, origin: HOST_ORIGIN },
    { message: { protocol: ACTIVITY_PROTOCOL, type: 'broadcast', data: { move: 4 } }, origin: HOST_ORIGIN },
    { message: { protocol: ACTIVITY_PROTOCOL, type: 'broadcast', data: { state: 'snapshot' }, to: [2] }, origin: HOST_ORIGIN },
    { message: { protocol: ACTIVITY_PROTOCOL, type: 'broadcast', data: { noRecipients: true }, to: [] }, origin: HOST_ORIGIN },
    { message: { protocol: ACTIVITY_PROTOCOL, type: 'close' }, origin: HOST_ORIGIN },
  ]);
  assert.deepEqual(h.received.messages, [], 'outgoing messages are not locally echoed');
});

test('enforces JSON payload limits in UTF-8 bytes and rejects invalid recipients', () => {
  const h = harness();
  h.emit(init());
  h.client.broadcast('a'.repeat(16 * 1024 - 2));
  assert.equal(h.sent.length, 2, 'the JSON quotes count toward the exact 16 KiB limit');
  assert.throws(() => h.client.broadcast('a'.repeat(16 * 1024 - 1)), /16 KiB/);
  h.client.broadcast('😀'.repeat(4095));
  assert.throws(() => h.client.broadcast('😀'.repeat(4096)), /16 KiB/);
  const sentBeforeInvalid = h.sent.length;
  for (const to of [null, 2, '2', [0], [-2], ['2'], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => h.client.broadcast({ move: 0 }, to), /Recipients/);
  }
  assert.throws(() => h.client.broadcast(undefined), /JSON/);
  assert.throws(() => h.client.broadcast(() => 'not JSON'), /JSON/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => h.client.broadcast(circular), TypeError);
  assert.throws(() => h.client.broadcast(1n), TypeError);
  assert.equal(h.sent.length, sentBeforeInvalid, 'invalid payloads never reach the host');
});

test('destroy disconnects the listener and makes all outbound methods inert', () => {
  const h = harness();
  h.emit(init());
  assert.equal(h.listeners.size, 1);
  const listener = [...h.listeners][0];
  const sentBeforeDestroy = h.sent.length;
  h.client.destroy();
  h.client.destroy();
  assert.equal(h.listeners.size, 0);
  h.client.ready();
  h.client.broadcast({ move: 0 });
  h.client.close();
  h.emit(init({ sessionId: 'ignored-after-destroy' }));
  listener({ source: h.scope.parent, origin: HOST_ORIGIN, data: init() });
  assert.equal(h.sent.length, sentBeforeDestroy);
  assert.equal(h.received.init.length, 1);
});

test('a standalone top-level page neither posts nor accepts its own activity messages', () => {
  const h = harness({ topLevel: true });
  h.emit(init());
  h.emit({ protocol: ACTIVITY_PROTOCOL, type: 'participants', participants: [ALEX] });
  h.emit({ protocol: ACTIVITY_PROTOCOL, type: 'message', from: 2, data: { move: 0 } });
  h.client.ready();
  h.client.broadcast({ move: 1 });
  h.client.close();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.received, { init: [], participants: [], messages: [] });
  h.client.destroy();
  assert.equal(h.listeners.size, 0);
});
