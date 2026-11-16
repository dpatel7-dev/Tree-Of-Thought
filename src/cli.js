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
  tot ask "question"           ask the current model, answer printed here
  tot ask -m gemini "question" ...or a model from your garden by name
  tot key <service> <key>      save an API key (${P.IDS.filter((i) => i !== 'ollama').join(', ')})
  tot keys                     which keys are saved
  tot garden                   the models in your garden
  tot models [search]          every model your keys can use
  tot theme <name>             colours: ${Th.NAMES.join(', ')}
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
  switch (cmd) {
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
    case 'ask': return ask(rest, cfg);
    case 'update': return update();
    case 'uninstall': return uninstall(rest.includes('--all'));
    default:
      throw new Error(`"${cmd}" isn't a tot command. Try: tot help`);
  }
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

async function ask(args, cfg) {
  let model = cfg.garden[cfg.current || 0];
  const m = args.indexOf('-m');
  if (m >= 0) {
    const want = (args[m + 1] || '').toLowerCase();
    model = cfg.garden.find((g) => `${g.name} ${g.id}`.toLowerCase().includes(want));
    if (!model) throw new Error(`No model in your garden matches "${args[m + 1]}". See: tot garden`);
    args.splice(m, 2);
  }
  let question = args.join(' ').trim();
  if (!question && !process.stdin.isTTY) question = fs.readFileSync(0, 'utf8').trim();
  if (!question) throw new Error('What should I ask? tot ask "your question"');
  if (!model) throw new Error('Your garden is empty. Add a key first: tot key openrouter <your key>');
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') { ac.abort(); process.exit(0); } });
  process.stderr.write(Th.dim(`  ${model.name}\n\n`));
  await P.chat({
    provider: model.provider, key: St.keys.load()[model.provider], model: model.id, signal: ac.signal,
    messages: [{ role: 'user', content: question }], system: cfg.system || undefined,
    onText: (t) => process.stdout.write(t),
  }).catch((e) => { if (e.name !== 'AbortError') throw e; });
  process.stdout.write('\n');
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
