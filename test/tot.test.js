'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough, Writable } = require('stream');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tot-test-'));
process.env.TOT_HOME = home;
process.env.TUI_NO_OPEN = '1';
const fake = require('../dev/fake-ai');
const P = require('../src/providers');
const St = require('../src/store');
const Md = require('../src/markdown');
const A = require('../src/ansi');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(15); }
}

let svc;
test.before(async () => {
  svc = await fake.start(0, { delay: 1 });
  for (const id of P.IDS) process.env[`TOT_URL_${id.toUpperCase()}`] = svc.url;
});
test.after(() => svc.server.close());

test('model lists: names cleaned up, prices per million, a garden of strong models', async () => {
  const all = await P.listModels('openrouter', 'k');
  const opus = all.find((m) => m.id === 'anthropic/claude-test-opus');
  assert.equal(opus.name, 'Claude Test Opus');
  assert.equal(opus.price.out, 75);
  const garden = P.pickGarden(all);
  const ids = garden.map((m) => m.id);
  assert.ok(ids.includes('anthropic/claude-test-opus'), 'the flagship, not the small one');
  assert.ok(!ids.includes('anthropic/claude-test-haiku'));
  assert.ok(!ids.some((i) => /:free|image/.test(i)), 'no free variants or image models by default');
  assert.equal(new Set(garden.map((m) => m.id.split('/')[0])).size, garden.length, 'one per maker');
  assert.ok(P.pickGarden(all, { free: true }).every((m) => m.free));
  await assert.rejects(P.listModels('openrouter', 'bad-key'), /didn't accept your key/);
});

test('streaming answers: OpenAI style (with thinking) and Anthropic style', async () => {
  let pieces = 0;
  const r = await P.chat({ provider: 'openrouter', key: 'k', model: 'openai/gpt-test', messages: [{ role: 'user', content: 'hello there' }], system: 'be brief', onText: () => pieces++ });
  assert.match(r.text, /gpt-test\*\* here\. You asked: _hello there_/);
  assert.equal(r.thought, 'Let me think about it. ');
  assert.ok(pieces > 5, 'it arrives a word at a time');
  assert.equal(r.usage.in, 12);
  const sent = svc.seen[svc.seen.length - 1];
  assert.equal(sent.body.messages[0].role, 'system');
  assert.equal(sent.headers['x-title'], 'Tree of Thought');

  const a = await P.chat({ provider: 'anthropic', key: 'k', model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], system: 'be brief' });
  assert.match(a.text, /claude-x/);
  const asent = svc.seen[svc.seen.length - 1];
  assert.equal(asent.body.system, 'be brief');
  assert.equal(asent.headers['anthropic-version'], '2023-06-01');

  await assert.rejects(P.chat({ provider: 'openai', key: '', model: 'x', messages: [] }), /no key for OpenAI/);
  await assert.rejects(P.chat({ provider: 'openrouter', key: 'k', model: 'x', messages: [{ role: 'user', content: 'please fail' }] }), /error 500: the model fell over/);
  const ac = new AbortController();
  const p = P.chat({ provider: 'openrouter', key: 'k', model: 'x', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal, onText: () => ac.abort() });
  await assert.rejects(p, (e) => e.name === 'AbortError');
});

test('a conversation is a tree: branches, siblings, turning between them', () => {
  const c = new St.Chat();
  const q = c.add(null, 'user', { text: 'name a cat' });
  const a1 = c.add(q.id, 'assistant', { text: 'Pixel' });
  const a2 = c.add(q.id, 'assistant', { text: 'Mochi' });
  c.leaf = a1.id;
  assert.equal(c.title, 'name a cat');
  assert.deepEqual(c.path().map((n) => n.text), ['name a cat', 'Pixel']);
  assert.equal(c.siblings(a1.id).length, 2);
  c.turn(a1.id, 1);
  assert.equal(c.path().pop().text, 'Mochi');
  const f = c.add(a2.id, 'user', { text: 'why?' });
  const g = c.add(f.id, 'assistant', { text: 'it is soft' });
  c.turn(a2.id, -1);
  c.turn(a1.id, 1); // back to Mochi: goes to the newest end of that branch
  assert.equal(c.leaf, g.id);
  assert.equal(c.branches, 2);
  c.nodes[g.id].live = true;
  St.chats.save(c);
  const back = St.chats.load(c.id);
  assert.equal(back.path().length, 4);
  assert.equal(back.nodes[g.id].live, undefined, 'saved without the "being written" flag');
  assert.equal(St.chats.load('../../etc/passwd'), null);
  assert.match(St.toMarkdown(back), /\*\*You\*\*\n\nwhy\?/);
});

test('markdown: lists, code blocks, tables, wrapping', () => {
  A.setLevel(0);
  const lines = Md.render('# Title\n\nSome **bold** and `code` here that goes on for a while to wrap around the edge.\n\n- one\n- two\n  - nested\n\n```py\nprint(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |', 30);
  assert.equal(lines[0], 'Title');
  assert.ok(lines.every((l) => A.vwidth(l) <= 30), 'nothing wider than asked');
  assert.ok(lines.includes('• one') && lines.includes('  ◦ nested'));
  assert.ok(lines.some((l) => l === '│ print(1)'));
  assert.ok(lines.some((l) => /^╭ py ─+$/.test(l)));
  assert.ok(lines.some((l) => /^a +│ b$/.test(l)));
  assert.deepEqual(Md.codeBlocks('x\n```js\nlet a = 1;\n```\ny'), ['let a = 1;']);
  A.setLevel(3);
});

test('the screen: ask, ask every model, flip branches, edit into a new branch', async () => {
  const input = new PassThrough();
  input.setRawMode = () => {};
  let drawn = '';
  const output = new Writable({ write(c, e, cb) { drawn += c.toString(); cb(); } });
  output.columns = 110;
  output.rows = 34;
  St.keys.set('openrouter', 'k');
  const cfg = St.config.load();
  cfg.garden = P.pickGarden(await P.listModels('openrouter', 'k')).slice(0, 3).map((m) => ({ provider: 'openrouter', id: m.id, name: m.name }));
  St.config.save(cfg);
  const { App } = require('../src/app');
  const app = new App({ input, output });
  const done = app.run();
  await sleep(50);
  input.write('name a cat\r');
  await until(() => app.chat.path().length === 2 && !app.jobs.size, 'the first answer');
  assert.match(app.chat.path()[1].text, /claude-test-opus/);
  await sleep(150);
  assert.match(drawn, /claude-test-opus/);

  input.write('\x07'); // ctrl+g: every model in the garden
  await until(() => app.chat.siblings(app.chat.path()[1].id).length === 3 && !app.jobs.size, 'every model to answer');
  const before = app.chat.path()[1].id;
  input.write('\x1b[C'); // right arrow: the next answer
  await sleep(30);
  assert.notEqual(app.chat.path()[1].id, before);

  input.write('\x05'); // ctrl+e: edit the question
  await sleep(20);
  assert.equal(app.ed.text, 'name a cat');
  input.write('\x15name a dog\r'); // ctrl+u, new text
  await until(() => app.chat.path()[0].text === 'name a dog' && !app.jobs.size, 'the new branch');
  assert.equal(app.chat.siblings(app.chat.path()[0].id).length, 2, 'the old question is still there, next to it');

  input.write('/theme meadow\r');
  await sleep(20);
  assert.equal(St.config.load().theme, 'meadow');
  input.write('\x04'); // ctrl+d
  await done;
  assert.match(drawn, /\x1b\]111\x07/, 'the terminal gets its own colours back');
});
