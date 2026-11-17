'use strict';
// howto: say what you want to do in the terminal, get the command, and what
// each part of it means. Nothing runs unless you say so.
//
//   tot howto unzip photos.zip into a folder
//   tot howto explain "tar -xzf site.tgz"
//
// Safeguards: it never runs anything by itself; tot checks every command for
// risky parts itself (whatever the AI says), commands that delete, overwrite
// or need your password must be confirmed by typing "yes", and a few (wiping
// disks, fork bombs, piping the internet into sudo) are refused outright.

const os = require('os');
const { spawnSync } = require('child_process');
const A = require('./ansi');
const Th = require('./theme');
const St = require('./store');
const Ans = require('./answer');
const S = require('./smart');
const { copy } = require('./tui');

const NEVER = [
  [/\bmkfs\b|\bdd\s+[^\n]*\bof=\/dev\/|>\s*\/dev\/(sd|disk|nvme|rdisk)/i, 'it writes straight onto a disk'],
  [/:\(\)\s*\{[^}]*\};\s*:/, 'it is a "fork bomb" that freezes the computer'],
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]*\s+)*(\/|~|\$HOME|\/\*|~\/\*)\s*($|;|&)/i, 'it deletes everything in your home folder or the whole disk'],
  [/\b(diskutil\s+(erase|partition|zero)|format\s+[a-z]:)/i, 'it erases a disk'],
  [/(curl|wget)[^|\n]*\|\s*sudo\b/i, 'it runs something from the internet as administrator'],
];
const DANGER = [
  [/\bsudo\b/, 'runs as administrator (it will ask for your password)'],
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, 'deletes files for good (no Trash)'],
  [/\bgit\s+(push\s+[^\n]*(--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*f)/i, 'can throw away git work'],
  [/\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b/i, 'changes who can open files'],
  [/(curl|wget)[^|\n]*\|\s*(ba|z)?sh\b/i, 'runs a script from the internet'],
  [/\b(shutdown|reboot|halt)\b/i, 'turns off or restarts the computer'],
  [/\bkillall\b|\bkill\s+-9\b|\bpkill\b/i, 'force-quits programs (unsaved work is lost)'],
];
const CAREFUL = [
  [/\brm\b|\brmdir\b|\bunlink\b/i, 'deletes something'],
  [/(^|[^>&0-9])>(?!>|&)\s*[^\s|&]/, 'overwrites a file'],
  [/\bmv\b/i, 'moves or renames (can replace a file with the same name)'],
  [/\b(npm|pip3?|brew|gem|cargo)\s+(un)?install\b|\bbrew\s+upgrade\b/i, 'installs or removes software'],
  [/\bkill\b/i, 'stops a program'],
  [/\bcrontab\b|\blaunchctl\b|\bdefaults\s+write\b/i, 'changes system settings'],
];

/** How risky a command is, by tot's own rules (never only the AI's word). */
function risk(cmd) {
  const c = String(cmd || '');
  for (const [re, why] of NEVER) if (re.test(c)) return { level: 'never', why };
  const d = DANGER.filter(([re]) => re.test(c)).map(([, w]) => w);
  if (d.length) return { level: 'dangerous', why: d.join('; ') };
  const k = CAREFUL.filter(([re]) => re.test(c)).map(([, w]) => w);
  if (k.length) return { level: 'careful', why: k.join('; ') };
  return { level: 'safe', why: '' };
}

function shellName() {
  if (process.platform === 'win32') return 'PowerShell on Windows';
  const sh = (process.env.SHELL || '').split('/').pop() || 'sh';
  return `${sh} on ${process.platform === 'darwin' ? 'macOS' : 'Linux'}`;
}

function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error("The AI didn't answer in the expected shape. Try saying it another way.");
  t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); }
}

/** Ask the garden's model (Auto (free) if you have it) for a command. */
async function suggest(request, { explain = false, signal } = {}) {
  const cfg = St.config.load();
  const keys = St.keys.load();
  const model = cfg.garden[cfg.current || 0];
  if (!model) throw new Error('howto needs a model: set up free AI first with  tot free');
  const where = `${shellName()}, in the folder ${process.cwd().replace(os.homedir(), '~')}`;
  const system = explain
    ? `You explain terminal commands to a beginner, in plain words. The shell is ${where}. Reply with JSON only: {"command": "<the command, unchanged>", "what": "<one sentence: what it does>", "parts": [{"text": "<a piece of the command>", "means": "<what it means, a few words>"}], "risk": "safe|careful|dangerous", "why": "<if not safe: what could go wrong>"}`
    : `You turn what someone wants to do into ONE terminal command, for a beginner. The shell is ${where}. Prefer the simplest, safest command that does it; never add sudo unless it can't work without it; never delete or overwrite anything they didn't ask for. Reply with JSON only: {"command": "<one line>", "what": "<one sentence: what it will do>", "parts": [{"text": "<a piece of the command>", "means": "<what it means, a few words>"}], "risk": "safe|careful|dangerous", "why": "<if not safe: what could go wrong>", "note": "<optional tip, e.g. what to install first>"}. If it can't be done with one command, or you'd need to know more, set "command" to "" and say what you need in "what".`;
  const r = await Ans.answer({ model, garden: cfg.garden, keys, messages: [{ role: 'user', content: request }], system, signal, fallback: true });
  const j = parseJson(r.text);
  return { command: String(j.command || '').trim(), what: String(j.what || ''), parts: Array.isArray(j.parts) ? j.parts.slice(0, 12) : [], aiRisk: j.risk, why: String(j.why || ''), note: String(j.note || ''), model: r.model };
}

function out(s = '') { process.stdout.write(s + '\n'); }

function show(s, mine) {
  const t = Th.t();
  const col = { safe: t.ok, careful: t.warn, dangerous: t.err, never: t.err }[mine.level];
  out('');
  if (!s.command) { out('  ' + s.what); return; }
  out('  ' + A.paint('$ ', { fg: t.dim }) + A.paint(s.command, { bold: true, fg: t.sun }));
  out('');
  if (s.what) out('  ' + s.what);
  for (const p of s.parts) if (p && p.text) out(`    ${A.paint(String(p.text).padEnd(16), { fg: t.leaf })} ${A.paint(String(p.means || ''), { fg: t.dim })}`);
  out('');
  const label = { safe: 'safe to run', careful: 'be careful', dangerous: 'dangerous', never: "tot won't run this" }[mine.level];
  out('  ' + A.paint(`● ${label}`, { fg: col, bold: true }) + (mine.why ? A.paint(`: ${mine.why}`, { fg: t.dim }) : '') + (s.why && mine.level !== 'safe' ? A.paint(` (${s.why})`, { fg: t.dim }) : ''));
  if (s.note) out(A.paint(`  tip: ${s.note}`, { fg: t.dim }));
  out(A.paint(`  (from ${s.model.name})`, { fg: t.faint }));
}

function prompt(q) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    let done = false;
    rl.on('close', () => { if (!done) { done = true; res(''); } });
    rl.question(q, (a) => { done = true; rl.close(); res(a.trim()); });
  });
}

function run(cmd) {
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'inherit' })
    : spawnSync(process.env.SHELL || 'sh', ['-c', cmd], { stdio: 'inherit' });
  return r.status;
}

async function main(args) {
  St.config.load();
  Th.use(St.config.load().theme);
  const explain = args[0] === 'explain';
  const request = (explain ? args.slice(1) : args).join(' ').trim();
  const t = Th.t();
  if (!request) {
    out(`
  ${A.paint('howto', { bold: true, fg: t.leaf })}: say what you want to do in the terminal, in your own words.

    tot howto unzip photos.zip into a folder
    tot howto find every file bigger than 100 MB here
    tot howto explain "git reset --soft HEAD~1"

  It shows the command and what every part means. Nothing runs unless you say so,
  and risky commands need you to type "yes".
`);
    return;
  }
  process.stderr.write(A.paint('  thinking…', { fg: t.dim }));
  let s;
  try { s = await suggest(request, { explain }); } finally { process.stderr.write('\r' + ' '.repeat(14) + '\r'); }
  if (explain && !s.command) s.command = request;
  const mine = risk(s.command);
  show(s, mine);
  out('');
  if (!s.command || explain || !process.stdin.isTTY) return;
  if (mine.level === 'never') { out(A.paint("  tot won't run this one. If you really mean it, type it yourself, carefully.", { fg: t.err })); return; }
  const ask = mine.level === 'safe' ? '  r run it · c copy it · Enter to leave it: '
    : mine.level === 'careful' ? '  r run it · c copy it · Enter to leave it: '
      : '  c copy it · type yes to run it anyway · Enter to leave it: ';
  const a = (await prompt(ask)).toLowerCase();
  if (a === 'c') { copy(s.command); out(A.paint('  Copied. Paste it whenever you like.', { fg: t.ok })); return; }
  const go = mine.level === 'dangerous' ? a === 'yes' : a === 'r' || a === 'y' || a === 'yes';
  if (!go) { out(A.paint('  Left it. Nothing ran.', { fg: t.dim })); return; }
  if (mine.level === 'careful' && (await prompt(A.paint(`  It ${mine.why}. Sure? y/N: `, { fg: t.warn }))).toLowerCase() !== 'y') { out(A.paint('  Left it. Nothing ran.', { fg: t.dim })); return; }
  out(A.paint(`  $ ${s.command}`, { fg: t.dim }));
  const code = run(s.command);
  out(A.paint(code === 0 ? '  ✓ done' : `  it finished with code ${code}`, { fg: code === 0 ? t.ok : t.warn }));
  void S;
}

module.exports = { main, risk, suggest, parseJson };
