'use strict';
// `tot` and its sub-commands.

const fs = require('fs');
const path = require('path');
const A = require('./ansi');
const Th = require('./theme');
const P = require('./providers');
const St = require('./store');
const Pl = require('./plants');
const pkg = require('../package.json');

const HELP = `
  Tree of Thought ${pkg.version} - many AI models in one terminal garden

  tot                          open the garden
  tot what is osmosis?         a quick answer right here (then ask follow-ups, or Enter to finish)
  tot -m gemini "question"     ...from a model in your garden, by name
  tot -f notes.md "summarise"  ...with a file attached (or pipe one in: cat x.py | tot explain this)
  tot free                     set up free AI in the cloud: a minute per service, as easy as copy and paste
  tot usage                    how much each free service has left today, and tips
  tot local                    optional: a model on this computer (works offline, uses your computer)

  Little tools (they use your free models):
  tot cram notes.md            flashcards made from your notes (or a topic), studied right here
  tot howto unzip a file       the terminal command for what you want, explained; runs only if you say so
  tot tidy ~/Downloads         an AI that tidies a folder (a separate app: installs if needed)
  tot key <service> <key>      save an API key (${P.IDS.filter((i) => i !== 'ollama' && i !== 'custom').join(', ')})
  tot keys                     which keys are saved
  tot garden                   the models in your garden
  tot models [search]          every model your keys can use
  tot theme <name>             colours: ${Th.NAMES.join(', ')}
  tot dashboard                your chats (as trees), garden, keys and settings in the browser
  tot check                    which AI services this network lets through
  tot pull <model>             download a model to run on this computer (needs Ollama)
  tot update                   get the newest version
  tot uninstall                remove Tree of Thought (add --all to delete your chats and keys too)
  tot --version

  Inside: Enter asks · Ctrl+G asks every model · ← → flips between answers ·
          Ctrl+E edits your question into a new branch · Tab opens the menu
`;

function out(s = '') { process.stdout.write(s + '\n'); }

async function main(argv) {
  const [cmd, ...rest] = argv;
  const cfg = St.config.load();
  Th.use(cfg.theme);
  P.setCustomBase(cfg.customBase);
  switch (cmd) {
    case 'dashboard': case 'web': case 'browser': {
      const d = await require('./dashboard').serve();
      out(`\n  Your garden is open in the browser: ${d.url}\n  ${A.paint('Keep this window open while you use it (Ctrl+C to stop).', { fg: Th.t().dim })}\n`);
      await new Promise(() => {});
      return;
    }
    case 'check': case 'doctor': case 'network': {
      out('\n  Checking which AI services this network lets through…\n');
      const res = await P.checkNetwork();
      const word = { ok: ['works', Th.t().ok], slow: ['slow', Th.t().warn], blocked: ['blocked', Th.t().err], inspected: ['inspected', Th.t().warn], off: ['not running', Th.t().dim] };
      const w = (s) => (s ? A.paint((word[s] || [s])[0].padEnd(12), { fg: (word[s] || [])[1] }) : A.paint('-'.padEnd(12), { fg: Th.t().dim }));
      out(A.paint('  ' + 'service'.padEnd(18) + 'answers'.padEnd(12) + 'key website', { fg: Th.t().dim }));
      for (const r of res) out('  ' + r.name.padEnd(18) + w(r.api) + w(r.site));
      const ok = res.filter((r) => r.api === 'ok' && r.id !== 'ollama').map((r) => r.name);
      out('\n  ' + (ok.length ? `Works on this network: ${ok.join(', ')}.` : 'No online service gets through here, but models on this computer (Ollama) still work.'));
      if (res.some((r) => r.api === 'inspected')) out(A.paint('  "inspected" means this network swaps secure certificates, so those connections aren\'t trusted.', { fg: Th.t().dim }));
      out('');
      return;
    }
    case 'pull': {
      const name = rest[0];
      if (!name) throw new Error('Which model? tot pull llama3.2   (names are on ollama.com/library)');
      let last = '';
      await P.ollamaPull(name, {
        onProgress: (p) => {
          const line = p.total ? `${p.status} ${Math.round((100 * p.done) / p.total)}%` : p.status;
          if (line !== last && process.stdout.isTTY) process.stdout.write(`\r  ${line.padEnd(60).slice(0, 60)}`);
          last = line;
        },
      });
      out(`\r  ${A.paint('✓', { fg: Th.t().ok })} ${name} is on this computer. Plant it: tot, Tab → Plant a model.`.padEnd(70));
      return;
    }
    case undefined: {
      if (!process.stdin.isTTY || !process.stdout.isTTY) { out(HELP); return; }
      const { App } = require('./app');
      await new App().run();
      return;
    }
    case '--version': case '-v': case 'version': out(`tree-of-thought ${pkg.version}`); return;
    case 'help': case '--help': case '-h': out(HELP); return;
    case 'key': {
      const [id, ...k] = rest;
      if (!P.PROVIDERS[id] || !k.length) throw new Error(`Usage: tot key <${P.IDS.join('|')}> <your key>`);
      if (require('./free').byId(id)) return addFreeKey(id, k.join(''), cfg);
      St.keys.set(id, k.join(''));
      out(`  Saved your ${P.PROVIDERS[id].name} key.`);
      if (!cfg.garden.some((m) => m.provider === id)) await plant(id, cfg);
      return;
    }
    case 'keys': {
      const keys = St.keys.load();
      for (const id of P.IDS) {
        const p = P.PROVIDERS[id];
        out(`  ${(keys[id] ? Th.leaf('✓') : p.noKey ? Th.dim('·') : Th.dim('✗'))} ${p.name.padEnd(18)} ${Th.dim(keys[id] ? 'saved' : p.noKey ? 'no key needed' : p.keyUrl)}`);
      }
      return;
    }
    case 'garden': {
      if (!cfg.garden.length) { out('  Your garden is empty. Add a key: tot key openrouter <your key>'); return; }
      cfg.garden.forEach((m, i) => {
        const plant = Pl.plantFor(m);
        out(`  ${i === cfg.current ? Th.leaf('›') : ' '} ${A.paint('✿', { fg: Pl.color(plant) })} ${m.name.padEnd(36)} ${Th.dim(P.PROVIDERS[m.provider].name)}`);
      });
      return;
    }
    case 'models': {
      const keys = St.keys.load();
      const want = rest.join(' ').toLowerCase();
      const ids = P.IDS.filter((id) => keys[id] || id === 'ollama');
      let n = 0;
      for (const id of ids) {
        let list;
        try { list = await P.listModels(id, keys[id]); } catch (e) { if (id !== 'ollama') out(`  ${Th.err('✗')} ${e.message}`); continue; }
        for (const m of list.filter((x) => x.text && (!want || `${x.name} ${x.id}`.toLowerCase().includes(want)))) {
          out(`  ${A.paint('✿', { fg: Pl.color(Pl.plantFor(m)) })} ${m.name.slice(0, 40).padEnd(41)} ${Th.dim(`${id}  ${m.id}`)}`);
          n++;
        }
      }
      if (!n) out(ids.length ? '  No models found.' : '  Add a key first: tot key openrouter <your key>');
      return;
    }
    case 'theme': {
      if (!Th.THEMES[rest[0]]) throw new Error(`Pick one of: ${Th.NAMES.join(', ')}`);
      cfg.theme = rest[0];
      St.config.save(cfg);
      out(`  Colours: ${rest[0]}`);
      return;
    }
    case 'ask': case 'q': return ask(rest, cfg);
    case 'free': case 'setup': return freeSetup(cfg, rest);
    case 'cram': case 'flashcards': return require('./cram').main(rest);
    case 'howto': case 'how': return require('./howto').main(rest);
    case 'local': case 'offline': return free(cfg);
    case 'usage': case 'stats': case 'limits': return usage();
    case 'tidy': {
      const { spawnSync } = require('child_process');
      const r = spawnSync('tidy', rest, { stdio: 'inherit', shell: process.platform === 'win32' });
      if (r.error) throw new Error('tidy isn\'t installed yet. Install it with pca, or: curl -fsSL https://raw.githubusercontent.com/dpatel7-dev/tidy/main/install.sh | sh');
      return;
    }
    case 'update': return update();
    case 'uninstall': return uninstall(rest.includes('--all'));
    default: {
      // a pasted key on its own ("tot gsk_…"): add it
      const F = require('./free');
      if (argv.length === 1 && F.guess(cmd)) return addFreeKey(F.guess(cmd), cmd, cfg);
      // a near-miss of a command ("tot updte") gets a hint; anything else is a question
      const near = COMMANDS.find((c) => argv.length === 1 && cmd.length > 2 && !/\?$/.test(cmd) && close(cmd.toLowerCase(), c));
      if (near) throw new Error(`Did you mean: tot ${near}?   (To ask it as a question: tot ask ${cmd})`);
      if (cmd.startsWith('--')) throw new Error(`"${cmd}" isn't something tot knows. Try: tot help`);
      return ask(argv, cfg);
    }
  }
}

async function addFreeKey(id, key, cfg) {
  const F = require('./free');
  out(Th.dim(`  Checking your ${F.byId(id).name} key…`));
  const { picked } = await F.addKey(id, key, cfg);
  out(`  ${A.paint('✓', { fg: Th.t().ok })} Saved. Planted ${picked.map((m) => m.name).join(', ')}. Auto (free) is your default: try  tot what is a black hole?`);
}

async function plant(id, cfg) {
  out(`  Planting your garden from ${P.PROVIDERS[id].name}…`);
  try {
    const all = await P.listModels(id, St.keys.load()[id]);
    const pick = id === 'openrouter' ? P.pickGarden(all) : all.filter((m) => m.text).sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 5);
    for (const m of pick) cfg.garden.push({ provider: id, id: m.id, name: m.name, price: m.price, free: m.free });
    St.config.save(cfg);
    for (const m of pick) out(`    ${A.paint('✿', { fg: Pl.color(Pl.plantFor(m)) })} ${m.name}`);
  } catch (e) {
    out(`  ${e.message}`);
  }
}

const COMMANDS = ['dashboard', 'check', 'pull', 'help', 'key', 'keys', 'garden', 'models', 'theme', 'ask', 'free', 'setup', 'local', 'usage', 'update', 'uninstall', 'tidy', 'cram', 'howto', 'version'];
function close(a, b) { // at most two typos apart
  if (Math.abs(a.length - b.length) > 2) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] <= 2 && a !== b;
}

/**
 * A quick question, answered right here. Then follow-ups until you press Enter
 * on an empty line. It's saved as a chat, so it's in your garden later.
 */
async function ask(args, cfg) {
  const S = require('./smart');
  const Ans = require('./answer');
  args = [...args];
  let model = cfg.garden[cfg.current || 0];
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' || args[i] === '--model') {
      const want = (args[i + 1] || '').toLowerCase();
      model = cfg.garden.find((g) => `${g.name} ${g.id}`.toLowerCase().includes(want));
      if (!model) throw new Error(`No model in your garden matches "${args[i + 1]}". See: tot garden`);
      args.splice(i, 2); i--;
    } else if (args[i] === '-f' || args[i] === '--file') {
      files.push(S.attach(args[i + 1] || ''));
      args.splice(i, 2); i--;
    }
  }
  let question = args.join(' ').trim();
  if (!process.stdin.isTTY) {
    const piped = fs.readFileSync(0, 'utf8');
    if (question && piped.trim()) files.push({ name: 'input', text: piped.slice(0, 200 * 1024), bytes: piped.length });
    else if (!question) question = piped.trim();
  }
  if (!question) throw new Error('What should I ask? tot what is osmosis?');
  if (!model) {
    const local = await P.ollamaHere();
    if (local && local.length) model = { provider: 'ollama', id: local[0].id, name: local[0].name };
  }
  if (!model) throw new Error('Your garden is empty. Set up free AI in about a minute: tot free');
  const keys = St.keys.load();
  const chat = new St.Chat({ project: null });
  const live = process.stdout.isTTY;
  const interactive = live && process.stdin.isTTY;
  let ac = null;
  let stops = 0;
  process.on('SIGINT', () => { if (ac && !ac.signal.aborted && stops++ === 0) { ac.abort(); return; } process.stdout.write('\n'); process.exit(130); });
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') { if (ac) ac.abort(); process.exit(0); } });
  const head = (m) => {
    const plant = Pl.plantFor(m);
    const maker = S.makerOf(m);
    process.stderr.write('\n' + A.paint('✿ ', { fg: Pl.color(plant) }) + A.paint(m.name, { bold: true, fg: Pl.color(plant) }) + Th.dim(maker ? `  ${maker}` : '') + '\n\n');
  };
  let parent = null;
  for (;;) {
    const q = chat.add(parent, 'user', { text: question, ...(files.length ? { files: files.splice(0) } : {}) });
    const messages = chat.path(q.id).filter((n) => n.text && !n.err).map((n) => ({ role: n.role, content: n.role === 'user' ? S.withFiles(n.text, n.files) : n.text }));
    const node = chat.add(q.id, 'assistant', { model: `${model.provider}:${model.id}`, name: model.name, provider: model.provider });
    chat.leaf = node.id;
    ac = new AbortController();
    stops = 0;
    if (model.provider !== 'auto') head(model);
    const started = Date.now();
    try {
      const r = await Ans.answer({
        model, garden: cfg.garden, keys, messages, system: cfg.system || undefined, signal: ac.signal, fallback: cfg.fallback !== false,
        onText: (t) => { node.text += t; process.stdout.write(t); },
        onSwitch: (next, why) => { if (why) process.stderr.write(Th.dim(`  ${why.model.name} ${why.why}: asking ${next.name} instead…\n`)); head(next); },
      });
      Object.assign(node, { model: `${r.model.provider}:${r.model.id}`, name: r.model.name, provider: r.model.provider, usage: r.usage || undefined, took: Date.now() - started });
      model = r.model; // keep talking to whoever answered
      if (r.trimmed) process.stderr.write(Th.dim(`\n  (a long chat: the ${r.trimmed} oldest messages were left out so it fits)`));
    } catch (e) {
      if (e.name === 'AbortError') { node.stopped = true; process.stdout.write(Th.dim('  (stopped)')); } else { node.err = e.message; process.stderr.write(Th.err(`\n  ${e.message}`) + (e.tried && e.tried.length ? Th.dim(`\n  Also tried: ${e.tried.map((t) => t.model.name).join(', ')}.`) : '')); }
    }
    process.stdout.write('\n');
    St.chats.save(chat);
    ac = null;
    if (!interactive) return;
    parent = node.id;
    const next = await followUp();
    if (!next) {
      process.stderr.write(Th.dim(`  Saved in your garden as "${chat.title}" (open it with: tot)\n\n`));
      return;
    }
    if (/^\/file\s+/.test(next)) {
      try { files.push(S.attach(next.replace(/^\/file\s+/, ''))); process.stderr.write(Th.dim('  Attached. Now type your question.\n')); } catch (e) { process.stderr.write(Th.err(`  ${e.message}\n`)); }
      const q2 = await followUp();
      if (!q2) return;
      question = q2;
    } else question = next;
  }
}

function followUp() {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
    let done = false;
    rl.on('close', () => { if (!done) { done = true; resolve(''); } });
    rl.question('\n' + Th.dim('  follow up, or press Enter to finish') + '\n' + A.paint('↳ ', { fg: Th.t().leaf, bold: true }), (a) => { done = true; rl.close(); resolve(a.trim()); });
  });
}

/**
 * Free AI in the cloud, one service at a time: open its key page, wait for the
 * key (copied, or pasted here), check it, plant its best free models.
 */
async function freeSetup(cfg, rest = []) {
  const F = require('./free');
  const keys = St.keys.load();
  const only = rest[0] && F.byId(rest[0].toLowerCase());
  const todo = only ? [only] : F.SERVICES.filter((sv) => !sv.extra || rest.includes('--all'));
  const watching = F.canWatch();
  const { open } = require('./tui');
  const leaf = (x) => A.paint(x, { fg: Th.t().leaf, bold: true });
  out(`\n  ${leaf('Free AI, in the cloud')}  ${Th.dim('(the models run on their computers, not yours)')}\n`);
  out(Th.dim('  For each service: a page opens, you make a free key, and click Copy.'));
  out(Th.dim(watching ? '  tot notices the copied key by itself. (Or paste it here.)' : '  Then paste it here and press Enter.'));
  out(Th.dim('  Enter = set it up · s = skip · q = stop. The more you add, the more you can ask each day.\n'));
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];
  let wake = null;
  rl.on('line', (l) => { lines.push(l); if (wake) wake(); });
  rl.on('close', () => { lines.push(null); if (wake) wake(); });
  const nextLine = () => new Promise((res) => { if (lines.length) return res(lines.shift()); wake = () => { wake = null; res(lines.shift()); }; });
  let added = 0;
  try {
    for (const sv of todo) {
      const have = !!keys[sv.id];
      out(`  ${have ? A.paint('✓', { fg: Th.t().ok }) : leaf('›')} ${A.paint(sv.name, { bold: true })}  ${Th.dim(sv.good)}`);
      out(Th.dim(`    ${sv.allowance} · needs ${sv.needs}`));
      if (have) { out(Th.dim('    already set up\n')); continue; }
      process.stdout.write(Th.dim('    Enter to set it up, s to skip: '));
      const a = await nextLine();
      if (a === null || /^q/i.test(a.trim())) break;
      if (/^s/i.test(a.trim())) { out(''); continue; }
      open(sv.keyUrl);
      out(Th.dim(`    Opened ${sv.keyUrl}`));
      sv.steps.forEach((x, i) => out(`      ${i + 1}. ${x}`));
      process.stdout.write(Th.dim(`    ${watching ? 'Waiting for you to copy the key (or paste it here)…' : 'Paste the key here and press Enter:'} `));
      for (;;) {
        const got = await new Promise((resolve) => {
          let stop = () => {};
          if (watching) stop = F.watchClipboard(sv.id, (k) => { resolve({ key: k, copied: true }); });
          nextLine().then((l) => { stop(); resolve({ key: l, copied: false }); });
        });
        const key = got.key;
        if (key === null) return;
        if (got.copied) out(A.paint('got it', { fg: Th.t().ok }));
        if (!key.trim() || /^s/i.test(key.trim())) { out(''); break; }
        try {
          out(Th.dim('    Checking it…'));
          const { picked, cfg: c } = await F.addKey(sv.id, key.trim(), cfg);
          Object.assign(cfg, c);
          keys[sv.id] = key.trim();
          added++;
          out(`    ${A.paint('✓', { fg: Th.t().ok })} ${sv.name} works. Planted: ${picked.map((m) => m.name).join(', ')}\n`);
          break;
        } catch (e) {
          out(Th.err(`    ${e.message}`));
          process.stdout.write(Th.dim('    Try again (copy or paste the key), or s to skip: '));
        }
      }
    }
  } finally { rl.close(); }
  const n = F.SERVICES.filter((sv) => keys[sv.id]).length;
  if (n) {
    out(`\n  ${leaf('Auto (free)')} is your default now: it sends each question to the best free model with room left`);
    out(Th.dim(`  (${n} free service${n === 1 ? '' : 's'} set up${added ? `, ${added} just now` : ''}). Try it:  tot why is the sky blue?   ·   tot usage shows what's left.\n`));
  } else out(Th.dim('\n  Nothing set up yet. Run tot free again any time.\n'));
}

/** Optional: download a model to run on this computer (works offline; uses your computer). */
async function free(cfg) {
  const S = require('./smart');
  const have = await P.ollamaModels();
  const { memoryGB, picks } = S.localPicks();
  if (!have) {
    out(`
  Free models with no limits run on your own computer, using Ollama (a free app).

  ${Th.leaf('1.')} Download it:  https://ollama.com/download
  ${Th.leaf('2.')} Open it once (on a Mac, a llama appears at the top of the screen).
  ${Th.leaf('3.')} Run this again:  tot free
`);
    return;
  }
  out(`\n  This computer has about ${memoryGB} GB of memory. Best fits:\n`);
  picks.forEach((p, i) => out(`  ${i === 0 ? Th.leaf('›') : ' '} ${p.name.padEnd(14)} ${Th.dim(`${p.about} · about ${p.gb} GB`)}`));
  const got = new Set(have.map((m) => m.name));
  for (const p of picks) {
    if (!got.has(p.name)) {
      out(`\n  Downloading ${p.name} (about ${p.gb} GB, only once)…`);
      try {
        let last = '';
        await P.ollamaPull(p.name, { onProgress: (x) => { const l = x.total ? `${Math.round((100 * x.done) / x.total)}%` : x.status; if (l !== last && process.stdout.isTTY) process.stdout.write(`\r  ${l.padEnd(30)}`); last = l; } });
      } catch (e) {
        if (/does not exist|not found|404|manifest/i.test(e.message)) { out(Th.dim(`\r  ${p.name} isn't available any more; trying the next one.`)); continue; }
        throw e;
      }
    }
    if (!cfg.garden.some((g) => g.provider === 'ollama' && g.id === p.name)) cfg.garden.push({ provider: 'ollama', id: p.name, name: p.name });
    cfg.current = cfg.garden.findIndex((g) => g.provider === 'ollama' && g.id === p.name);
    St.config.save(cfg);
    out(`\r  ${A.paint('✓', { fg: Th.t().ok })} ${p.name} is planted and picked. Try it: tot why is the sky blue?`.padEnd(60) + '\n');
    return;
  }
  throw new Error('None of those could be downloaded. Pick one from ollama.com/library: tot pull <name>');
}

function usage() {
  const S = require('./smart');
  const Me = require('./meter');
  const sum = Me.summary();
  const n = (x) => (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : String(x));
  if (sum.rows.length) {
    const max = Math.max(1, ...sum.week.map((d) => d.asked));
    const spark = sum.week.map((d) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((d.asked / max) * 7))]).join('');
    out(`\n  ${A.paint('Free services today', { bold: true })}  ${Th.dim(Me.line(sum))}  ${Th.dim('last 7 days')} ${A.paint(spark, { fg: Th.t().leaf })}\n`);
    for (const r of sum.rows) {
      const col = r.state === 'out' ? Th.t().err : r.state === 'low' ? Th.t().warn : Th.t().ok;
      const mark = A.paint(r.state === 'out' ? '✗' : r.state === 'low' ? '!' : '✓', { fg: col });
      const left = r.left === null ? (r.perMinute ? `${r.perMinute}/minute, no daily limit` : 'no published limit') : `${r.exact ? '' : '~'}${r.left} left${r.exact ? ' (the service says)' : ''}`;
      out(`  ${mark} ${r.name.padEnd(15)} ${String(r.asked).padStart(4)} asked  ${n(r.tokens).padStart(6)} tokens   ${Th.dim(left)}${r.refill && r.state !== 'ok' ? Th.dim(` · refills ${Me.when(r.refill)}`) : ''}`);
      for (const z of r.resting) out(Th.dim(`      ${z.name} is resting (refills ${Me.when(z.until)})`));
    }
    out('');
  }
  for (const t of Me.tips(sum)) out('  ' + A.paint('› ', { fg: Th.t().leaf }) + t);
  const rows = S.usage(St.chats.all());
  if (!rows.length) { out(''); return; }
  out(Th.dim('\n  Every model, all time:'));
  out(Th.dim('  ' + 'model'.padEnd(34) + 'answers'.padStart(8) + 'tokens in'.padStart(12) + 'out'.padStart(10) + 'cost'.padStart(10)));
  for (const r of rows) out(`  ${r.name.slice(0, 33).padEnd(34)}${String(r.answers).padStart(8)}${n(r.in).padStart(12)}${n(r.out).padStart(10)}${(r.cost ? '$' + r.cost.toFixed(4) : '-').padStart(10)}`);
  out(Th.dim('\n  A token is about three quarters of a word.\n'));
}

function installUrl(kind) {
  let site = '';
  try { site = fs.readFileSync(path.join(St.home(), 'hub'), 'utf8').trim(); } catch { /* installed from GitHub */ }
  if (/^https?:\/\//.test(site)) return `${site.replace(/\/+$/, '')}/tot/install.${kind}`;
  return `https://raw.githubusercontent.com/dpatel7-dev/Tree-Of-Thought/main/install.${kind}`;
}

function update() {
  const { spawnSync } = require('child_process');
  const win = process.platform === 'win32';
  const url = installUrl(win ? 'ps1' : 'sh');
  out(`  Updating from ${url}`);
  const r = win
    ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${url} | iex`], { stdio: 'inherit' })
    : spawnSync('sh', ['-c', `curl -fsSL "${url}" | sh`], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('The update did not finish. Your current version still works.');
}

function uninstall(all) {
  const root = St.home();
  let launcher = '';
  try { launcher = fs.readFileSync(path.join(root, 'launcher'), 'utf8').trim(); } catch { /* not installed by the installer */ }
  for (const p of [path.join(root, 'app'), path.join(root, 'node')]) fs.rmSync(p, { recursive: true, force: true });
  if (launcher && /tot(\.cmd)?$/.test(launcher)) fs.rmSync(launcher, { force: true });
  if (all) fs.rmSync(root, { recursive: true, force: true });
  out(`  Tree of Thought is uninstalled.${all ? '' : ` Your chats and keys are still in ${root} (delete that folder to remove them too).`}`);
}

module.exports = { main, HELP };
