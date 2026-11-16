'use strict';
// Rowan, the tree that lives in Tree of Thought.
//
// Pixel art (see sprite.js): one letter per pixel, '.' is see-through. Rowan
// sways while idle, rustles and blows thought bubbles while a model thinks,
// drops a leaf now and then while it writes, and blossoms when it's done.

const S = require('./sprite');
const Th = require('./theme');

const BASE = [
  '.......LLLL.........',
  '.....LLHHLLLL.......',
  '....LHHLLLLLLL......',
  '...LLHLLLLLLLLl.....',
  '..LLLLLLLLLLLLLl....',
  '..LLLLLLLLLLLLll....',
  '.LLLLLLLLLLLLLLll...',
  '.lLLLLLLLLLLLLLll...',
  '..lLLLLLLLLLLLll....',
  '...llLLTTTTLLll.....',
  '.....lTTTTTTl.......',
  '......TETTET........',
  '......TTmmTT........',
  '......TTTTtT........',
  '.....TTTttTTT.......',
  'GgGGTTTGGGGTTTGgG...',
];

// colours: leaves come from the theme, so autumn Rowan is orange
function ink() {
  const t = Th.t();
  const autumn = Th.name() === 'autumn';
  return {
    L: t.leaf, l: autumn ? '#a85a24' : shade(t.leaf, -0.32), H: autumn ? '#f6c06a' : shade(t.leaf, 0.35),
    T: t.bark, t: shade(t.bark, -0.3), E: '#1b1410', m: shade(t.bark, -0.45),
    G: autumn ? '#7a6a3a' : shade(t.leaf, -0.15), g: autumn ? '#5e5230' : shade(t.leaf, -0.4),
    P: t.blossom, p: shade(t.blossom, 0.35), b: Th.name() === 'meadow' ? '#9fb1c4' : '#dce6f2', f: autumn ? '#c8642a' : shade(t.leaf, 0.1),
  };
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt));
  return '#' + c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

const CANOPY = 9; // rows 0-8 are leaves: they sway; the trunk doesn't
const sway = (g, dx) => S.shift(g, dx, CANOPY);
const blink = (g) => g.map((r) => r.replace(/E/g, 'T'));
const rustle = (g) => g.map((r, y) => (y < CANOPY ? r.replace(/L(?=L)/g, (m, i) => ((i + y) % 3 === 0 ? 'H' : m)) : r));
const bubbles = (g, n) => S.dots(g, [[16, 6, 'b'], [17, 3, n > 0 ? 'b' : '.'], [18, 1, n > 1 ? 'b' : '.'], [19, 0, n > 1 ? 'b' : '.']].slice(0, 1 + n));
const leafAt = (g, y) => S.dots(g, [[16 + (y % 2), y, 'f']]);
const BLOSSOMS = [[5, 2], [10, 1], [3, 5], [12, 4], [8, 6], [14, 6], [6, 8], [11, 7]];
const bloom = (g, n) => S.dots(g, BLOSSOMS.slice(0, n).map(([x, y], i) => [x, y, i % 3 === 2 ? 'p' : 'P']));
const wilt = (g) => g.map((r, y) => (y < CANOPY ? r.replace(/H/g, 'l').replace(/L/g, (m, i) => ((i + y) % 2 ? 'l' : m)) : r)).map((r) => r.replace('TETTET', 'TmTTmT'));

const f = (grid, ms = 260) => ({ grid, ms });

const SCENES = {
  idle: [f(BASE, 900), f(sway(BASE, 1), 700), f(BASE, 900), f(sway(BASE, -1), 700), f(BASE, 600), f(blink(BASE), 160), f(BASE, 900)],
  think: [
    f(bubbles(BASE, 0)), f(bubbles(rustle(BASE), 1)), f(bubbles(sway(BASE, 1), 2)), f(bubbles(BASE, 2)),
    f(bubbles(rustle(sway(BASE, -1)), 1)), f(bubbles(BASE, 0)), f(blink(bubbles(BASE, 1)), 160),
  ],
  write: [0, 2, 4, 6, 8, 10, 12, 14].map((y, i) => f(leafAt(i % 2 ? sway(BASE, 1) : BASE, y), 170)),
  bloom: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => f(bloom(BASE, n), 130)).concat([f(bloom(sway(BASE, 1), 8), 500), f(bloom(BASE, 8), 1600)]),
  wilt: [f(wilt(BASE), 1200), f(wilt(sway(BASE, -1)), 900), f(wilt(BASE), 1200)],
};

const WIDTH = 20; // columns
const HEIGHT = 8; // lines

/** The lines for a scene at a moment in time (looping). */
function frameAt(scene, ms) {
  const frames = SCENES[scene] || SCENES.idle;
  const total = frames.reduce((n, x) => n + x.ms, 0);
  let at = ms % total;
  for (const fr of frames) {
    if (at < fr.ms) return fr.grid;
    at -= fr.ms;
  }
  return frames[0].grid;
}

/** How long a scene takes once through. */
const length = (scene) => (SCENES[scene] || SCENES.idle).reduce((n, x) => n + x.ms, 0);

function draw(scene = 'idle', ms = 0, bg = Th.t().paper.bg) {
  return S.draw(frameAt(scene, ms), ink(), { bg });
}

module.exports = { draw, length, SCENES, WIDTH, HEIGHT, BASE, ink, shade };
