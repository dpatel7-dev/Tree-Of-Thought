'use strict';
// cram: flashcards from your notes, made by AI, studied in the terminal.
//
//   tot cram biology-notes.md        make a deck from a file
//   tot cram "the French revolution" make a deck about a topic
//   tot cram                         your decks, and what's due today
//
// Studying: Space flips a card; then 1 forgot · 2 hard · 3 got it · 4 easy.
// Cards you know come back less often (1, 3, 7, 16, 35 days); ones you forgot
// come back in the same session. Decks live in ~/.tot/cram/.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const A = require('./ansi');
const Th = require('./theme');
const St = require('./store');
const Ans = require('./answer');
const S = require('./smart');

const DAY = 86400000;
const GAPS = [0, 1, 3, 7, 16, 35]; // days until a card in each box comes back
const dir = () => path.join(St.home(), 'cram');
const slug = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'deck';
const out = (s = '') => process.stdout.write(s + '\n');

function decks() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => (b.studied || b.made) - (a.studied || a.made));
}
function saveDeck(d) { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(path.join(dir(), d.id + '.json'), JSON.stringify(d, null, 1)); }
const due = (d, now = Date.now()) => d.cards.filter((c) => (c.due || 0) <= now);

function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error("The AI didn't make cards this time. Try again.");
  t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); }
}

/** Ask the garden's model (Auto (free) if you have it) to write cards. */
async function make(source, { count = 15, signal } = {}) {
  const cfg = St.config.load();
  const keys = St.keys.load();
  const model = cfg.garden[cfg.current || 0];
  if (!model) throw new Error('cram needs a model: set up free AI first with  tot free');
  let material = source;
  let title = source;
  let fromFile = false;
  try {
    const f = S.attach(source);
    material = f.text.slice(0, 60000);
    title = path.basename(f.name, path.extname(f.name));
    fromFile = true;
  } catch { /* a topic, not a file */ }
  const system = `You make study flashcards for a high-school student. Make ${count} cards${fromFile ? ' from the notes given, using only what they say' : ' about the topic given'}. Each card: a short, clear question on the front, and a short answer (one or two sentences) on the back. Cover the most important ideas, not trivia. Reply with JSON only: {"title": "<a short name for the deck>", "cards": [{"q": "...", "a": "..."}]}`;
  const r = await Ans.answer({ model, garden: cfg.garden, keys, system, signal, fallback: true, messages: [{ role: 'user', content: fromFile ? `Notes:\n\n${material}` : `Topic: ${material}` }] });
  const j = parseJson(r.text);
  const cards = (Array.isArray(j.cards) ? j.cards : []).filter((c) => c && c.q && c.a).slice(0, 60)
    .map((c, i) => ({ id: i, q: String(c.q).slice(0, 400), a: String(c.a).slice(0, 800), box: 0, due: 0 }));
  if (!cards.length) throw new Error("The AI didn't make any cards. Try again, or give it more to work with.");
  const deck = { id: slug(j.title || title), title: String(j.title || title).slice(0, 60), from: fromFile ? source : null, made: Date.now(), by: r.model.name, cards };
  let n = 2;
  const base = deck.id;
  while (fs.existsSync(path.join(dir(), deck.id + '.json'))) deck.id = `${base}-${n++}`;
  saveDeck(deck);
  return deck;
}

/** Grade a card: 1 forgot, 2 hard, 3 got it, 4 easy. */
function grade(card, g, now = Date.now()) {
  if (g === 1) card.box = 0;
  else if (g === 2) card.box = Math.max(1, card.box);
  else if (g === 3) card.box = Math.min(GAPS.length - 1, card.box + 1);
  else card.box = Math.min(GAPS.length - 1, card.box + 2);
  card.due = g === 1 ? now : now + GAPS[card.box] * DAY;
  card.seen = (card.seen || 0) + 1;
  return card;
}

function wrap(text, w) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line && (line + ' ' + word).length > w) { lines.push(line); line = word; } else line = line ? line + ' ' + word : word;
    }
    lines.push(line);
  }
  return lines;
}

/** Study a deck in the terminal. Resolves when you're done (or press q). */
function study(deck) {
  const t = Th.t();
  const queue = due(deck).sort((a, b) => a.box - b.box || a.id - b.id);
  if (!queue.length) { out(`\n  Nothing due in "${deck.title}" today. Come back tomorrow (or: tot cram again ${deck.id}).\n`); return Promise.resolve(); }
  const W = Math.min(70, (process.stdout.columns || 80) - 6);
  const card = (c, flipped, left) => {
    process.stdout.write('\x1b[2J\x1b[H');
    out('');
    out(`  ${A.paint(deck.title, { bold: true, fg: t.leaf })}  ${A.paint(`${left} to go`, { fg: t.dim })}`);
    out('  ' + A.paint('╭' + '─'.repeat(W) + '╮', { fg: t.border }));
    const body = [...wrap(c.q, W - 4).map((l) => A.paint(l, { bold: true }))];
    if (flipped) body.push('', ...wrap(c.a, W - 4).map((l) => A.paint(l, { fg: t.sun })));
    while (body.length < 6) body.push('');
    for (const l of body) out('  ' + A.paint('│', { fg: t.border }) + '  ' + l + ' '.repeat(Math.max(0, W - 2 - A.vwidth(l))) + A.paint('│', { fg: t.border }));
    out('  ' + A.paint('╰' + '─'.repeat(W) + '╯', { fg: t.border }));
    out('');
    out('  ' + A.paint(flipped ? '1 forgot · 2 hard · 3 got it · 4 easy · q stop' : 'space or enter: flip · q stop', { fg: t.dim }));
  };
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    let flipped = false;
    let done = 0;
    const tally = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const finish = () => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
      deck.studied = Date.now();
      saveDeck(deck);
      process.stdout.write('\x1b[2J\x1b[H');
      const next = deck.cards.filter((c) => c.due > Date.now()).sort((a, b) => a.due - b.due)[0];
      out(`\n  ${A.paint('Done for now.', { bold: true, fg: t.leaf })} ${done} card${done === 1 ? '' : 's'}: ${tally[3] + tally[4]} known, ${tally[2]} hard, ${tally[1]} to practise again.`);
      if (next) out(A.paint(`  The next one comes back ${new Date(next.due).toLocaleDateString(undefined, { weekday: 'long' })}.`, { fg: t.dim }));
      out('');
      resolve();
    };
    const onKey = (s, k = {}) => {
      if (k.ctrl && k.name === 'c') return finish();
      if (s === 'q' || k.name === 'escape') return finish();
      const c = queue[0];
      if (!flipped) { if (s === ' ' || k.name === 'return') { flipped = true; card(c, true, queue.length); } return; }
      if (!/^[1-4]$/.test(s || '')) return;
      const g = Number(s);
      tally[g]++;
      done++;
      grade(c, g);
      queue.shift();
      if (g === 1) queue.push(c); // again, later in this session
      saveDeck(deck);
      flipped = false;
      if (!queue.length) return finish();
      card(queue[0], false, queue.length);
    };
    process.stdin.on('keypress', onKey);
    card(queue[0], false, queue.length);
  });
}

async function main(args) {
  Th.use(St.config.load().theme);
  const t = Th.t();
  const nIdx = args.indexOf('-n');
  let count = 15;
  if (nIdx >= 0) { count = Math.max(3, Math.min(40, Number(args[nIdx + 1]) || 15)); args.splice(nIdx, 2); }
  const [first, ...rest] = args;
  if (first === 'again' && rest[0]) { // study every card in a deck now
    const d = decks().find((x) => x.id === rest[0]);
    if (!d) throw new Error(`There's no deck called ${rest[0]}. See: tot cram`);
    d.cards.forEach((c) => { c.due = 0; });
    return study(d);
  }
  if (first === 'delete' && rest[0]) {
    try { fs.unlinkSync(path.join(dir(), slug(rest[0]) + '.json')); out(`  Deleted the deck ${rest[0]}.`); } catch { out(`  There's no deck called ${rest[0]}.`); }
    return;
  }
  const all = decks();
  const named = first && all.find((d) => d.id === first || d.title.toLowerCase() === args.join(' ').toLowerCase());
  if (named) return study(named);
  if (args.length) {
    const what = args.join(' ');
    process.stderr.write(A.paint(`  Making about ${count} cards from ${fs.existsSync(what) ? path.basename(what) : `"${what}"`}…`, { fg: t.dim }));
    let deck;
    try { deck = await make(what, { count }); } finally { process.stderr.write('\r' + ' '.repeat(70) + '\r'); }
    out(`  ${A.paint('✓', { fg: t.ok })} Made "${deck.title}": ${deck.cards.length} cards (by ${deck.by}).`);
    if (!process.stdin.isTTY) return;
    out(A.paint('  Starting… (q stops any time; your progress is kept)', { fg: t.dim }));
    await new Promise((r) => setTimeout(r, 900));
    return study(deck);
  }
  // no arguments: your decks
  out(`\n  ${A.paint('cram', { bold: true, fg: t.leaf })}: flashcards from your notes\n`);
  if (!all.length) {
    out('  No decks yet. Make one:\n');
    out('    tot cram biology-notes.md          from a file');
    out('    tot cram "the water cycle"         about a topic');
    out('    tot cram notes.md -n 25            25 cards\n');
    return;
  }
  all.forEach((d, i) => {
    const n = due(d).length;
    out(`  ${A.paint(String(i + 1).padStart(2), { fg: t.dim })}  ${d.title.padEnd(34).slice(0, 34)} ${A.paint(`${d.cards.length} cards`, { fg: t.dim })}  ${n ? A.paint(`${n} due`, { fg: t.sun }) : A.paint('nothing due', { fg: t.faint })}`);
  });
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((res) => rl.question(A.paint('\n  Which deck? (number, or Enter to leave) ', { fg: t.dim }), (x) => { rl.close(); res(x.trim()); }));
  const pick = all[Number(a) - 1];
  if (pick) return study(pick);
}

module.exports = { main, make, grade, decks, due, study, GAPS };
