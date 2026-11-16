'use strict';
// Answers come back as Markdown. This turns them into terminal lines: headings,
// lists, quotes, tables, **bold**, *italics*, `code` and fenced code blocks.

const A = require('./ansi');
const Th = require('./theme');

function inline(text) {
  const t = Th.t();
  const out = [];
  let rest = text;
  const re = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\((https?:[^)\s]+)\)|~~([^~]+)~~/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) { out.push(rest); break; }
    out.push(rest.slice(0, m.index));
    if (m[2] !== undefined) out.push(A.paint(m[2], { fg: t.sun }));
    else if (m[3] !== undefined || m[4] !== undefined) out.push(A.paint(m[3] || m[4], { bold: true }));
    else if (m[5] !== undefined || m[6] !== undefined) out.push(A.paint(m[5] || m[6], { italic: true }));
    else if (m[7] !== undefined) out.push(A.paint(m[7], { fg: t.water, underline: true }) + A.paint(` (${m[8]})`, { fg: t.dim }));
    else if (m[9] !== undefined) out.push(A.paint(m[9], { fg: t.dim }));
    rest = rest.slice(m.index + m[0].length);
  }
  return out.join('');
}

/** Wrap styled text to `w` columns, starting continuation lines with `indent`. */
function wrapStyled(text, w, first = '', indent = '') {
  const words = text.split(/(\s+)/);
  const lines = [];
  let line = first;
  let lw = A.vwidth(first);
  for (const word of words) {
    if (!word) continue;
    const ww = A.vwidth(word);
    if (/^\s+$/.test(word)) {
      if (lw > A.vwidth(indent) && lw + 1 <= w) { line += ' '; lw += 1; }
      continue;
    }
    if (lw + ww > w && lw > A.vwidth(indent)) {
      lines.push(line.replace(/\s+$/, ''));
      line = indent;
      lw = A.vwidth(indent);
    }
    if (ww > w - lw) { // a very long word (a link): break it
      let rest = word;
      while (A.vwidth(rest) > w - lw) {
        const [piece] = A.clipW(rest, Math.max(1, w - lw));
        lines.push(line + piece);
        rest = rest.slice(piece.length);
        line = indent;
        lw = A.vwidth(indent);
        if (!piece.length) break;
      }
      line += rest;
      lw += A.vwidth(rest);
      continue;
    }
    line += word;
    lw += ww;
  }
  if (line.trim() || !lines.length) lines.push(line);
  return lines;
}

/** Markdown -> lines exactly `w` columns or less. */
function render(md, w) {
  const t = Th.t();
  w = Math.max(20, w);
  const src = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let blank = false;
  const push = (l) => { out.push(l); blank = false; };
  while (i < src.length) {
    const line = src[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const lang = fence[2];
      const body = [];
      i++;
      while (i < src.length && !src[i].trim().startsWith(fence[1])) body.push(src[i++]);
      i++;
      const inner = w - 2;
      const label = lang ? ' ' + lang + ' ' : '';
      push(A.paint('╭' + A.paint(label, { fg: t.dim }) + '─'.repeat(Math.max(0, inner - A.vwidth(label))), { fg: t.border }));
      for (const b of body.length ? body : ['']) {
        const exp = b.replace(/\t/g, '  ');
        let rest = exp;
        do {
          const [piece] = A.clipW(rest, inner);
          rest = rest.slice(piece.length);
          push(A.paint('│ ', { fg: t.border }) + A.paint(piece, { fg: t.sun }));
          if (!piece.length) break;
        } while (rest.length);
      }
      push(A.paint('╰' + '─'.repeat(inner), { fg: t.border }));
      continue;
    }
    if (!line.trim()) {
      if (!blank && out.length) { out.push(''); blank = true; }
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const txt = inline(h[2].replace(/\s*#+\s*$/, ''));
      push(A.paint(h[1].length <= 2 ? txt : txt, { bold: true, fg: h[1].length === 1 ? t.leaf : h[1].length === 2 ? t.blossom : t.paper.fg }));
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { push(A.paint('─'.repeat(Math.min(w, 40)), { fg: t.border })); i++; continue; }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      for (const l of wrapStyled(inline(quote[1]), w, A.paint('┃ ', { fg: t.leaf }), A.paint('┃ ', { fg: t.leaf }))) push(A.paint(l, { italic: true }));
      i++;
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const depth = Math.min(4, Math.floor(item[1].replace(/\t/g, '  ').length / 2));
      const pad = '  '.repeat(depth);
      const mark = /\d/.test(item[2]) ? A.paint(item[2].replace(')', '.'), { fg: t.leaf }) + ' ' : A.paint(depth % 2 ? '◦' : '•', { fg: t.leaf }) + ' ';
      const indent = pad + ' '.repeat(A.vwidth(mark));
      let body = item[3];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
      if (task) body = (task[1] === ' ' ? '☐ ' : '☑ ') + task[2];
      for (const l of wrapStyled(inline(body), w, pad + mark, indent)) push(l);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) { // a table: line the columns up
      const rows = [];
      while (i < src.length && /^\s*\|.*\|\s*$/.test(src[i])) rows.push(src[i++]);
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => r.trim().slice(1, -1).split('|').map((c) => inline(c.trim())));
      const n = Math.max(...cells.map((c) => c.length));
      const widths = [];
      for (let c = 0; c < n; c++) widths.push(Math.max(...cells.map((r) => A.vwidth(r[c] || ''))));
      let total = widths.reduce((a, b) => a + b, 0) + 3 * (n - 1);
      while (total > w && Math.max(...widths) > 6) { const k = widths.indexOf(Math.max(...widths)); widths[k]--; total--; }
      cells.forEach((r, ri) => {
        const sep = A.paint(' │ ', { fg: t.border });
        push(r.map((c, k) => { const [x, used] = A.clipW(c || '', widths[k]); return (ri === 0 ? A.paint(x, { bold: true }) : x) + ' '.repeat(Math.max(0, widths[k] - used)); }).join(sep));
        if (ri === 0) push(A.paint(widths.map((x) => '─'.repeat(x)).join('─┼─'), { fg: t.border }));
      });
      continue;
    }
    // a paragraph: join soft-wrapped lines
    const para = [line.trim()];
    i++;
    while (i < src.length && src[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(src[i])) para.push(src[i++].trim());
    for (const l of wrapStyled(inline(para.join(' ')), w)) push(l);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/** Plain wrapping for things that aren't Markdown (your own questions). */
function plain(text, w) {
  const out = [];
  for (const para of String(text || '').split('\n')) out.push(...wrapStyled(para, Math.max(10, w)));
  return out;
}

/** The fenced code blocks in an answer (for /copy code). */
function codeBlocks(md) {
  const out = [];
  const re = /^\s*(```+|~~~+)[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm;
  let m;
  while ((m = re.exec(String(md || '')))) out.push(m[2].replace(/\n$/, ''));
  return out;
}

module.exports = { render, plain, inline, codeBlocks, wrapStyled };
