import { BOARD_THEMES, LADDERS, LAST_SQUARE, SEATS, SNAKES, boardTheme, createGame, nextRound, playRoll, rollDie } from './game.js';
import { THEME_COOLDOWN_MS, createSession } from './session.js';
import { connectActivity } from './bridge.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const COLOURS = ['cyan', 'orange', 'violet', 'green'];
const tokens = [...document.querySelectorAll('.token')];
const embedded = window.parent !== window || new URLSearchParams(location.search).get('embedded') === '1';
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
// The last board picked here, used to start local games and any game this viewer hosts.
const THEME_KEY = 'refract-snakes-and-ladders:board-theme';
function savedBoardTheme() {
  try { return boardTheme(localStorage.getItem(THEME_KEY)); } catch { return 'classic'; }
}
function saveBoardTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* The choice simply is not remembered. */ }
}
// Calm effects: a per-viewer switch that stops flashing, twinkling, and flickering.
const CALM_KEY = 'refract-snakes-and-ladders:calm-effects';
let calmEffects = false;
try { calmEffects = localStorage.getItem(CALM_KEY) === 'on'; } catch { /* Defaults to off. */ }
function showCalm() {
  document.documentElement.dataset.calm = calmEffects ? 'on' : 'off';
  document.getElementById('calm-toggle')?.setAttribute('aria-checked', String(calmEffects));
}
showCalm();
let mode = 'computer';
let playerCount = 2;
let localState = createGame(localPlayers(), savedBoardTheme());
let liveView = null;
let bridge = null;
let computerTimer = null;
let handshakeTimer = null;
let retryTimer = null;
let lastStatus = '';
let lastDetail = '';
// Token animation: `shown` is where each token is currently drawn.
let shown = [0, 0, 0, 0];
let tokenKey = null;
let tokenState = null;
let stepTimer = null;
// A thrown die may fly for up to THROW_MS, then shows its result for THROW_HOLD_MS.
const THROW_MS = 1900;
const THROW_HOLD_MS = 1000;
let throwTimer = null;
let frame = null;
let tossed = false;
let rollSeat = null;
// The big die is a small physics body: 'ready' waiting in the middle of the screen,
// 'held' on a spring under the pointer, 'flying' free across the screen, 'rest' once
// it has landed, and 'away' when it is not shown.
const die = { mode: 'away', x: 0, y: 0, vx: 0, vy: 0, angle: 0, spin: 0, px: 0, py: 0, grabX: 0, grabY: 0, pointer: null, travelled: 0, value: null, started: 0, last: 0 };
const inHand = () => die.mode === 'ready' || die.mode === 'held';
const overlay = $('throw');
const bigDie = $('big-die');

document.body.classList.toggle('embedded', embedded);
$('local-modes').hidden = embedded;
$('refract-info').hidden = !embedded;
// Reloading a connected activity must not silently switch it into local play.
if (embedded) {
  $('connection').dataset.state = 'waiting';
  $('connection-label').textContent = 'Connecting to Refract';
}

function localPlayers() {
  return SEATS.map((seat) => (seat < playerCount ? seat + 1 : null));
}

/** Centre of a square as a percentage of the board; square 1 is bottom-left and rows alternate direction. */
function centre(square) {
  const row = Math.floor((square - 1) / 10);
  const offset = (square - 1) % 10;
  const column = row % 2 === 0 ? offset : 9 - offset;
  return { x: column * 10 + 5, y: (9 - row) * 10 + 5 };
}

function shape(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

const fixed = (value) => value.toFixed(2);

function drawLadder(from, to) {
  const a = centre(from);
  const b = centre(to);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const px = -uy * 1.3;
  const py = ux * 1.3;
  const group = shape('g', { class: 'ladder' });
  for (const side of [-1, 1]) {
    group.append(shape('line', { x1: fixed(a.x + px * side), y1: fixed(a.y + py * side), x2: fixed(b.x + px * side), y2: fixed(b.y + py * side) }));
  }
  const rungs = Math.max(3, Math.round(length / 3.3));
  for (let rung = 1; rung < rungs; rung += 1) {
    const x = a.x + ux * length * rung / rungs;
    const y = a.y + uy * length * rung / rungs;
    group.append(shape('line', { class: 'rung', x1: fixed(x - px), y1: fixed(y - py), x2: fixed(x + px), y2: fixed(y + py) }));
  }
  return group;
}

function drawSnake(from, to, index) {
  const head = centre(from);
  const tail = centre(to);
  const length = Math.hypot(tail.x - head.x, tail.y - head.y);
  const ux = (tail.x - head.x) / length;
  const uy = (tail.y - head.y) / length;
  const waves = Math.max(2, Math.round(length / 11));
  const points = [];
  for (let step = 0; step <= 60; step += 1) {
    const t = step / 60;
    // The wave fades out at both ends so the body meets the square centres.
    const sway = Math.sin(t * Math.PI * waves) * Math.sin(t * Math.PI) * 2.3;
    points.push(`${fixed(head.x + ux * length * t - uy * sway)} ${fixed(head.y + uy * length * t + ux * sway)}`);
  }
  const d = `M${points.join('L')}`;
  const group = shape('g', { class: `snake snake-${index % 2}` });
  group.append(shape('path', { class: 'snake-body', d }), shape('path', { class: 'snake-stripe', d }));
  group.append(shape('circle', { class: 'snake-head', cx: fixed(head.x), cy: fixed(head.y), r: 2 }));
  for (const side of [-1, 1]) {
    group.append(shape('circle', { class: 'snake-eye', cx: fixed(head.x - ux * 0.5 - uy * 0.8 * side), cy: fixed(head.y - uy * 0.5 + ux * 0.8 * side), r: 0.42 }));
  }
  // Theme extras, each shown only by its own theme: a forked tongue and a Santa hat.
  const tip = { x: head.x - ux * 1.8, y: head.y - uy * 1.8 };
  const fork = { x: head.x - ux * 3.1, y: head.y - uy * 3.1 };
  group.append(shape('path', {
    class: 'snake-tongue',
    d: `M${fixed(tip.x)} ${fixed(tip.y)}L${fixed(fork.x)} ${fixed(fork.y)}` +
      `l${fixed(-ux * 0.8 - uy * 0.6)} ${fixed(-uy * 0.8 + ux * 0.6)}M${fixed(fork.x)} ${fixed(fork.y)}l${fixed(-ux * 0.8 + uy * 0.6)} ${fixed(-uy * 0.8 - ux * 0.6)}`,
  }));
  const hat = shape('g', { class: 'snake-hat', transform: `translate(${fixed(head.x)} ${fixed(head.y - 0.7)}) rotate(${index % 2 ? 14 : -14})` });
  hat.append(
    shape('path', { class: 'hat-cone', d: 'M-1.9 -0.8L1.9 -0.8L0.9 -4.9Z' }),
    shape('rect', { class: 'hat-fur', x: -2.2, y: -1.4, width: 4.4, height: 1.2, rx: 0.6 }),
    shape('circle', { class: 'hat-fur', cx: 0.9, cy: -4.9, r: 0.75 }),
  );
  group.append(hat);
  return group;
}

// Background decoration for each theme. All of it is drawn once; CSS shows the active theme's.
function drawDecor() {
  const decor = [];
  // Christmas: a string of lights along the top edge and a snow drift along the bottom.
  const festive = shape('g', { class: 'decor decor-christmas' });
  let wire = 'M0 1.4';
  for (let x = 0; x < 100; x += 5) wire += `Q${x + 2.5} 3.4 ${x + 5} 1.4`;
  festive.append(shape('path', { class: 'light-wire', d: wire }));
  for (let x = 2.5, n = 0; x < 100; x += 5, n += 1) {
    festive.append(shape('ellipse', { class: `bulb bulb-${n % 4}`, cx: x, cy: 3.1, rx: 0.75, ry: 1 }));
  }
  let drift = 'M0 100L0 98.6';
  for (let x = 0; x < 100; x += 10) drift += `Q${x + 5} ${x % 20 ? 96.9 : 97.6} ${x + 10} 98.6`;
  festive.append(shape('path', { class: 'snow-drift', d: `${drift}L100 100Z` }));
  decor.push(festive);

  // Jungle: leaves creeping in from the edges and vines hanging from the top.
  const jungle = shape('g', { class: 'decor decor-jungle' });
  for (const [x, y, angle, size] of [[0, 8, 20, 1.5], [0, 33, -15, 1.3], [0, 62, 25, 1.6], [0, 88, -20, 1.4], [100, 15, 200, 1.4], [100, 44, 165, 1.6], [100, 71, 195, 1.3], [100, 94, 160, 1.5], [22, 100, -70, 1.3], [58, 100, -110, 1.5], [83, 100, -80, 1.2]]) {
    const leaf = shape('g', { class: 'leaf', transform: `translate(${x} ${y}) rotate(${angle}) scale(${size})` });
    leaf.append(shape('path', { class: 'leaf-blade', d: 'M0 0C2 -2.6 6 -2.6 8 0C6 2.6 2 2.6 0 0Z' }), shape('path', { class: 'leaf-vein', d: 'M0.4 0L7.4 0' }));
    jungle.append(leaf);
  }
  for (const [x, length] of [[14, 9], [47, 6], [76, 11]]) {
    let vine = `M${x} 0`;
    for (let y = 0; y < length; y += 3) vine += `Q${x + (y % 6 ? -1.2 : 1.2)} ${y + 1.5} ${x} ${y + 3}`;
    jungle.append(shape('path', { class: 'vine', d: vine }));
    jungle.append(shape('path', { class: 'leaf-blade small', d: `M${x} ${length}c1 -1.2 2.6 -1.2 3.4 0c-0.8 1.2 -2.4 1.2 -3.4 0Z` }));
  }
  decor.push(jungle);

  // Space: a ringed planet, a moon, and twinkling stars.
  const space = shape('g', { class: 'decor decor-space' });
  space.append(
    shape('ellipse', { class: 'planet-ring back', cx: 84, cy: 73, rx: 9, ry: 2.4, transform: 'rotate(-18 84 73)' }),
    shape('circle', { class: 'planet', cx: 84, cy: 73, r: 5 }),
    shape('path', { class: 'planet-ring', d: 'M75.4 75.6A9 2.4 -18 0 0 92.6 70.4', transform: 'rotate(0)' }),
    shape('circle', { class: 'moon', cx: 13, cy: 54, r: 2.6 }),
    shape('circle', { class: 'crater', cx: 12.2, cy: 53.2, r: 0.6 }),
    shape('circle', { class: 'crater', cx: 14.1, cy: 55.2, r: 0.4 }),
  );
  for (const [x, y, size] of [[6, 7, 1], [31, 14, 0.7], [57, 4, 0.9], [69, 23, 0.6], [92, 33, 1.1], [41, 47, 0.7], [24, 79, 0.9], [61, 88, 0.8], [8, 94, 0.6], [95, 92, 0.8]]) {
    space.append(shape('path', { class: 'sparkle', d: `M${x} ${y - size * 1.6}Q${x} ${y} ${x + size * 1.6} ${y}Q${x} ${y} ${x} ${y + size * 1.6}Q${x} ${y} ${x - size * 1.6} ${y}Q${x} ${y} ${x} ${y - size * 1.6}Z` }));
  }
  decor.push(space);
  return decor;
}

function buildBoard() {
  const cells = [];
  for (let row = 9; row >= 0; row -= 1) {
    for (let column = 0; column < 10; column += 1) {
      const square = row * 10 + (row % 2 === 0 ? column : 9 - column) + 1;
      const cell = document.createElement('span');
      cell.className = 'cell';
      cell.dataset.square = String(square);
      cell.textContent = String(square);
      cell.classList.toggle('alt', (row + column) % 2 === 1);
      cell.classList.toggle('finish', square === LAST_SQUARE);
      cells.push(cell);
    }
  }
  $('cells').replaceChildren(...cells);
  const ladders = Object.entries(LADDERS).map(([from, to]) => drawLadder(Number(from), to));
  const snakes = Object.entries(SNAKES).map(([from, to], index) => drawSnake(Number(from), to, index));
  $('routes').replaceChildren(...drawDecor(), ...ladders, ...snakes);
}

// The board theme belongs to the game, so everyone in a shared game sees the same board.
const themeButtons = [...document.querySelectorAll('[data-board-theme]')];

// The picker rests for a moment after each change, matching the host's limit.
let themeRestUntil = 0;
function showBoardTheme(theme, ready) {
  const chosen = boardTheme(theme);
  document.documentElement.dataset.board = chosen;
  const resting = Date.now() < themeRestUntil;
  for (const button of themeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.boardTheme === chosen));
    button.disabled = !ready || resting;
  }
}

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    const theme = button.dataset.boardTheme;
    if (!BOARD_THEMES.includes(theme)) return;
    saveBoardTheme(theme);
    themeRestUntil = Date.now() + THEME_COOLDOWN_MS;
    setTimeout(render, THEME_COOLDOWN_MS + 20);
    if (embedded) session.setTheme(theme);
    else {
      localState = { ...localState, theme };
      render();
    }
  });
}

function nameFor(seat, state) {
  if (!embedded) {
    if (mode === 'local') return `Player ${seat + 1}`;
    return seat === 0 ? 'You' : playerCount === 2 ? 'Computer' : `Computer ${seat}`;
  }
  const id = state.players[seat];
  return liveView?.participants.find((person) => person.id === id)?.name ?? 'Open seat';
}

function mySeat(state) {
  if (!embedded) return mode === 'computer' ? 0 : state.turn;
  const seat = state.players.indexOf(liveView?.self?.id ?? NaN);
  return seat >= 0 ? seat : null;
}

function describeRoll(state, mine) {
  const roll = state.lastRoll;
  const you = roll.seat === mine && (embedded || mode === 'computer');
  let text = `${you ? 'You' : nameFor(roll.seat, state)} rolled ${roll.die}`;
  if (roll.via === 'overshoot') text += ` and ${you ? 'need' : 'needs'} exactly ${LAST_SQUARE - roll.from} to finish.`;
  else if (roll.via === 'ladder') text += ` and climbed a ladder from ${roll.landed} to ${roll.to}.`;
  else if (roll.via === 'snake') text += ` and slid down a snake from ${roll.landed} to ${roll.to}.`;
  else if (roll.to === LAST_SQUARE) text += ' and reached 100.';
  else text += ` and moved to ${roll.to}.`;
  if (roll.die === 6 && state.winner === null) text += ' A six: roll again.';
  return text;
}

const still = () => !!reducedMotion?.matches || document.hidden;
const launchSpeed = () => Math.max(window.innerWidth, window.innerHeight) * 2.6;

function drawDie() {
  const half = bigDie.offsetWidth / 2;
  bigDie.style.transform = `translate(${(die.x - half).toFixed(1)}px, ${(die.y - half).toFixed(1)}px) rotate(${die.angle.toFixed(1)}deg)`;
}

function rattle() {
  // A die rapidly changing faces flickers; calm effects keep one face until it lands.
  if (calmEffects) return;
  bigDie.dataset.value = String((Number(bigDie.dataset.value) + Math.floor(Math.random() * 5)) % 6 + 1);
}

function showDie(seat) {
  clearTimeout(throwTimer);
  overlay.dataset.seat = seat === null ? 'none' : String(seat);
  overlay.classList.remove('landed');
  overlay.classList.add('show');
  bigDie.style.transition = 'none';
}

function putAway() {
  die.mode = 'away';
  cancelAnimationFrame(frame);
  frame = null;
  clearTimeout(throwTimer);
  overlay.classList.remove('show', 'held', 'ready', 'grabbing', 'landed');
  document.body.classList.remove('throwing');
}

function landDie() {
  die.mode = 'rest';
  cancelAnimationFrame(frame);
  frame = null;
  bigDie.dataset.value = String(die.value);
  // Settle flat on the nearest side.
  die.angle = Math.round(die.angle / 90) * 90;
  bigDie.style.transition = 'transform .22s ease-out';
  drawDie();
  overlay.classList.add('landed');
  // The result stays under wraps until the die has landed.
  document.body.classList.remove('throwing');
  throwTimer = setTimeout(putAway, THROW_HOLD_MS);
}

/** Advance the die by `dt` seconds. Returns true when it hit an edge of the screen. */
function stepDie(dt, held) {
  if (held) {
    // A firm, slightly springy grip: the die follows the hand that holds it.
    die.vx += ((die.px - die.x) * 520 - die.vx * 40) * dt;
    die.vy += ((die.py - die.y) * 520 - die.vy * 40) * dt;
    die.spin += (die.vx * 0.9 - die.spin * 6) * dt;
  } else {
    // Glide freely at first so the die reaches the edges, then let the table grip it.
    const drag = Math.exp(-(performance.now() - die.started < 1000 ? 0.9 : 4.5) * dt);
    die.vx *= drag;
    die.vy *= drag;
    die.spin *= Math.exp(-1.5 * dt);
  }
  die.x += die.vx * dt;
  die.y += die.vy * dt;
  die.angle += die.spin * dt;
  die.travelled += Math.hypot(die.vx, die.vy) * dt;

  // Bounce off the edges of the screen, losing a little speed and picking up spin.
  const radius = bigDie.offsetWidth / 2;
  const right = Math.max(radius, window.innerWidth - radius);
  const bottom = Math.max(radius, window.innerHeight - radius);
  let bounced = false;
  if (die.x < radius || die.x > right) {
    const side = die.x < radius ? 1 : -1;
    die.x = side === 1 ? radius : right;
    die.vx = side * Math.abs(die.vx) * 0.88;
    die.spin = die.spin * -0.4 + side * die.vy * 0.45;
    bounced = true;
  }
  if (die.y < radius || die.y > bottom) {
    const side = die.y < radius ? 1 : -1;
    die.y = side === 1 ? radius : bottom;
    die.vy = side * Math.abs(die.vy) * 0.88;
    die.spin = die.spin * -0.4 - side * die.vx * 0.45;
    bounced = true;
  }
  return bounced;
}

function tick(now) {
  frame = null;
  if (die.mode !== 'held' && die.mode !== 'flying') return;
  const held = die.mode === 'held';
  // Fixed small steps keep the motion the same at any frame rate, even after a stall.
  let remaining = Math.min(0.25, Math.max(0, now - die.last) / 1000);
  die.last = now;
  let bounced = false;
  while (remaining > 0) {
    const dt = Math.min(0.008, remaining);
    remaining -= dt;
    if (stepDie(dt, held)) bounced = true;
  }
  if (bounced && !calmEffects && Math.hypot(die.vx, die.vy) > 250) {
    overlay.classList.remove('bump');
    void overlay.offsetWidth;
    overlay.classList.add('bump');
  }
  if (bounced || die.travelled > (held ? 45 : 110)) {
    die.travelled = 0;
    rattle();
  }

  if (!held) {
    const elapsed = now - die.started;
    if (die.value !== null && elapsed >= 500 && (Math.hypot(die.vx, die.vy) < 70 || elapsed >= THROW_MS)) {
      landDie();
      return;
    }
    // No roll came back (a rejected request, say): put the die away.
    if (die.value === null && elapsed > 2500) {
      putAway();
      return;
    }
  }
  drawDie();
  frame = requestAnimationFrame(tick);
}

function startLoop() {
  if (frame !== null) return;
  die.last = performance.now();
  frame = requestAnimationFrame(tick);
}

/** Every roll sends the big die flying; it lands on `value`. A die thrown from the hand keeps its flight. */
function throwDie(value, seat) {
  const fromHand = tossed && die.mode === 'flying';
  tossed = false;
  if (document.hidden) {
    putAway();
    return;
  }
  showDie(seat);
  overlay.classList.remove('held', 'ready', 'grabbing');
  die.value = value;
  if (still()) {
    die.x = window.innerWidth / 2;
    die.y = window.innerHeight / 2;
    die.angle = 0;
    landDie();
    return;
  }
  document.body.classList.add('throwing');
  if (!fromHand) {
    // Someone else's roll (or a computer's) comes in from the bottom edge.
    const heading = -Math.PI / 2 + (Math.random() - 0.5) * 1.7;
    const speed = launchSpeed();
    die.x = window.innerWidth * (0.2 + Math.random() * 0.6);
    die.y = window.innerHeight - bigDie.offsetWidth / 2;
    die.vx = Math.cos(heading) * speed;
    die.vy = Math.sin(heading) * speed;
    die.angle = Math.random() * 360;
    die.spin = (Math.random() < 0.5 ? -1 : 1) * (500 + Math.random() * 500);
  }
  die.mode = 'flying';
  die.started = performance.now();
  drawDie();
  startLoop();
}

function requestRoll() {
  if (embedded) session.roll();
  else if (mode === 'local' || localState.turn === 0) localRoll();
}

/** The roll button puts the die in the middle of the screen, ready to be thrown. */
function setOut() {
  showDie(rollSeat);
  overlay.classList.add('held', 'ready');
  // Any face will do until it is thrown.
  bigDie.dataset.value = String(Math.floor(Math.random() * 6) + 1);
  Object.assign(die, {
    mode: 'ready', value: null, vx: 0, vy: 0, spin: 0, angle: 0, travelled: 0, pointer: null,
    x: window.innerWidth / 2, y: window.innerHeight / 2,
  });
  drawDie();
}

/** Pressing on the die picks it up where it was touched. */
function grab(event) {
  die.mode = 'held';
  die.pointer = event.pointerId;
  die.grabX = event.clientX - die.x;
  die.grabY = event.clientY - die.y;
  die.px = die.x;
  die.py = die.y;
  overlay.classList.remove('ready');
  overlay.classList.add('grabbing');
  try { overlay.setPointerCapture(event.pointerId); } catch { /* The drag still works without capture. */ }
  startLoop();
}

/**
 * Letting go throws the die at the speed and in the direction it was moving.
 * A die that was barely moved, or never picked up, gets a gentle toss instead.
 */
function release() {
  if (!inHand()) return;
  overlay.classList.remove('held', 'ready', 'grabbing');
  const current = Math.hypot(die.vx, die.vy);
  const gentle = current < 260;
  const heading = current > 40 ? Math.atan2(die.vy, die.vx) : Math.random() * Math.PI * 2;
  const speed = gentle ? launchSpeed() * 0.6 : Math.min(Math.max(current * 1.25, launchSpeed() * 0.6), launchSpeed() * 2);
  die.vx = Math.cos(heading) * speed;
  die.vy = Math.sin(heading) * speed;
  die.pointer = null;
  die.spin += (Math.random() < 0.5 ? -1 : 1) * (500 + Math.random() * 500);
  die.mode = 'flying';
  die.value = null;
  die.started = performance.now();
  tossed = true;
  startLoop();
  // The throw is for show: the roll itself stays a fair, independent throw.
  requestRoll();
}

function placeTokens() {
  const state = tokenState;
  for (const seat of SEATS) {
    const token = tokens[seat];
    const square = shown[seat];
    const point = centre(Math.max(1, square));
    // Tokens sharing a square fan out so each stays visible.
    const sharing = SEATS.filter((other) => state.players[other] !== null && square > 0 && shown[other] === square);
    const spread = sharing.length > 1 ? [[-1.9, -1.9], [1.9, 1.9], [1.9, -1.9], [-1.9, 1.9]][sharing.indexOf(seat)] : [0, 0];
    token.hidden = state.players[seat] === null;
    token.classList.toggle('waiting', square === 0);
    token.classList.toggle('winner', state.winner === seat && square === LAST_SQUARE);
    token.style.left = `${point.x + spread[0]}%`;
    token.style.top = `${point.y + spread[1]}%`;
  }
}

function syncTokens(state, sessionKey) {
  // A theme or seat update must neither replay nor cut short a token's move.
  const key = `${sessionKey}:${state.round}:${state.rolls}:${state.positions.join()}`;
  if (key === tokenKey && stepTimer !== null) return;
  clearTimeout(stepTimer);
  stepTimer = null;
  // Finish any earlier move before judging whether this one can be animated.
  if (tokenState && key !== tokenKey) shown = [...tokenState.positions];
  const roll = state.lastRoll;
  const animate = tokenKey !== null && key !== tokenKey && roll !== null && roll.to !== roll.from &&
    shown[roll.seat] === roll.from && !reducedMotion?.matches && !document.hidden;
  tokenKey = key;
  tokenState = state;
  for (const seat of SEATS) {
    if (!animate || seat !== roll.seat) shown[seat] = state.positions[seat];
  }
  tokens.forEach((token) => token.classList.remove('slide'));
  if (!animate) {
    placeTokens();
    return;
  }
  const path = [];
  for (let square = roll.from + 1; square <= roll.landed; square += 1) path.push(square);
  const rides = roll.to !== roll.landed;
  if (rides) path.push(roll.to);
  const step = () => {
    const riding = rides && path.length === 1;
    tokens[roll.seat].classList.toggle('slide', riding);
    shown[roll.seat] = path.shift();
    placeTokens();
    // Pause on the square before a snake or ladder carries the token away.
    stepTimer = path.length ? setTimeout(step, rides && path.length === 1 ? 420 : 150) : null;
  };
  // The token waits for the big die to land before it sets off.
  stepTimer = setTimeout(step, THROW_MS + 250);
}

function render() {
  const state = embedded ? liveView?.state ?? createGame([]) : localState;
  const ready = !embedded || !!liveView?.connected;
  const enough = state.players.filter((id) => id !== null).length >= 2;
  const mine = mySeat(state);
  const playing = ready && enough && state.winner === null;
  const canRoll = playing && mine === state.turn;
  const selfId = liveView?.self?.id;
  showBoardTheme(state.theme, ready);
  $('theme-scope').textContent = embedded ? 'EVERYONE SEES IT' : '';
  const visible = (seat) => state.players[seat] !== null || (embedded && seat < 2);

  for (const seat of SEATS) {
    const name = nameFor(seat, state);
    const position = state.positions[seat];
    const card = $(`player-${seat}`);
    card.hidden = !visible(seat);
    card.classList.toggle('active', playing && state.turn === seat);
    card.classList.toggle('empty', state.players[seat] === null);
    $(`name-${seat}`).textContent = name;
    let detail = position === 0 ? 'At the start' : `Square ${position}`;
    if (state.winner === seat) detail = 'Winner of this round';
    if (embedded) detail = state.players[seat] === null ? 'Invite someone from your call' : `${state.players[seat] === selfId ? 'You · ' : ''}${detail}`;
    $(`detail-${seat}`).textContent = detail;
    $(`score-${seat}`).textContent = state.scores[seat];
  }

  let status, detail, statusSeat;
  if (!ready) {
    status = liveView ? 'Syncing your game' : 'Waiting for Refract';
    detail = 'Your shared board will appear here.';
    statusSeat = null;
  } else if (!enough) {
    status = 'A seat for a friend';
    detail = 'Ask someone in the call to join this activity.';
    statusSeat = null;
  } else if (state.winner !== null) {
    const won = embedded ? state.players[state.winner] === selfId : mode === 'computer' && state.winner === 0;
    status = won ? 'You reached 100!' : `${nameFor(state.winner, state)} wins!`;
    detail = `${describeRoll(state, mine)} First to the top.`;
    statusSeat = state.winner;
  } else {
    status = canRoll && (embedded || mode === 'computer') ? 'Your roll' : `${nameFor(state.turn, state)}’s roll`;
    if (state.lastRoll) detail = describeRoll(state, mine);
    else detail = canRoll ? 'Click roll, then grab the die and fling it.' : mine !== null ? 'Good things come to those who wait.' : 'You’ve got the best seat to watch.';
    statusSeat = state.turn;
  }
  if (status !== lastStatus) { $('status').textContent = status; lastStatus = status; }
  if (detail !== lastDetail) { $('status-detail').textContent = detail; lastDetail = detail; }
  $('status-token').dataset.seat = statusSeat === null ? 'none' : String(statusSeat);
  $('round').textContent = `ROUND ${String(state.round).padStart(2, '0')}`;

  const die = $('die');
  const value = state.lastRoll?.die ?? 0;
  // Only a new roll throws the die; theme and seat updates leave it alone.
  const rollKey = `${state.round}:${state.rolls}`;
  if (state.lastRoll && die.dataset.rollKey !== rollKey && die.dataset.rollKey !== undefined) {
    die.classList.remove('rolled');
    void die.offsetWidth;
    die.classList.add('rolled');
    throwDie(value, state.lastRoll.seat);
  }
  die.dataset.rollKey = rollKey;
  die.dataset.value = String(value);
  die.dataset.seat = state.lastRoll ? String(state.lastRoll.seat) : 'none';
  die.setAttribute('aria-label', value ? `Last roll: ${value}` : 'No roll yet');
  $('roll').disabled = !canRoll;
  rollSeat = canRoll ? state.turn : null;
  if (inHand() && !canRoll) putAway();

  syncTokens(state, embedded ? 'live' : `${mode}-${playerCount}`);
  const places = SEATS.filter((seat) => state.players[seat] !== null)
    .map((seat) => `${nameFor(seat, state)} ${state.positions[seat] === 0 ? 'at the start' : `on square ${state.positions[seat]}`}`);
  $('board').setAttribute('aria-label', `Snakes and ladders board. ${places.join(', ')}.`);
  $('board').classList.toggle('finished', state.winner !== null);

  const lead = Math.max(...state.positions);
  const leaders = SEATS.filter((seat) => state.players[seat] !== null && state.positions[seat] === lead);
  $('next-round').disabled = !ready || !enough || state.winner === null || (embedded && mine === null);
  if (state.winner !== null) $('round-note').textContent = mine === null ? 'The players can start the next round.' : 'Another round? Keep the good times going.';
  else if (lead === 0) $('round-note').textContent = 'A fresh board. Mind the snakes.';
  else if (leaders.length > 1) $('round-note').textContent = `Level on square ${lead}. ${LAST_SQUARE - lead} to go.`;
  else $('round-note').textContent = `${nameFor(leaders[0], state)} ${nameFor(leaders[0], state) === 'You' ? 'lead' : 'leads'} on square ${lead}. ${LAST_SQUARE - lead} to go.`;

  if (embedded) {
    const people = liveView?.participants ?? [];
    const spectators = people.filter((person) => !state.players.includes(person.id));
    $('player-count').textContent = `${people.length} IN ACTIVITY`;
    $('spectators').hidden = spectators.length === 0;
    $('spectators').textContent = `Watching · ${spectators.map((person) => person.name).join(', ')}`;
    $('seat-description').textContent = !ready ? 'Connecting to your call…' : mine !== null ? `You’re the ${COLOURS[mine]} token. Roll well.` : 'You’re watching this round.';
    $('connection-label').textContent = ready ? 'Connected to Refract' : liveView ? 'Syncing with Refract' : 'Waiting for Refract';
    $('connection').dataset.state = ready ? 'connected' : 'waiting';
    if (liveView) {
      $('notice').textContent = liveView.notice ?? '';
      $('notice').hidden = !liveView.notice;
    }
  } else {
    $('player-count').textContent = `${playerCount} PLAYERS`;
  }
}

function localRoll() {
  localState = playRoll(localState, localState.players[localState.turn], rollDie());
  render();
  scheduleComputer();
}

function scheduleComputer() {
  clearTimeout(computerTimer);
  if (embedded || mode !== 'computer' || localState.winner !== null || localState.turn === 0) return;
  // Long enough for the previous throw to land and its token to finish moving.
  computerTimer = setTimeout(localRoll, reducedMotion?.matches ? 1400 : 4000);
}

function resetLocal() {
  clearTimeout(computerTimer);
  localState = createGame(localPlayers(), localState.theme);
  $('mode-computer').setAttribute('aria-pressed', String(mode === 'computer'));
  $('mode-local').setAttribute('aria-pressed', String(mode === 'local'));
  for (const button of document.querySelectorAll('[data-count]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.count) === playerCount));
  }
  if (mode === 'local') $('mode-hint').textContent = 'One screen, one die. Pass it around.';
  else $('mode-hint').textContent = playerCount === 2 ? 'You against the dice, and a computer that rolls its own.' : `You against the dice, and ${playerCount - 1} computers that roll their own.`;
  render();
}

const session = createSession({
  theme: savedBoardTheme(),
  send: (data, to) => bridge?.broadcast(data, to),
  onChange(view) { liveView = view; render(); },
});

$('calm-toggle').addEventListener('click', () => {
  calmEffects = !calmEffects;
  try { localStorage.setItem(CALM_KEY, calmEffects ? 'on' : 'off'); } catch { /* The choice simply is not remembered. */ }
  showCalm();
});

const rollButton = $('roll');
rollButton.addEventListener('click', () => {
  if (inHand()) {
    // Keyboard: the same key that set the die out tosses it.
    release();
    return;
  }
  if (rollButton.disabled) return;
  if (still()) {
    requestRoll();
    return;
  }
  setOut();
});

// While the die is out, the overlay takes every press: on the die picks it up,
// anywhere else tosses it.
overlay.addEventListener('pointerdown', (event) => {
  if (die.mode !== 'ready' || event.button !== 0) return;
  event.preventDefault();
  const reach = bigDie.offsetWidth * 0.62;
  if (Math.hypot(event.clientX - die.x, event.clientY - die.y) <= reach) grab(event);
  else release();
});

overlay.addEventListener('pointermove', (event) => {
  if (die.mode !== 'held' || event.pointerId !== die.pointer) return;
  die.px = event.clientX - die.grabX;
  die.py = event.clientY - die.grabY;
});

for (const type of ['pointerup', 'pointercancel']) {
  overlay.addEventListener(type, (event) => {
    if (die.mode === 'held' && event.pointerId === die.pointer) release();
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && inHand()) putAway();
});

$('next-round').addEventListener('click', () => {
  if (embedded) session.rematch();
  else { localState = nextRound(localState); render(); scheduleComputer(); }
});

for (const choice of ['computer', 'local']) {
  $(`mode-${choice}`).addEventListener('click', () => {
    if (mode === choice) return;
    mode = choice;
    resetLocal();
  });
}

for (const button of document.querySelectorAll('[data-count]')) {
  button.addEventListener('click', () => {
    const count = Number(button.dataset.count);
    if (count === playerCount) return;
    playerCount = count;
    resetLocal();
  });
}

$('sync').addEventListener('click', () => {
  bridge?.ready();
  session.sync();
});
$('leave').addEventListener('click', () => bridge?.close());

if (embedded) {
  bridge = connectActivity({
    onInit(message) {
      clearTimeout(handshakeTimer);
      document.documentElement.dataset.theme = message.theme;
      session.init(message);
    },
    onParticipants: (people) => session.setParticipants(people),
    onMessage: (from, data) => session.receive(from, data),
  });
  handshakeTimer = setTimeout(() => {
    if (!liveView) {
      $('notice').textContent = 'No Refract connection yet. Open this activity from a call, or use Resync game to try again.';
      $('notice').hidden = false;
    }
  }, 8000);
  // Refract does not replay messages. Occasional snapshots also recover a
  // dropped roll or a guest whose first request arrived before the host loaded.
  retryTimer = setInterval(() => { if (!liveView) bridge.ready(); else session.sync(); }, 5000);
}

window.addEventListener('pagehide', () => {
  clearTimeout(computerTimer);
  clearTimeout(handshakeTimer);
  clearTimeout(stepTimer);
  clearTimeout(throwTimer);
  cancelAnimationFrame(frame);
  clearInterval(retryTimer);
  session.destroy();
  bridge?.destroy();
});
// A back/forward-cache restore needs fresh listeners and a fresh handshake.
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
buildBoard();
render();
