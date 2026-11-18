'use strict';
// Every model gets a plant: a small low-poly emblem, so you can tell your
// garden apart at a glance. (Original drawings - not anyone's logo.)
//
// 6x6 pixels = 6 columns by 3 lines; drawn twice the size on the welcome card.

const S = require('./sprite');

const P = {
  maple: {
    about: 'maple leaf',
    ink: { O: '#ee8a3c', o: '#bf5d22', s: '#7a5232' },
    grid: ['.O..O.', 'OOOOOO', 'OOoOOO', '.OOOO.', '..OO..', '..s...'],
  },
  fern: {
    about: 'fern',
    ink: { G: '#68c07a', g: '#3e8a52' },
    grid: ['...G..', '..GgG.', '.GgGgG', 'GgGgG.', '.GgG..', '..g...'],
  },
  tulip: {
    about: 'tulip',
    ink: { R: '#ee5d72', r: '#b93a52', S: '#5aa354' },
    grid: ['.R.R.R', '.RRRRR', '.RRrRR', '..RRR.', 'S..S..', '.SSS..'],
  },
  lotus: {
    about: 'lotus',
    ink: { P: '#f4a3c8', p: '#d26a9d', W: '#5fa9c4' },
    grid: ['..PP..', '.pPPp.', 'PpPPpP', '.PPPP.', 'WWWWWW', '.WWWW.'],
  },
  cactus: {
    about: 'cactus',
    ink: { C: '#5fae74', c: '#3d7f52', F: '#f6a9c6', D: '#c58a55' },
    grid: ['..F...', 'C.CC..', 'CcCC.C', '.CCcCC', '..CC..', '.DDDD.'],
  },
  mushroom: {
    about: 'mushroom',
    ink: { M: '#e0574f', w: '#f6efe4', s: '#e6d8c2' },
    grid: ['.MMMM.', 'MwMMwM', 'MMMMMM', '..ss..', '..ss..', '.ssss.'],
  },
  lavender: {
    about: 'lavender',
    ink: { V: '#a487dd', v: '#7b5fb5', S: '#6f9a5e' },
    grid: ['V..V..', 'vV.vV.', 'Vv.Vv.', '.S..S.', '.S.S..', '..S...'],
  },
  bamboo: {
    about: 'bamboo',
    ink: { B: '#97c95f', b: '#5f8f3a', L: '#b8e07a' },
    grid: ['.B..LL', '.BL...', 'bb.B..', '.B.B..', '.B.bb.', '.B.B..'],
  },
  pine: {
    about: 'pine',
    ink: { N: '#4f9a6c', n: '#2f6a4a', T: '#8a6040' },
    grid: ['..NN..', '.NnNN.', '..NN..', '.NNnN.', 'NnNNNN', '..TT..'],
  },
  moonflower: {
    about: 'moonflower',
    ink: { W: '#f3efff', w: '#cfc6f0', Y: '#f2d16b', S: '#6f9a5e' },
    grid: ['.W.W..', 'WwYwW.', '.WwW..', '.W.W..', '..S...', '.SS...'],
  },
  sunflower: {
    about: 'sunflower',
    ink: { Y: '#f6c945', y: '#d99a1e', B: '#6b4423', S: '#6f9a5e' },
    grid: ['.YYY..', 'YyByY.', 'YBBBY.', '.YyY..', '..S.S.', '..SS..'],
  },
  acorn: {
    about: 'acorn',
    ink: { A: '#c08850', a: '#8a5a30', c: '#6b4a2e' },
    grid: ['...c..', '.cccc.', 'cccccc', '.AAAA.', '.AaAA.', '..AA..'],
  },
  rose: {
    about: 'rose',
    ink: { R: '#d64560', r: '#9e2a42', S: '#5aa354' },
    grid: ['.RRR..', 'RrRrR.', '.RRR..', '..S.S.', '.SS...', '..S...'],
  },
  clover: {
    about: 'four-leaf clover (Auto: free, and lucky)',
    ink: { C: '#4fc16b', c: '#2f8a46', s: '#6a8a3a' },
    grid: ['.CC.CC', 'CCcCCc', '.cCCc.', 'CCcCCc', '.CC.CC', '...s..'],
  },
  sprout: {
    about: 'sprout',
    ink: { G: '#8fd16a', g: '#5c9c45', s: '#9a7350' },
    grid: ['......', 'GG..GG', '.GgGg.', '..g...', '..g...', '.ssss.'],
  },
};

// Which plant a model gets: by the model's name first, then by who makes it.
const RULES = [
  [/claude|anthropic/i, 'maple'],
  [/gpt|openai|\bo[1-9]\b|o\d-|chatgpt/i, 'fern'],
  [/gemini|gemma|google/i, 'tulip'],
  [/deepseek/i, 'lotus'],
  [/grok|x-ai|xai/i, 'cactus'],
  [/llama|meta/i, 'mushroom'],
  [/mistral|mixtral|codestral|magistral|devstral|ministral/i, 'lavender'],
  [/qwen|qwq|alibaba/i, 'bamboo'],
  [/glm|z-ai|zhipu/i, 'pine'],
  [/kimi|moonshot/i, 'moonflower'],
  [/nvidia|nemotron/i, 'sunflower'],
  [/cohere|command/i, 'rose'],
];

function plantFor(model) {
  if (model.provider === 'auto') return 'clover';
  const text = `${model.id || ''} ${model.name || ''}`;
  for (const [re, name] of RULES) if (re.test(text)) return name;
  if (model.provider === 'ollama') return 'acorn';
  return 'sprout';
}

/** 6 columns x 3 lines. */
function small(name, bg) {
  const p = P[name] || P.sprout;
  return S.draw(p.grid, p.ink, { bg });
}

/** Twice the size: 12 columns x 6 lines. */
function big(name, bg) {
  const p = P[name] || P.sprout;
  const grid = [];
  for (const row of p.grid) {
    const wide = row.split('').map((c) => c + c).join('');
    grid.push(wide, wide);
  }
  return S.draw(grid, p.ink, { bg });
}

/** The plant's main colour, for names and markers. */
const color = (name) => Object.values((P[name] || P.sprout).ink)[0];

/** A one-character icon for lists: a clover for Auto, a seed for models on this computer, a flower for the rest. */
const glyph = (name) => (name === 'clover' ? '♣' : name === 'acorn' ? '◆' : name === 'sprout' ? '❧' : '✿');

module.exports = { PLANTS: P, plantFor, small, big, color, glyph };
