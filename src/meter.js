'use strict';
// The usage tracker: how much you've asked each free service today, how much
// it says is left, and when it refills. Auto (free) uses this to send each
// question where there's room, and `tot usage` / Tab → Usage show it.
//
// Where the numbers come from, best first:
//   1. what the service itself says after each answer (rate-limit headers)
//   2. "you've hit the limit" answers (then that model rests until it refills)
//   3. our own count for today against the service's published allowance
//
// Kept in ~/.tot/meter.json. Days are UTC days, like most services' limits.

const fs = require('fs');
const path = require('path');
const St = require('./store');
const F = require('./free');

const file = () => path.join(St.home(), 'meter.json');
const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const keyOf = (m) => `${m.provider}:${m.id}`;
const HOUR = 3600000;

function load() {
  let s;
  try { s = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { s = null; }
  s = s && typeof s === 'object' ? s : {};
  s.days = s.days || {};
  s.limits = s.limits || {};
  s.blocked = s.blocked || {};
  // keep two weeks of history
  for (const d of Object.keys(s.days).sort().slice(0, -14)) delete s.days[d];
  return s;
}
function save(s) {
  try { fs.mkdirSync(path.dirname(file()), { recursive: true }); const tmp = file() + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, file()); } catch { /* best effort */ }
}

/** "1m30.5s", "2h", "45s", "120" (seconds) or an epoch time → milliseconds from now. */
function duration(v) {
  if (v === undefined || v === null || v === '') return null;
  const str = String(v).trim();
  if (/^\d{12,}$/.test(str)) return Math.max(0, Number(str) - Date.now()); // epoch ms
  if (/^\d{9,11}$/.test(str)) return Math.max(0, Number(str) * 1000 - Date.now()); // epoch s
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str) * 1000;
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m;
  let any = false;
  while ((m = re.exec(str))) { any = true; ms += Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: HOUR }[m[2]]; }
  return any ? ms : null;
}

/** Note an answer (or a failure) from a model: usage, what the service says is left, limits hit. */
function record(model, { usage = null, headers = {}, error = null } = {}) {
  if (!model || F.isAuto(model)) return;
  const s = load();
  const k = keyOf(model);
  const d = (s.days[today()] = s.days[today()] || {});
  const row = (d[k] = d[k] || { req: 0, in: 0, out: 0, fail: 0 });
  if (error) row.fail++;
  else {
    row.req++;
    if (usage) { row.in += Number(usage.in) || 0; row.out += Number(usage.out) || 0; }
  }
  const h = headers || {};
  const num = (x) => (x === undefined || x === null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
  const lim = {
    remainReq: num(h['x-ratelimit-remaining-requests'] ?? h['x-ratelimit-remaining']),
    limitReq: num(h['x-ratelimit-limit-requests'] ?? h['x-ratelimit-limit']),
    remainTok: num(h['x-ratelimit-remaining-tokens']),
    limitTok: num(h['x-ratelimit-limit-tokens']),
    resetReq: duration(h['x-ratelimit-reset-requests'] ?? h['x-ratelimit-reset']),
    at: Date.now(),
  };
  if (lim.remainReq !== null || lim.remainTok !== null) s.limits[k] = lim;
  if (error && Number(error.status) === 429) {
    // rest until it refills: what the service said, else a guess (a whole day if the limit is 0)
    const wait = duration(h['retry-after']) ?? lim.resetReq ?? (/limit:\s*0\b|per day|daily|quota/i.test(String(error.detail || error.message)) ? untilMidnight() : 10 * 60000);
    s.blocked[k] = Date.now() + Math.max(30000, Math.min(wait, 26 * HOUR));
  }
  save(s);
}

function untilMidnight(t = Date.now()) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t;
}

/** Is this model resting after hitting its limit? */
function blocked(model, s = load()) {
  const until = s.blocked[keyOf(model)] || 0;
  return until > Date.now() ? until : 0;
}

/** Roughly how much room is left for a model today, 0..1 (1 if we don't know of any limit). */
function headroom(model, s = load()) {
  if (blocked(model, s)) return 0;
  const k = keyOf(model);
  const l = s.limits[k];
  if (l && Date.now() - l.at < 30 * 60000) {
    const parts = [];
    if (l.limitReq && l.remainReq !== null) parts.push(l.remainReq / l.limitReq);
    if (l.limitTok && l.remainTok !== null) parts.push(l.remainTok / l.limitTok);
    if (parts.length) return Math.max(0, Math.min(1, Math.min(...parts)));
  }
  const svc = F.byId(model.provider);
  if (svc && svc.daily) {
    const d = s.days[today()] || {};
    const used = svc.daily.perModel ? (d[k] || {}).req || 0
      : Object.entries(d).filter(([kk]) => kk.startsWith(model.provider + ':')).reduce((a, [, r]) => a + r.req, 0);
    return Math.max(0, 1 - used / svc.daily.requests);
  }
  return 1;
}

/**
 * A row per free service you've set up: how much you've asked today, what's
 * left (and whether that's what the service said, or our estimate), and when
 * it refills. Plus history for the last week.
 */
function summary(garden = St.config.load().garden || [], keys = St.keys.load()) {
  const s = load();
  const d = s.days[today()] || {};
  const rows = [];
  for (const svc of F.SERVICES) {
    if (!keys[svc.id]) continue;
    const models = garden.filter((m) => m.provider === svc.id);
    const mine = Object.entries(d).filter(([k]) => k.startsWith(svc.id + ':'));
    const asked = mine.reduce((a, [, r]) => a + r.req, 0);
    const tokens = mine.reduce((a, [, r]) => a + r.in + r.out, 0);
    let left = null;
    let exact = false;
    let refill = null;
    const known = models.map((m) => s.limits[keyOf(m)]).filter((l) => l && Date.now() - l.at < 30 * 60000 && l.remainReq !== null);
    if (known.length) {
      left = known.reduce((a, l) => a + l.remainReq, 0);
      exact = true;
      const r = known.map((l) => l.resetReq).filter((x) => x !== null);
      if (r.length) refill = Date.now() + Math.min(...r);
    } else if (svc.daily) {
      const per = svc.daily.requests;
      left = svc.daily.perModel ? models.reduce((a, m) => a + Math.max(0, per - ((d[keyOf(m)] || {}).req || 0)), 0) : Math.max(0, per - asked);
      refill = Date.now() + untilMidnight();
    }
    const resting = models.filter((m) => blocked(m, s));
    const state = models.length && resting.length === models.length ? 'out'
      : left !== null && svc.daily && left < (svc.daily.perModel ? svc.daily.requests * models.length : svc.daily.requests) * 0.15 ? 'low' : 'ok';
    rows.push({
      id: svc.id, name: svc.name, models: models.length, asked, tokens, left, exact, refill,
      perMinute: svc.perMinute || null, allowance: svc.allowance, state,
      resting: resting.map((m) => ({ name: m.name, until: blocked(m, s) })),
    });
  }
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const day = today(Date.now() - i * 86400000);
    const dd = s.days[day] || {};
    week.push({ day, asked: Object.values(dd).reduce((a, r) => a + r.req, 0) });
  }
  return { rows, week, asked: rows.reduce((a, r) => a + r.asked, 0) };
}

/** Plain-language advice: what to set up next, what's running low, when things refill. */
function tips(sum = summary(), keys = St.keys.load()) {
  const out = [];
  const missing = F.SERVICES.filter((s) => !s.extra && !keys[s.id]);
  if (!sum.rows.length) {
    out.push('No free services yet. Run tot free (or Tab → Set up free AI): it takes about a minute each.');
    return out;
  }
  for (const r of sum.rows) {
    if (r.state === 'out') out.push(`${r.name} is used up for now${r.refill ? ` (refills ${when(r.refill)})` : ''}. Auto (free) is using your other services meanwhile.`);
    else if (r.state === 'low') out.push(`${r.name} is running low today${r.left !== null ? ` (about ${r.left} left)` : ''}. Auto (free) will lean on the others.`);
  }
  if (missing.length) {
    const next = missing[0];
    out.push(`Add ${next.name} for more free room (${next.allowance}): tot free.`);
  }
  if (sum.rows.length >= 3 && !out.length) out.push(`You have ${sum.rows.length} free services: that's plenty for a normal day.`);
  return out;
}

function when(t) {
  const m = Math.round((t - Date.now()) / 60000);
  if (m <= 1) return 'in a minute';
  if (m < 60) return `in ${m} minutes`;
  const h = Math.round(m / 60);
  return h < 24 ? `in about ${h} hour${h === 1 ? '' : 's'}` : 'tomorrow';
}

/** One short line for the screen: "today: 23 asked · plenty left". */
function line(sum = summary()) {
  if (!sum.rows.length) return '';
  const out = sum.rows.filter((r) => r.state === 'out').length;
  const low = sum.rows.filter((r) => r.state === 'low').length;
  const state = out === sum.rows.length ? 'all used up for now' : out || low ? `${sum.rows.length - out} of ${sum.rows.length} services with room` : 'plenty left';
  return `today: ${sum.asked} asked · ${state}`;
}

module.exports = { record, blocked, headroom, summary, tips, line, when, duration, load, today, file };
