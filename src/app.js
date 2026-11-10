import {
  BOARD_THEMES, LADDERS, LAST_SQUARE, PIECES, POWER_UPS, SEATS, SNAKES, TURN_SECONDS, boardTheme, choosePiece, configure,
  createGame, nextRound, playRoll, rollDie, skipTurn, startGame, toLobby, usePower,
} from './game.js';
import { THEME_COOLDOWN_MS, TURN_SETTLE_MS, createSession } from './session.js';
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
// The piece this viewer last picked, offered again in each lobby.
const PIECE_KEY = 'refract-snakes-and-ladders:piece';
let savedPiece = 'counter';
try { const stored = localStorage.getItem(PIECE_KEY); if (PIECES[stored]) savedPiece = stored; } catch { /* Defaults to the counter. */ }
function savePiece(piece) {
  savedPiece = piece;
  try { localStorage.setItem(PIECE_KEY, piece); } catch { /* The choice simply is not remembered. */ }
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

// Turn sounds: a per-viewer switch for the countdown beeps.
const SOUND_KEY = 'refract-snakes-and-ladders:turn-sounds';
let turnSounds = true;
try { turnSounds = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { /* Defaults to on. */ }
function showSounds() {
  document.getElementById('sound-toggle')?.setAttribute('aria-checked', String(turnSounds));
}
showSounds();

// Browsers only let a page make sound after the person has interacted with it.
let audio = null;
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') void audio.resume();
  } catch { audio = null; }
}
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, unlockAudio, { capture: true });

function tone(frequency, seconds, { type = 'sine', volume = 0.18, at = 0 } = {}) {
  if (!turnSounds || !audio || audio.state !== 'running') return;
  try {
    const start = audio.currentTime + at;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + seconds + 0.03);
  } catch { /* Sound is a nicety. */ }
}
// A tick for each of the last five seconds, rising in pitch, then a low buzz when time is up.
const warningTick = (secondsLeft) => tone(660 + (5 - secondsLeft) * 90, 0.13, { volume: 0.2 });
const timeUp = () => { tone(330, 0.16, { type: 'triangle', volume: 0.22 }); tone(220, 0.34, { type: 'triangle', volume: 0.22, at: 0.17 }); };

let mode = 'computer';
// Classic or Chaos, for local practice. In Refract the game state carries the mode.
let gameMode = 'classic';
let playerCount = 2;
let localSeconds = TURN_SECONDS.standard;
let localState = localLobby(savedBoardTheme());
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
// Lands the die by the clock if animation frames stall, as in a background or hidden frame.
let flightTimer = null;
let frame = null;
let tossed = false;
let rollSeat = null;
// The big die is a small physics body: 'ready' waiting in the middle of the screen,
// 'held' on a spring under the pointer, 'flying' free across the screen, 'rest' once
// it has landed, and 'away' when it is not shown.
const die = { mode: 'away', x: 0, y: 0, vx: 0, vy: 0, angle: 0, spin: 0, rx: 0, ry: 0, px: 0, py: 0, grabX: 0, grabY: 0, pointer: null, travelled: 0, value: null, started: 0, last: 0 };
const inHand = () => die.mode === 'ready' || die.mode === 'held';
const overlay = $('throw');
const bigDie = $('big-die');
const cube = $('cube');

document.body.classList.toggle('embedded', embedded);
$('practice-options').hidden = embedded;
$('lobby-you').hidden = !embedded;
$('refract-info').hidden = !embedded;
// Reloading a connected activity must not silently switch it into local play.
if (embedded) {
  $('connection').dataset.state = 'waiting';
  $('connection-label').textContent = 'Connecting to Refract';
}

function localPlayers() {
  return SEATS.map((seat) => (seat < playerCount ? seat + 1 : null));
}

/** A practice lobby: you in seat one, then computers (or friends at this screen) with silly pieces. */
function localLobby(theme = localState?.theme ?? 'classic') {
  const others = Object.keys(PIECES).filter((piece) => piece !== 'counter' && piece !== savedPiece).sort(() => Math.random() - 0.5);
  const pieces = SEATS.map((seat) => (seat === 0 ? savedPiece : mode === 'computer' ? others[seat - 1] : 'counter'));
  return createGame(localPlayers(), theme, gameMode, Math.random, { phase: 'lobby', turnSeconds: localSeconds, pieces });
}

const pieceIcon = (state, seat) => PIECES[state.pieces?.[seat]]?.icon ?? null;

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
  // The rails run a little past each square's centre, like a real ladder resting on the board.
  const start = { x: a.x - ux * 0.9, y: a.y - uy * 0.9 };
  const end = { x: b.x + ux * 0.9, y: b.y + uy * 0.9 };
  const group = shape('g', { class: 'ladder' });
  const rungs = [];
  const count = Math.max(3, Math.round(length / 3.3));
  for (let rung = 1; rung < count; rung += 1) {
    const x = a.x + ux * length * rung / count;
    const y = a.y + uy * length * rung / count;
    rungs.push({ x1: fixed(x - px), y1: fixed(y - py), x2: fixed(x + px), y2: fixed(y + py) });
  }
  const rails = [-1, 1].map((side) => ({ x1: fixed(start.x + px * side), y1: fixed(start.y + py * side), x2: fixed(end.x + px * side), y2: fixed(end.y + py * side) }));
  // Each piece is drawn twice: a dark edge, then the face on top of it.
  for (const rung of rungs) group.append(shape('line', { class: 'rung-edge', ...rung }));
  for (const rung of rungs) group.append(shape('line', { class: 'rung', ...rung }));
  for (const rail of rails) group.append(shape('line', { class: 'rail-edge', ...rail }));
  for (const rail of rails) group.append(shape('line', { class: 'rail', ...rail }));
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
    points.push({ x: head.x + ux * length * t - uy * sway, y: head.y + uy * length * t + ux * sway });
  }
  const path = (first, last, shift = 0) => `M${points.slice(first, last + 1).map((point, i, all) => {
    // Offset sideways for the highlight, along the local direction of the body.
    const next = all[Math.min(i + 1, all.length - 1)];
    const previous = all[Math.max(i - 1, 0)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const size = Math.hypot(dx, dy) || 1;
    return `${fixed(point.x - (dy / size) * shift)} ${fixed(point.y + (dx / size) * shift)}`;
  }).join('L')}`;
  const group = shape('g', { class: `snake snake-${index % 2}` });
  // The body tapers to the tail in three widths: an edge first, then the body over it.
  const segments = [[0, 49, 2.9], [48, 55, 2.05], [54, 60, 1.15]];
  for (const [first, last, width] of segments) group.append(shape('path', { class: 'snake-edge', d: path(first, last), 'stroke-width': fixed(width + 0.5) }));
  for (const [first, last, width] of segments) group.append(shape('path', { class: 'snake-body', d: path(first, last), 'stroke-width': width }));
  group.append(shape('path', { class: 'snake-stripe', d: path(2, 52) }));
  group.append(shape('path', { class: 'snake-shine', d: path(3, 50, -0.75) }));

  // A head that points away from the tail, with eyes, nostrils, and a little shine.
  const fx = -ux;
  const fy = -uy;
  const angle = (Math.atan2(fy, fx) * 180) / Math.PI;
  const cx = head.x + fx * 0.3;
  const cy = head.y + fy * 0.3;
  const at = (along, across) => ({ x: fixed(cx + fx * along - fy * across), y: fixed(cy + fy * along + fx * across) });
  group.append(shape('ellipse', { class: 'snake-head', cx: fixed(cx), cy: fixed(cy), rx: 2.9, ry: 2.35, transform: `rotate(${fixed(angle)} ${fixed(cx)} ${fixed(cy)})` }));
  const shine = at(-0.2, -1.05);
  group.append(shape('ellipse', { class: 'head-shine', cx: shine.x, cy: shine.y, rx: 1.1, ry: 0.45, transform: `rotate(${fixed(angle)} ${shine.x} ${shine.y})` }));
  for (const side of [-1, 1]) {
    const nostril = at(2.35, side * 0.55);
    group.append(shape('circle', { class: 'snake-nostril', cx: nostril.x, cy: nostril.y, r: 0.17 }));
    const eye = at(0.5, side * 1.15);
    group.append(shape('circle', { class: 'snake-eye', cx: eye.x, cy: eye.y, r: 0.82 }));
    const pupil = at(0.8, side * 1.15);
    group.append(shape('circle', { class: 'snake-pupil', cx: pupil.x, cy: pupil.y, r: 0.4 }));
  }
  // Theme extras, each shown only by its own theme: a forked tongue and a Santa hat.
  const tip = at(2.85, 0);
  const fork = at(4.1, 0);
  group.append(shape('path', {
    class: 'snake-tongue',
    d: `M${tip.x} ${tip.y}L${fork.x} ${fork.y}` +
      `l${fixed(fx * 0.8 - fy * 0.6)} ${fixed(fy * 0.8 + fx * 0.6)}M${fork.x} ${fork.y}l${fixed(fx * 0.8 + fy * 0.6)} ${fixed(fy * 0.8 - fx * 0.6)}`,
  }));
  const hat = shape('g', { class: 'snake-hat', transform: `translate(${fixed(cx)} ${fixed(cy - 1.1)}) rotate(${index % 2 ? 14 : -14})` });
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
    else setOption({ theme });
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
  if (roll.steps === roll.die * 2) text += ` (doubled to ${roll.steps})`;
  else if (roll.steps < 0) text += `, slipped on a banana, went back ${-roll.steps}`;
  if (roll.via === 'overshoot') text += ` and ${you ? 'need' : 'needs'} exactly ${LAST_SQUARE - roll.from} to finish.`;
  else if (roll.via === 'ladder') text += ` and climbed a ladder from ${roll.landed} to ${roll.to}.`;
  else if (roll.via === 'snake') text += ` and slid down a snake from ${roll.landed} to ${roll.to}.`;
  else if (roll.to === LAST_SQUARE) text += ' and reached 100.';
  else text += ` and moved to ${roll.to}.`;
  if (roll.die === 6 && state.winner === null) text += ' A six: roll again.';
  if (state.lastBonus) text += ` A 3 wins a power-up: ${POWER_UPS[state.lastBonus].icon} ${POWER_UPS[state.lastBonus].name}.`;
  return text + frozenNote(state);
}

/** Players frozen out of their turn as it passed on. */
function frozenNote(state) {
  if (!state.lastFrozen?.length) return '';
  const names = state.lastFrozen.map((seat) => nameFor(seat, state));
  return ` ${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} frozen and ${names.length > 1 ? 'miss' : 'misses'} a turn.`;
}

/** What the last power-up did, in a sentence. */
function describePower(state, mine) {
  const used = state.lastPower;
  if (!used) return '';
  const local = embedded || mode === 'computer';
  const who = (seat, start = false) => (seat === mine && local ? (start ? 'You' : 'you') : nameFor(seat, state));
  const actor = who(used.seat, true);
  const target = used.target !== null ? who(used.target) : '';
  const blocked = used.blocked.map((seat) => who(seat));
  const landing = (seat) => used.moves.find((entry) => entry[0] === seat)?.[2];
  const shieldNote = blocked.length ? ` ${blocked.join(' and ')} blocked it with a shield.` : '';
  switch (used.power) {
    case 'rocket': return `${actor} fired a rocket and blasted up to ${landing(used.seat) ?? state.positions[used.seat]}.`;
    case 'double': return `${actor} loaded the dice: the next roll counts double.`;
    case 'shield': return `${actor} raised a shield.`;
    case 'bite': return blocked.length ? `${actor} tried to bite ${target}, but the shield held.` : `${actor} bit ${target}, sending them back to ${landing(used.target) ?? state.positions[used.target]}.`;
    case 'swap': return blocked.length ? `${actor} tried to swap with ${target}, but the shield held.` : `${actor} swapped places with ${target}.`;
    case 'freeze': return blocked.length ? `${actor} tried to freeze ${target}, but the shield held.` : `${actor} froze ${target}: they miss their next turn.`;
    case 'banana': return blocked.length ? `${actor} threw a banana at ${target}, but the shield held.` : `${actor} slipped a banana under ${target}: their next roll goes backwards.`;
    case 'lightning': return `${actor} struck every rival with lightning!${shieldNote}`;
    case 'shuffle': return `${actor} shuffled the board!${shieldNote}`;
    default: return '';
  }
}

const still = () => !!reducedMotion?.matches || document.hidden;
// Rolling by button instead of by throwing the die.
const manualRoll = () => !!reducedMotion?.matches;
const launchSpeed = () => Math.max(window.innerWidth, window.innerHeight) * 2.6;

function drawDie() {
  const half = bigDie.offsetWidth / 2;
  bigDie.style.transform = `translate(${(die.x - half).toFixed(1)}px, ${(die.y - half).toFixed(1)}px)`;
  // Spin flat on the table (z), and tumble over and over (x and y) as it travels.
  cube.style.transform = `rotateZ(${die.angle.toFixed(1)}deg) rotateX(${die.rx.toFixed(1)}deg) rotateY(${die.ry.toFixed(1)}deg)`;
}

// The cube's x and y turn that brings each face to the top. Opposite faces add up to 7.
const FACE_TURNS = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] };
const nearestTurn = (target, current) => target + 360 * Math.round((current - target) / 360);

/** Turn the cube, from wherever it is, to rest flat on `value`. */
function faceUp(value) {
  const [rx, ry] = FACE_TURNS[value] ?? FACE_TURNS[1];
  die.rx = nearestTurn(rx, die.rx);
  die.ry = nearestTurn(ry, die.ry);
  die.angle = Math.round(die.angle / 90) * 90;
}

function showDie(seat) {
  clearTimeout(throwTimer);
  clearTimeout(flightTimer);
  overlay.dataset.seat = seat === null ? 'none' : String(seat);
  overlay.classList.remove('landed');
  overlay.classList.add('show');
  bigDie.style.transition = 'none';
  cube.style.transition = 'none';
}

function putAway() {
  clearTimeout(flightTimer);
  die.mode = 'away';
  cancelAnimationFrame(frame);
  frame = null;
  clearTimeout(throwTimer);
  overlay.classList.remove('show', 'held', 'ready', 'grabbing', 'landed');
  document.body.classList.remove('throwing');
}

function landDie() {
  clearTimeout(flightTimer);
  die.mode = 'rest';
  cancelAnimationFrame(frame);
  frame = null;
  // The cube rolls over onto the face it was always going to show: no swapping numbers.
  faceUp(die.value);
  cube.style.transition = 'transform .6s cubic-bezier(.2, .9, .25, 1.12)';
  drawDie();
  overlay.classList.add('landed');
  // The result stays under wraps until the die has landed.
  document.body.classList.remove('throwing');
  throwTimer = setTimeout(() => {
    putAway();
    // A six, or the next player at this screen, gets the die straight back.
    render();
  }, THROW_HOLD_MS);
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
  // Rolling: the faster it moves, the faster it tumbles end over end.
  die.rx -= die.vy * 0.42 * dt;
  die.ry += die.vx * 0.42 * dt;
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

  if (!held) {
    const elapsed = now - die.started;
    if (die.value !== null && elapsed >= 500 && (Math.hypot(die.vx, die.vy) < 70 || elapsed >= THROW_MS)) {
      landDie();
      return;
    }
    // No roll came back (a rejected request, say): put the die away and offer it again.
    if (die.value === null && elapsed > 2500) {
      putAway();
      render();
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
  cube.style.transition = 'none';
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
    die.rx = Math.random() * 360;
    die.ry = Math.random() * 360;
    die.spin = (Math.random() < 0.5 ? -1 : 1) * (500 + Math.random() * 500);
  }
  die.mode = 'flying';
  die.started = performance.now();
  drawDie();
  startLoop();
  flightTimer = setTimeout(() => { if (die.mode === 'flying') landDie(); }, THROW_MS + 400);
}

function requestRoll() {
  if (embedded) session.roll();
  else if (mode === 'local' || localState.turn === 0) localRoll();
}

/** The roll button puts the die in the middle of the screen, ready to be thrown. */
function setOut() {
  showDie(rollSeat);
  overlay.classList.add('held', 'ready');
  Object.assign(die, {
    mode: 'ready', value: null, vx: 0, vy: 0, spin: 0, angle: 0, travelled: 0, pointer: null,
    x: window.innerWidth / 2, y: window.innerHeight / 2,
  });
  // Any face will do until it is thrown, tilted a little so it reads as a cube.
  faceUp(Math.floor(Math.random() * 6) + 1);
  die.rx -= 18;
  die.ry += 24;
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
  try { bigDie.setPointerCapture(event.pointerId); } catch { /* The drag still works without capture. */ }
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
  clearTimeout(flightTimer);
  flightTimer = setTimeout(() => {
    if (die.mode !== 'flying' || die.value !== null) return;
    putAway();
    render();
  }, 2900);
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
    const icon = pieceIcon(state, seat);
    token.textContent = icon ?? String(seat + 1);
    token.classList.toggle('piece', !!icon);
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
  const animate = tokenKey !== null && key !== tokenKey && state.lastEvent === 'roll' && roll !== null && roll.to !== roll.from &&
    shown[roll.seat] === roll.from && !reducedMotion?.matches && !document.hidden;
  tokenKey = key;
  tokenState = state;
  for (const seat of SEATS) {
    if (!animate || seat !== roll.seat) shown[seat] = state.positions[seat];
  }
  tokens.forEach((token) => token.classList.remove('slide'));
  if (!animate) {
    if (state.lastEvent === 'power') for (const [seat] of state.lastPower?.moves ?? []) tokens[seat].classList.add('slide');
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
  const inLobby = state.phase === 'lobby';
  const playing = ready && !inLobby && enough && state.winner === null;
  const clock = turnClock(state, playing);
  const canRoll = playing && mine === state.turn && !clock.expired;
  const selfId = liveView?.self?.id;
  showBoardTheme(state.theme, ready && (!embedded || mine !== null));
  renderLobby(state, ready, mine);
  const visible = (seat) => state.players[seat] !== null;

  for (const seat of SEATS) {
    const name = nameFor(seat, state);
    const position = state.positions[seat];
    const card = $(`player-${seat}`);
    card.hidden = !visible(seat);
    card.classList.toggle('active', playing && state.turn === seat);
    card.classList.toggle('empty', state.players[seat] === null);
    card.querySelector('.player-token').textContent = pieceIcon(state, seat) ?? String(seat + 1);
    card.querySelector('.player-token').classList.toggle('piece', !!pieceIcon(state, seat));
    $(`name-${seat}`).textContent = name;
    let detail = position === 0 ? 'At the start' : `Square ${position}`;
    if (state.winner === seat) detail = 'Winner of this round';
    if (inLobby) detail = 'Ready in the lobby';
    if (embedded) detail = `${state.players[seat] === selfId ? 'You · ' : ''}${detail}`;
    $(`detail-${seat}`).textContent = detail;
    $(`badges-${seat}`).textContent = badgesFor(state, seat);
    $(`score-${seat}`).textContent = state.scores[seat];
  }

  let status, detail, statusSeat;
  if (!ready) {
    status = liveView ? 'Syncing your game' : 'Waiting for Refract';
    detail = 'Your shared board will appear here.';
    statusSeat = null;
  } else if (inLobby) {
    status = 'Game lobby';
    detail = !embedded ? 'Pick your options, then start.' : mine !== null ? 'You’re in. Start when everyone’s ready.' : 'Join the game, or stay and spectate.';
    statusSeat = null;
  } else if (!enough) {
    status = 'Waiting for players';
    detail = 'Back to the lobby for more players.';
    statusSeat = null;
  } else if (state.winner !== null) {
    const won = embedded ? state.players[state.winner] === selfId : mode === 'computer' && state.winner === 0;
    status = won ? 'You reached 100!' : `${nameFor(state.winner, state)} wins!`;
    detail = `${describeRoll(state, mine)} First to the top.`;
    statusSeat = state.winner;
  } else {
    status = canRoll && (embedded || mode === 'computer') ? 'Your roll' : `${nameFor(state.turn, state)}’s roll`;
    if (state.lastEvent === 'power') detail = describePower(state, mine);
    else if (state.lastEvent === 'skip' && state.lastSkip !== null) {
      const you = state.lastSkip === mine && (embedded || mode === 'computer');
      detail = `${you ? 'You' : nameFor(state.lastSkip, state)} ran out of time.${frozenNote(state)}`;
    } else if (state.lastRoll) detail = describeRoll(state, mine);
    else detail = canRoll ? (manualRoll() ? 'Roll when you’re ready.' : 'Grab the die and fling it.') : mine !== null ? 'Good things come to those who wait.' : 'You’ve got the best seat to watch.';
    statusSeat = state.turn;
  }
  if (status !== lastStatus) { $('status').textContent = status; lastStatus = status; }
  if (detail !== lastDetail) { $('status-detail').textContent = detail; lastDetail = detail; }
  $('status-token').dataset.seat = statusSeat === null ? 'none' : String(statusSeat);
  $('round').textContent = `ROUND ${String(state.round).padStart(2, '0')}`;

  const miniDie = $('die');
  const value = state.lastRoll?.die ?? 0;
  // Only a new roll throws the die; theme and seat updates leave it alone.
  const rollKey = `${state.round}:${state.rolls}`;
  if (state.lastRoll && miniDie.dataset.rollKey !== rollKey && miniDie.dataset.rollKey !== undefined) {
    miniDie.classList.remove('rolled');
    void miniDie.offsetWidth;
    miniDie.classList.add('rolled');
    throwDie(value, state.lastRoll.seat);
  }
  miniDie.dataset.rollKey = rollKey;
  miniDie.dataset.value = String(value);
  miniDie.dataset.seat = state.lastRoll ? String(state.lastRoll.seat) : 'none';
  miniDie.setAttribute('aria-label', value ? `Last roll: ${value}` : 'No roll yet');
  renderPowers(state, { mine, canPlay: canRoll && state.mode === 'chaos' && !state.powerUsed });
  announcePower(state, mine);
  $('roll').disabled = !canRoll;
  rollSeat = canRoll ? state.turn : null;
  // On this player's turn the die simply appears, ready to throw. With reduced motion the
  // roll button is shown instead.
  if (inHand() && !canRoll) putAway();
  else if (canRoll && die.mode === 'away' && !manualRoll()) setOut();

  syncTokens(state, embedded ? 'live' : `${mode}-${playerCount}`);
  const places = SEATS.filter((seat) => state.players[seat] !== null)
    .map((seat) => `${nameFor(seat, state)} ${state.positions[seat] === 0 ? 'at the start' : `on square ${state.positions[seat]}`}`);
  $('board').setAttribute('aria-label', `Snakes and ladders board. ${places.join(', ')}.`);
  $('board').classList.toggle('finished', state.winner !== null);

  const lead = Math.max(...state.positions);
  const leaders = SEATS.filter((seat) => state.players[seat] !== null && state.positions[seat] === lead);
  $('next-round').disabled = !ready || inLobby || !enough || state.winner === null || (embedded && mine === null);
  $('to-lobby').disabled = !ready || inLobby || state.winner === null || (embedded && mine === null);
  $('next-round').closest('.game-actions').hidden = inLobby;
  // Round buttons only matter once someone has won.
  $('next-round').closest('.round-buttons').hidden = state.winner === null;
  if (state.winner !== null) $('round-note').textContent = mine === null ? 'The players can start the next round.' : 'Another round, or back to the lobby?';
  else if (lead === 0) $('round-note').textContent = 'A fresh board. Mind the snakes.';
  else if (leaders.length > 1) $('round-note').textContent = `Level on square ${lead}. ${LAST_SQUARE - lead} to go.`;
  else $('round-note').textContent = `${nameFor(leaders[0], state)} ${nameFor(leaders[0], state) === 'You' ? 'lead' : 'leads'} on square ${lead}. ${LAST_SQUARE - lead} to go.`;

  if (embedded) {
    const people = liveView?.participants ?? [];
    const spectators = people.filter((person) => !state.players.includes(person.id));
    $('player-count').textContent = `${people.length} IN ACTIVITY`;
    $('spectators').hidden = spectators.length === 0;
    $('spectators').textContent = `Watching · ${spectators.map((person) => person.name).join(', ')}`;
    $('seat-description').textContent = !ready ? 'Connecting to your call…' : mine !== null ? `You’re the ${COLOURS[mine]} player.` : inLobby ? 'You’re spectating. Join from the lobby.' : 'You’re spectating this game.';
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

// ---------- Turn countdown ----------
// Every browser times the turn from when it saw it start. The host's clock is the one
// that counts; this one shows the countdown, beeps, and stops a throw at zero.
let clockKey = null;
let clockStart = 0;
let clockSettle = 0;
let clockRolls = null;
let beeped = null;

const turnMs = (state) => (state.turnSeconds ?? TURN_SECONDS.standard) * 1000;

function timedTurn(state, playing) {
  if (!playing || state.phase !== 'playing' || state.players[state.turn] === null) return false;
  // Computer opponents take their own time.
  return embedded || mode === 'local' || state.turn === 0;
}

function turnClock(state, playing) {
  const timed = timedTurn(state, playing);
  const key = timed ? `${embedded ? 'live' : `${mode}-${playerCount}`}:${JSON.stringify([state.round, state.rolls, state.skips, state.turn, state.players])}` : null;
  if (key !== clockKey) {
    clockSettle = clockRolls !== null && state.rolls !== clockRolls ? TURN_SETTLE_MS : 0;
    clockKey = key;
    clockStart = performance.now();
    beeped = null;
  }
  clockRolls = state.rolls;
  if (!timed) return { timed: false, remaining: turnMs(state), expired: false };
  const remaining = Math.max(0, turnMs(state) - Math.max(0, performance.now() - clockStart - clockSettle));
  return { timed: true, remaining, expired: remaining <= 0 };
}

function updateClock() {
  const state = embedded ? liveView?.state ?? createGame([]) : localState;
  const ready = !embedded || !!liveView?.connected;
  const enough = state.players.filter((id) => id !== null).length >= 2;
  const playing = ready && state.phase === 'playing' && enough && state.winner === null;
  const clock = turnClock(state, playing);
  const mine = mySeat(state);
  const myTurn = clock.timed && mine === state.turn;
  const seconds = Math.ceil(clock.remaining / 1000);
  const element = $('countdown');
  element.hidden = !clock.timed;
  element.dataset.seat = String(state.turn);
  element.classList.toggle('urgent', clock.timed && seconds <= 5);
  $('countdown-seconds').textContent = String(seconds);
  $('countdown-bar').style.width = `${(clock.remaining / turnMs(state)) * 100}%`;
  $('throw-hint').textContent = myTurn && seconds <= 5 ? `${seconds}… throw it!` : 'Your roll. Grab the die and fling it.';
  // Only the person whose turn is ending hears it.
  if (myTurn && beeped !== seconds && seconds <= 5) {
    if (seconds > 0) warningTick(seconds);
    else timeUp();
  }
  if (clock.timed) beeped = seconds;
  if (clock.expired) {
    if (inHand()) putAway();
    // Locally this browser is the referee; in Refract the host passes the turn.
    if (!embedded && state.winner === null) {
      localState = skipTurn(localState);
      render();
      scheduleComputer();
      return;
    }
    $('roll').disabled = true;
  }
}
const clockTimer = setInterval(updateClock, 200);

function localRoll() {
  localState = playRoll(localState, localState.players[localState.turn], rollDie(), Math.random);
  render();
  scheduleComputer();
}

function scheduleComputer() {
  clearTimeout(computerTimer);
  if (embedded || mode !== 'computer' || localState.phase !== 'playing' || localState.winner !== null || localState.turn === 0) return;
  // Long enough for the previous throw to land and its token to finish moving.
  computerTimer = setTimeout(computerTurn, reducedMotion?.matches ? 1400 : 4000);
}

/** A computer may play a power-up first, usually on whoever is winning, then rolls. */
function computerTurn() {
  const state = localState;
  const seat = state.turn;
  const hand = state.hands[seat];
  if (state.mode === 'chaos' && !state.powerUsed && hand.length && Math.random() < 0.6) {
    const rivals = SEATS.filter((other) => other !== seat && state.players[other] !== null);
    const leader = rivals.reduce((best, other) => (state.positions[other] > state.positions[best] ? other : best), rivals[0]);
    const behind = state.positions[leader] > state.positions[seat];
    // Prefer an attack when someone is ahead, and a boost when leading.
    const pick = hand.findIndex((power) => (behind ? POWER_UPS[power].aim !== 'self' : POWER_UPS[power].aim === 'self'));
    const slot = pick >= 0 ? pick : 0;
    const next = usePower(state, state.players[seat], slot, POWER_UPS[hand[slot]].aim === 'other' ? leader : null);
    if (next !== state) {
      localState = next;
      render();
      computerTimer = setTimeout(localRoll, reducedMotion?.matches ? 900 : 2200);
      return;
    }
  }
  localRoll();
}

// ---------- Chaos mode: power-up tray, target picker, mode switch, banner ----------
let aiming = null;

function badgesFor(state, seat) {
  if (state.mode !== 'chaos' || state.players[seat] === null) return '';
  const effect = state.effects[seat];
  const marks = [];
  if (effect.shield) marks.push('🛡️');
  if (effect.frozen) marks.push(`🧊${effect.frozen > 1 ? '×2' : ''}`);
  if (effect.banana) marks.push('🍌');
  if (effect.double) marks.push('🎲×2');
  marks.push(`🎁${state.hands[seat].length}`);
  return marks.join(' ');
}

function playPower(slot, target = null) {
  aiming = null;
  if (embedded) session.usePower(slot, target);
  else {
    const next = usePower(localState, localState.players[localState.turn], slot, target);
    if (next === localState) return;
    localState = next;
  }
  render();
}

function renderPowers(state, { mine, canPlay }) {
  const tray = $('powers');
  const show = state.mode === 'chaos' && mine !== null && state.players[mine] !== null;
  tray.hidden = !show;
  if (!show) { aiming = null; return; }
  const hand = state.hands[mine];
  $('powers-note').textContent = !hand.length ? 'All used' : state.powerUsed && mine === state.turn ? 'Used this turn' : canPlay ? 'Play one, then throw' : 'On your turn';
  const key = JSON.stringify([hand, canPlay]);
  const slots = $('power-slots');
  if (slots.dataset.key !== key) {
    slots.dataset.key = key;
    slots.replaceChildren(...hand.map((power, slot) => {
      const info = POWER_UPS[power];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'power';
      button.disabled = !canPlay;
      button.title = info.blurb;
      button.setAttribute('aria-label', `${info.name}: ${info.blurb}`);
      const icon = document.createElement('span');
      icon.className = 'power-icon';
      icon.textContent = info.icon;
      const name = document.createElement('span');
      name.className = 'power-name';
      name.textContent = info.name;
      button.append(icon, name);
      button.addEventListener('click', () => {
        if (info.aim === 'other') {
          aiming = slot;
          render();
        } else playPower(slot);
      });
      return button;
    }));
  }
  if (!canPlay || aiming === null || !hand[aiming]) aiming = null;
  const targets = $('power-targets');
  targets.hidden = aiming === null;
  if (aiming !== null) {
    const info = POWER_UPS[hand[aiming]];
    $('target-prompt').textContent = `${info.icon} ${info.name} on…`;
    const rivals = SEATS.filter((seat) => seat !== mine && state.players[seat] !== null);
    $('target-buttons').replaceChildren(...rivals.map((seat) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'target';
      button.dataset.seat = String(seat);
      button.textContent = `${nameFor(seat, state)} · ${state.positions[seat] || 'start'}`;
      const slot = aiming;
      button.addEventListener('click', () => playPower(slot, seat));
      return button;
    }));
  }
}

// ---------- Lobby ----------
const pieceButtons = Object.entries(PIECES).map(([id, piece]) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'piece-option';
  button.dataset.piece = id;
  button.title = piece.name;
  button.setAttribute('aria-label', piece.name);
  button.textContent = piece.icon ?? '#';
  button.addEventListener('click', () => pickPiece(id));
  return button;
});
$('piece-options').replaceChildren(...pieceButtons);
let pieceOffered = false;

function pickPiece(piece) {
  savePiece(piece);
  if (embedded) session.choosePiece(piece);
  else {
    localState = choosePiece(localState, localState.players[0], piece);
    render();
  }
}

function setOption(options) {
  if (embedded) session.setOptions(options);
  else {
    if (options.mode) gameMode = options.mode;
    if (options.turnSeconds) localSeconds = options.turnSeconds;
    localState = configure(localState, localState.players[0], options);
    render();
  }
}

function renderLobby(state, ready, mine) {
  const lobby = $('lobby');
  lobby.hidden = state.phase !== 'lobby' || !ready;
  if (lobby.hidden) { pieceOffered = false; return; }
  const seatedCount = state.players.filter((id) => id !== null).length;
  // Locally you are always seated; in Refract you join or spectate.
  const seatedHere = !embedded || mine !== null;
  const full = seatedCount >= 4;
  $('lobby-count').textContent = `${seatedCount} / 4 PLAYERS`;
  $('lobby-seats').replaceChildren(...SEATS.map((seat) => {
    const row = document.createElement('div');
    row.className = 'lobby-seat';
    row.dataset.seat = String(seat);
    row.classList.toggle('open', state.players[seat] === null);
    const token = document.createElement('span');
    token.className = 'lobby-token';
    token.textContent = state.players[seat] === null ? '' : pieceIcon(state, seat) ?? String(seat + 1);
    const name = document.createElement('span');
    name.className = 'lobby-name';
    name.textContent = state.players[seat] === null ? 'Open seat' : `${nameFor(seat, state)}${embedded && seat === mine ? ' (you)' : ''}`;
    row.append(token, name);
    return row;
  }));
  if (embedded) {
    $('lobby-you-note').textContent = mine !== null ? 'You’re in the game.' : full ? 'The game is full, so you’re spectating.' : 'You’re spectating. Join to play.';
    $('join-game').hidden = mine !== null;
    $('join-game').disabled = full;
    $('spectate').hidden = mine === null;
    // Offer the piece this viewer picked last time.
    if (mine !== null && !pieceOffered && state.pieces[mine] === 'counter' && savedPiece !== 'counter') {
      pieceOffered = true;
      session.choosePiece(savedPiece);
    }
    if (mine === null) pieceOffered = false;
  }
  $('piece-picker').hidden = !seatedHere;
  const myPiece = embedded ? state.pieces[mine] : state.pieces[0];
  for (const button of pieceButtons) button.setAttribute('aria-pressed', String(button.dataset.piece === myPiece));
  for (const button of document.querySelectorAll('[data-game-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.gameMode === state.mode));
    button.disabled = !seatedHere;
  }
  $('game-mode-hint').textContent = state.mode === 'chaos'
    ? 'Everyone starts with two power-ups: one to use on a rival and one for themselves. Roll a 3 to win another.'
    : 'Plain snakes and ladders.';
  const slider = $('turn-seconds');
  if (document.activeElement !== slider) slider.value = String(state.turnSeconds);
  slider.disabled = !seatedHere;
  $('turn-seconds-value').textContent = `${slider.value} seconds`;
  $('practice-options').hidden = embedded;
  const canStart = seatedHere && seatedCount >= 2;
  $('start-game').disabled = !canStart;
  $('lobby-note').textContent = seatedCount < 2 ? 'Two players needed to start.' : seatedHere ? 'Anyone in the game can start it.' : 'Waiting for a player to start.';
}

$('join-game').addEventListener('click', () => session.join());
$('spectate').addEventListener('click', () => session.spectate());
$('start-game').addEventListener('click', () => {
  if (embedded) session.start();
  else {
    localState = startGame(localState, localState.players[0], Math.random);
    render();
    scheduleComputer();
  }
});
$('to-lobby').addEventListener('click', () => {
  if (embedded) session.backToLobby();
  else {
    clearTimeout(computerTimer);
    localState = toLobby(localState);
    render();
  }
});
$('turn-seconds').addEventListener('input', (event) => { $('turn-seconds-value').textContent = `${event.target.value} seconds`; });
$('turn-seconds').addEventListener('change', (event) => setOption({ turnSeconds: Number(event.target.value) }));

let bannerKey;
let bannerTimer = null;
let bonusTimer = null;
function showBanner(seat, icon, text) {
  const banner = $('banner');
  banner.dataset.seat = String(seat);
  $('banner-icon').textContent = icon;
  $('banner-text').textContent = text;
  banner.hidden = false;
  banner.classList.remove('pop');
  void banner.offsetWidth;
  banner.classList.add('pop');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.hidden = true; }, 2600);
}
function announcePower(state, mine) {
  const key = `${state.round}:${state.powers}:${state.rolls}`;
  const fresh = bannerKey !== undefined && key !== bannerKey;
  bannerKey = key;
  if (!fresh) return;
  if (state.lastEvent === 'roll' && state.lastBonus) {
    const seat = state.lastRoll.seat;
    const who = seat === mine && (embedded || mode === 'computer') ? 'You' : nameFor(seat, state);
    const won = POWER_UPS[state.lastBonus];
    clearTimeout(bonusTimer);
    bonusTimer = setTimeout(() => showBanner(seat, '🎁', `${who} rolled a 3 and won ${won.icon} ${won.name}!`), THROW_MS + 400);
    return;
  }
  if (state.lastEvent !== 'power' || !state.lastPower) return;
  const banner = $('banner');
  banner.dataset.seat = String(state.lastPower.seat);
  $('banner-icon').textContent = POWER_UPS[state.lastPower.power].icon;
  $('banner-text').textContent = describePower(state, mine);
  banner.hidden = false;
  banner.classList.remove('pop');
  void banner.offsetWidth;
  banner.classList.add('pop');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.hidden = true; }, 2600);
}

$('target-cancel').addEventListener('click', () => { aiming = null; render(); });

for (const button of document.querySelectorAll('[data-game-mode]')) {
  button.addEventListener('click', () => setOption({ mode: button.dataset.gameMode }));
}

function resetLocal() {
  clearTimeout(computerTimer);
  localState = localLobby();
  $('mode-computer').setAttribute('aria-pressed', String(mode === 'computer'));
  $('mode-local').setAttribute('aria-pressed', String(mode === 'local'));
  for (const button of document.querySelectorAll('[data-count]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.count) === playerCount));
  }
  if (mode === 'local') $('mode-hint').textContent = 'One screen, one die. Pass it around.';
  else $('mode-hint').textContent = playerCount === 2 ? 'You against a computer that rolls its own.' : `You against ${playerCount - 1} computers that roll their own.`;
  render();
}

const session = createSession({
  theme: savedBoardTheme(),
  send: (data, to) => bridge?.broadcast(data, to),
  onChange(view) { liveView = view; render(); },
});

$('sound-toggle').addEventListener('click', () => {
  turnSounds = !turnSounds;
  try { localStorage.setItem(SOUND_KEY, turnSounds ? 'on' : 'off'); } catch { /* The choice simply is not remembered. */ }
  showSounds();
  if (turnSounds) { unlockAudio(); tone(880, 0.12); }
});

$('calm-toggle').addEventListener('click', () => {
  calmEffects = !calmEffects;
  try { localStorage.setItem(CALM_KEY, calmEffects ? 'on' : 'off'); } catch { /* The choice simply is not remembered. */ }
  showCalm();
});

// The roll button only exists for reduced motion, where the die does not fly.
const rollButton = $('roll');
function syncManualRoll() {
  document.documentElement.classList.toggle('manual-roll', manualRoll());
}
syncManualRoll();
reducedMotion?.addEventListener?.('change', () => {
  syncManualRoll();
  if (manualRoll() && inHand()) putAway();
  render();
});
rollButton.addEventListener('click', () => {
  if (inHand()) release();
  else if (!rollButton.disabled) requestRoll();
});

// Only the die itself takes the pointer, so the rest of the page stays usable while it waits.
bigDie.addEventListener('pointerdown', (event) => {
  if (die.mode !== 'ready' || event.button !== 0) return;
  event.preventDefault();
  grab(event);
});

bigDie.addEventListener('pointermove', (event) => {
  if (die.mode !== 'held' || event.pointerId !== die.pointer) return;
  die.px = event.clientX - die.grabX;
  die.py = event.clientY - die.grabY;
});

for (const type of ['pointerup', 'pointercancel']) {
  bigDie.addEventListener(type, (event) => {
    if (die.mode === 'held' && event.pointerId === die.pointer) release();
  });
}

// Keyboard: Space or Enter tosses the waiting die, unless a control has focus.
window.addEventListener('keydown', (event) => {
  if (die.mode !== 'ready' || (event.key !== ' ' && event.key !== 'Enter') || event.repeat) return;
  if (event.target instanceof Element && event.target.closest('button, input, select, textarea, a')) return;
  event.preventDefault();
  release();
});

$('next-round').addEventListener('click', () => {
  if (embedded) session.rematch();
  else { localState = nextRound(localState, Math.random); render(); scheduleComputer(); }
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

/**
 * Refract loads a refreshed activity at a new address (with a `refract-refresh` value), but
 * the browser may still hold the old scripts and styles: GitHub Pages lets it keep them
 * for ten minutes. Once per refresh, re-check each of this page's own files with the
 * server, and reload if any of them changed.
 */
async function reloadIfStale() {
  try {
    const revision = new URL(location.href).searchParams.get('refract-refresh');
    if (!revision) return;
    const marker = `refract-snakes-and-ladders:refreshed:${revision}`;
    if (sessionStorage.getItem(marker)) return;
    sessionStorage.setItem(marker, '1');
    const files = new Set([location.href.split('#')[0]]);
    for (const entry of performance.getEntriesByType('resource')) {
      const url = new URL(entry.name);
      if (url.origin === location.origin) files.add(url.href.split('#')[0]);
    }
    const tag = (response) => response.headers.get('etag') ?? response.headers.get('last-modified');
    const changed = await Promise.all([...files].map(async (url) => {
      try {
        const before = tag(await fetch(url, { cache: 'force-cache' }));
        const after = tag(await fetch(url, { cache: 'no-cache' }));
        return !!before && !!after && before !== after;
      } catch { return false; }
    }));
    if (changed.includes(true)) location.reload();
  } catch { /* Staying on this copy is the safe fallback. */ }
}

if (embedded) {
  if (document.readyState === 'complete') void reloadIfStale();
  else window.addEventListener('load', () => void reloadIfStale(), { once: true });
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
  clearInterval(clockTimer);
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
