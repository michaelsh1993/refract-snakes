const PROTOCOL = 'refract-activity/1';
const MAX_BYTES = 16 * 1024;
const APP_URL = new URL('../index.html?embedded=1', window.location.href);
const USERS = [
  { id: 1, name: 'Alex', avatarUrl: null },
  { id: 2, name: 'Sam', avatarUrl: null },
  { id: 3, name: 'Taylor', avatarUrl: null },
  { id: 4, name: 'Jordan', avatarUrl: null },
  { id: 5, name: 'Riley', avatarUrl: null },
];
// Alex and Sam are always shown; the others come and go with the toolbar.
const CORE = 2;

const views = document.getElementById('views');
const addParticipant = document.getElementById('add-participant');
const removeLast = document.getElementById('remove-participant');
const themeSelect = document.getElementById('activity-theme');
const eventLog = document.getElementById('event-log');
const clients = new Map();
let participants = [USERS[0], USERS[1]];
let sessionNumber = 1;
let sessionId = makeSessionId();
let eventCount = 0;

function makeSessionId() {
  return `local-preview-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function log(message) {
  eventCount += 1;
  const item = document.createElement('li');
  item.textContent = `${String(eventCount).padStart(3, '0')}  ${message}`;
  eventLog.prepend(item);
  while (eventLog.children.length > 12) eventLog.lastElementChild.remove();
  document.getElementById('event-count').textContent = `${eventCount} events`;
}

function post(client, message) {
  client.frame?.contentWindow?.postMessage({ protocol: PROTOCOL, ...message }, APP_URL.origin);
}

function initialize(client) {
  if (!participants.some((user) => user.id === client.user.id)) return;
  post(client, {
    type: 'init',
    sessionId,
    channelId: 1,
    self: client.user,
    participants,
    theme: themeSelect.value,
  });
  log(`init → ${client.user.name}`);
}

function updateRoster() {
  const extras = participants.filter((user) => user.id > CORE);
  addParticipant.disabled = extras.length === USERS.length - CORE;
  removeLast.disabled = extras.length === 0;
  document.getElementById('participant-summary').textContent = `${participants.length} participant${participants.length === 1 ? '' : 's'}`;
  for (const user of participants) post(clients.get(user.id), { type: 'participants', participants });
  log(`participants → ${participants.map((user) => user.name).join(', ') || 'empty'}`);
}

function mountFrame(client) {
  const frame = document.createElement('iframe');
  frame.title = `${client.user.name}'s Refract activity`;
  frame.dataset.participantId = String(client.user.id);
  frame.src = APP_URL.href;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups');
  frame.setAttribute('allow', 'autoplay; fullscreen; clipboard-write');
  frame.referrerPolicy = 'no-referrer';
  frame.addEventListener('load', () => {
    if (client.frame === frame) initialize(client);
  });
  client.frame = frame;
  client.container.replaceChildren(frame);
  client.status.textContent = `User ${client.user.id} · connected`;
  client.refresh.textContent = `Refresh ${client.user.name}`;
}

function showLeft(client) {
  client.frame = null;
  client.status.textContent = `User ${client.user.id} · left the activity`;
  client.refresh.textContent = `Rejoin ${client.user.name}`;
  const empty = document.createElement('div');
  empty.className = 'empty-view';
  const title = document.createElement('strong');
  title.textContent = `${client.user.name} left the activity`;
  const explanation = document.createElement('p');
  explanation.textContent = 'The session continues for the other participants. Rejoin to receive the current game.';
  const join = document.createElement('button');
  join.type = 'button';
  join.className = 'primary';
  join.textContent = `Join as ${client.user.name}`;
  join.addEventListener('click', () => joinParticipant(client.user));
  empty.append(title, explanation, join);
  client.container.replaceChildren(empty);
}

function makeCard(user) {
  const card = document.createElement('article');
  card.className = 'view';
  card.dataset.player = String(user.id);
  const header = document.createElement('header');
  header.className = 'view-header';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = user.name.slice(0, 1);
  avatar.setAttribute('aria-hidden', 'true');
  const person = document.createElement('div');
  person.className = 'person';
  const name = document.createElement('h2');
  name.textContent = user.name;
  const status = document.createElement('p');
  person.append(name, status);
  const refresh = document.createElement('button');
  refresh.type = 'button';
  const container = document.createElement('div');
  container.className = 'frame-container';
  header.append(avatar, person, refresh);
  card.append(header, container);
  views.append(card);
  const client = { user, card, status, refresh, container, frame: null };
  clients.set(user.id, client);
  refresh.addEventListener('click', () => {
    if (!participants.some((current) => current.id === user.id)) {
      joinParticipant(user);
    } else {
      log(`Refreshing ${user.name}; session preserved`);
      mountFrame(client);
    }
  });
  return client;
}

function joinParticipant(user) {
  if (participants.some((current) => current.id === user.id)) return;
  if (!participants.length) {
    sessionId = makeSessionId();
    sessionNumber += 1;
    document.getElementById('session-number').textContent = String(sessionNumber).padStart(2, '0');
  }
  const client = clients.get(user.id) ?? makeCard(user);
  participants = [...participants, user];
  client.card.hidden = false;
  updateRoster();
  mountFrame(client);
}

function removeParticipant(userId) {
  const client = clients.get(userId);
  if (!client || !participants.some((user) => user.id === userId)) return;
  participants = participants.filter((user) => user.id !== userId);
  showLeft(client);
  if (userId > CORE) client.card.hidden = true;
  updateRoster();
}

function validBroadcast(message) {
  if (!Object.hasOwn(message, 'data')) return false;
  if (message.to !== undefined && (!Array.isArray(message.to) || message.to.length > 100 || !message.to.every((id) => Number.isSafeInteger(id) && id > 0))) return false;
  try {
    const json = JSON.stringify(message.data);
    return json !== undefined && new TextEncoder().encode(json).length <= MAX_BYTES;
  } catch {
    return false;
  }
}

window.addEventListener('message', (event) => {
  if (event.origin !== APP_URL.origin) return;
  const sender = [...clients.values()].find((client) => client.frame?.contentWindow === event.source);
  if (!sender || !participants.some((user) => user.id === sender.user.id)) return;
  const message = event.data;
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.protocol !== PROTOCOL) return;
  if (message.type === 'ready') {
    initialize(sender);
  } else if (message.type === 'close') {
    log(`close ← ${sender.user.name}`);
    removeParticipant(sender.user.id);
  } else if (message.type === 'broadcast' && validBroadcast(message)) {
    const targets = participants.filter((user) => user.id !== sender.user.id && (!message.to || message.to.includes(user.id)));
    for (const target of targets) post(clients.get(target.id), { type: 'message', from: sender.user.id, data: message.data });
    const kind = typeof message.data?.kind === 'string' ? message.data.kind.slice(0, 40) : 'data';
    log(`${sender.user.name} → ${targets.map((user) => user.name).join(', ') || 'no recipients'} · ${kind}`);
  }
});

document.getElementById('new-session').addEventListener('click', () => {
  sessionId = makeSessionId();
  sessionNumber += 1;
  document.getElementById('session-number').textContent = String(sessionNumber).padStart(2, '0');
  participants = USERS.filter((user) => user.id <= CORE || participants.some((current) => current.id === user.id));
  // Detach every old frame before starting either new one.
  for (const client of clients.values()) {
    client.frame = null;
    client.container.replaceChildren();
  }
  for (const user of participants) {
    const client = clients.get(user.id) ?? makeCard(user);
    client.card.hidden = false;
    mountFrame(client);
  }
  log('Started a new local session');
  updateRoster();
});

addParticipant.addEventListener('click', () => {
  const next = USERS.find((user) => user.id > CORE && !participants.some((current) => current.id === user.id));
  if (next) joinParticipant(next);
});

removeLast.addEventListener('click', () => {
  const last = participants.findLast((user) => user.id > CORE);
  if (last) removeParticipant(last.id);
});

themeSelect.addEventListener('change', () => {
  for (const user of participants) initialize(clients.get(user.id));
});

for (const user of participants) makeCard(user);
for (const user of participants) mountFrame(clients.get(user.id));
updateRoster();
