'use strict';
// Colours. Tree of Thought paints its own background (a forest floor, a meadow
// or an autumn wood), so it looks the same in every terminal.

const A = require('./ansi');

const THEMES = {
  grove: {
    about: 'Deep forest: dark moss, fresh leaves, a little blossom',
    paper: { bg: '#0e1611', fg: '#dce7d6' },
    dim: '#7d907c', faint: '#4d6150', border: '#2c4131', select: '#1a2a1f', code: '#152119',
    leaf: '#8fd16a', blossom: '#f2a7c3', bark: '#b88a62', sun: '#f2d16b', water: '#7cc6d6',
    err: '#ff7b72', warn: '#f0b35a', ok: '#8fd16a',
  },
  meadow: {
    about: 'Light: a spring meadow',
    paper: { bg: '#eef3e8', fg: '#1d281e' },
    dim: '#5f725f', faint: '#a9b9a6', border: '#c2d1bd', select: '#dce8d5', code: '#e1eadb',
    leaf: '#2f8a3b', blossom: '#c2457a', bark: '#7a5232', sun: '#9a6f00', water: '#1d7487',
    err: '#c0392b', warn: '#9a5b06', ok: '#2f8a3b',
  },
  autumn: {
    about: 'An autumn wood: amber, rust and bark',
    paper: { bg: '#16100c', fg: '#eee0cf' },
    dim: '#9a8572', faint: '#5e4b3d', border: '#3c2b20', select: '#291d15', code: '#20170f',
    leaf: '#e8913a', blossom: '#e0605a', bark: '#a07b5c', sun: '#f2c14e', water: '#8fb9a8',
    err: '#ff6b5b', warn: '#f2c14e', ok: '#b5cc5a',
  },
};
const NAMES = Object.keys(THEMES);

let current = THEMES.grove;
let currentName = 'grove';

function use(name) {
  currentName = THEMES[name] ? name : 'grove';
  current = THEMES[currentName];
  return current;
}

const t = () => current;
const paint = (key, text, extra = {}) => A.paint(text, { fg: current[key] || key, ...extra });

module.exports = {
  THEMES, NAMES, use, t, paint,
  name: () => currentName,
  dim: (s) => paint('dim', s),
  faint: (s) => paint('faint', s),
  leaf: (s, x) => paint('leaf', s, x),
  blossom: (s, x) => paint('blossom', s, x),
  bark: (s, x) => paint('bark', s, x),
  sun: (s, x) => paint('sun', s, x),
  border: (s) => paint('border', s),
  err: (s) => paint('err', s),
  warn: (s) => paint('warn', s),
  bold: (s) => A.paint(s, { bold: true }),
};
