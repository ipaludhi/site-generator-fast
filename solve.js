// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Same answers as the reference, byte for byte, produced faster.
// Strategy (one hypothesis per iteration, measured against the baseline
// beside it on this machine): bulk HTML escaping instead of per-character
// escapeHtml calls, single-pass Markdown rendered straight from the line
// list (no token objects), cached slugify (ASCII fast path), head-only
// front-matter scan, array-joined template output, lazy `loop` objects,
// word counting by char scan. No dependency, no I/O, no clock, no random.
//
// The reference semantics live in the kit's vendor/makefun-site/; every
// branch below mirrors it. Where a fast path exists it is provably the
// same function on its inputs (ASCII-only slugify, ASCII-only word count
// with a regex fallback for any other string).

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
/** `text` with & < > " and ' escaped. The common no-specials case costs
 *  one native test scan and no allocation; the replace runs only when a
 *  special is actually present. */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}
/** Escape of one character (used for a backslash-escaped character). */
function escapeChar(c) {
  const e = ESCAPES[c];
  return e === undefined ? c : e;
}

const SLUG_MAX = 64;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Slug cache, per build: titles, tag names and heading texts repeat. */
let slugCache = null;
/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every
 *  run of characters other than a-z and 0-9 one "-", none at either end,
 *  at most 64 characters (a "-" left at the cut dropped), "untitled" when
 *  nothing is left. Pure-ASCII input takes the fast path: NFKD is the
 *  identity on ASCII and ASCII holds no combining marks. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  // Single pass: build the ASCII slug directly; a non-ASCII character
  // restarts on the full NFKD path (NFKD is the identity on ASCII).
  let ascii = true;
  out = '';
  {
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch >= 128) { ascii = false; break; }
      let keep = -1;
      if (ch >= 65 && ch <= 90) keep = ch + 32;
      else if ((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57)) keep = ch;
      if (keep === -1) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  }
  if (!ascii) {
    out = '';
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Line helpers over a string with "\n" ends, without splitting it. */
function lineEnd(text, from) {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * The reference splits the whole source into lines; this scans line
 * boundaries only until the closing `---`, then slices the body out.
 * Identical results: the first line must be exactly `---`, the close is
 * the first later line exactly `---`, line numbers count from 1 at the
 * opening `---`.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // First line is '---'; scan for the closing line.
  let pos = 4; // just past '---\n' (text === '---' has no close: handled below)
  let close = -1;
  let closeEnd = -1;
  if (text.length === 3) return { error: 'the front matter is not closed' };
  let lineNo = 2;
  while (pos <= text.length) {
    const end = lineEnd(text, pos);
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      close = lineNo;
      closeEnd = end;
      break;
    }
    if (end === text.length) break;
    pos = end + 1;
    lineNo++;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Parse lines 2..close-1 (1-based), i.e. text positions after line 1.
  pos = 4;
  for (let i = 2; i < close; i++) {
    const end = lineEnd(text, pos);
    const line = text.slice(pos, end);
    if (line !== '' && !/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${i} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = end + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
function isEscapable(code) {
  // char codes of the escapable set
  return code === 92 || code === 96 || code === 42 || code === 95 || code === 91 || code === 93 ||
    code === 40 || code === 41 || code === 35 || code === 43 || code === 45 || code === 46 ||
    code === 33 || code === 62;
}

/** Trim spaces/tabs at both ends (the reference's trimLine, without regex). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (text never empty). Fast
 *  pre-check on the first character; the regex decides the rest. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function isFenceOpen(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && FENCE_OPEN.test(line);
}
function isHr(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && HR.test(line);
}
/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlank(line) || isFenceOpen(line) || headingOf(line) !== null || isHr(line);
}

/** The first index from `from` where `s` holds `what` outside a backslash
 *  escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an
 *  escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Index of the nearest inline special (`\`, backtick, `*`, `[`) at or
 *  after `from`, or -1. Four native indexOf scans beat a per-character
 *  JavaScript loop over mostly-plain prose. */
function nextSpecial(s, from) {
  let j = -1;
  let k = s.indexOf('\\', from);
  if (k !== -1) j = k;
  k = s.indexOf('`', from);
  if (k !== -1 && (j === -1 || k < j)) j = k;
  k = s.indexOf('*', from);
  if (k !== -1 && (j === -1 || k < j)) j = k;
  k = s.indexOf('[', from);
  if (k !== -1 && (j === -1 || k < j)) j = k;
  return j;
}

/**
 * `s` rendered inline into array `out`; `env.link(target)` is a link's href.
 * Plain runs are flushed through escapeHtml in bulk instead of one
 * escapeHtml call per character (the reference's hot spot); specials are
 * found by native indexOf and handled at their position. Output is
 * identical: escaping is per character, runs concatenate in order, and a
 * special with no partner stays in the plain run exactly as the reference
 * leaves it (a lone backslash before a non-escapable character, a lone
 * backtick, `**` with no closer, a lone `*`, a `[` that is no link).
 */
function inlineTo(s, env, out) {
  let i = 0;
  let last = 0;
  const n = s.length;
  while (i < n) {
    const p = nextSpecial(s, i);
    if (p === -1) break;
    const c = s.charCodeAt(p);
    if (c === 92) { // backslash
      if (p + 1 < n && isEscapable(s.charCodeAt(p + 1))) {
        if (last < p) out.push(escapeHtml(s.slice(last, p)));
        out.push(escapeChar(s[p + 1]));
        i = p + 2;
        last = i;
      } else {
        i = p + 1;
      }
      continue;
    }
    if (c === 96) { // backtick: code span
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) {
        if (last < p) out.push(escapeHtml(s.slice(last, p)));
        out.push('<code>', escapeHtml(s.slice(p + 1, j)), '</code>');
        i = j + 1;
        last = i;
      } else {
        i = p + 1;
      }
      continue;
    }
    if (c === 42) { // asterisk: strong or emphasis
      if (s.charCodeAt(p + 1) === 42) {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) {
          if (last < p) out.push(escapeHtml(s.slice(last, p)));
          out.push('<strong>');
          inlineTo(s.slice(p + 2, j), env, out);
          out.push('</strong>');
          i = j + 2;
          last = i;
        } else {
          i = p + 2;
        }
        continue;
      }
      const j = findSingleStar(s, p + 1);
      if (j > p + 1) {
        if (last < p) out.push(escapeHtml(s.slice(last, p)));
        out.push('<em>');
        inlineTo(s.slice(p + 1, j), env, out);
        out.push('</em>');
        i = j + 1;
        last = i;
      } else {
        i = p + 1;
      }
      continue;
    }
    // '[': link
    const k = findUnescaped(s, ']', p + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      if (last < p) out.push(escapeHtml(s.slice(last, p)));
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineTo(s.slice(p + 1, k), env, out);
      out.push('</a>');
      i = m + 1;
      last = i;
    } else {
      i = p + 1;
    }
  }
  if (last < n) out.push(escapeHtml(s.slice(last)));
}

function inline(s, env) {
  const out = [];
  inlineTo(s, env, out);
  return out.join('');
}

/**
 * `src` rendered: HTML, table of contents (level 2/3 headings) and excerpt
 * (first paragraph's inline HTML, or ""). Rendered straight from the line
 * list in one pass, no token objects: each block is built and pushed as
 * the lines are consumed, exactly as the reference's lex+render would.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    // Fence
    if (line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < total && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        const code = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    }
    // Heading
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    // Thematic break
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    // Blockquote
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < total && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    // List
    const c0 = line.charCodeAt(0);
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bullet = BULLET.exec(line);
      const ordered = bullet === null ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED : BULLET;
        const items = [];
        while (i < total) {
          const m = marker.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(isOrdered ? m[2] : m[1])]);
            i++;
          } else if (/^ {2,}\S/.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
        const parts = [open, '\n'];
        for (const item of items) parts.push('<li>', inline(item.join('\n'), env), '</li>\n');
        parts.push(`</${tag}>`);
        blocks.push(parts.join(''));
        continue;
      }
    }
    // Paragraph
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  // Each block followed by "\n": join with "\n" between them plus one at
  // the end (no extra array or per-block string over the reference's
  // blocks.map(b => b + "\n").join("")).
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEndPos = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEndPos));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/**
 * Whether a node list ever reads `loop` (directly, or through an include,
 * transitively). A for-loop whose body never reads `loop` needs no `loop`
 * object per iteration: the reference creates one, but nothing can observe
 * it unless a path reads it, and a nested for that does read `loop` makes
 * its own.
 */
function readsLoop(nodes, templates, seen) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (n.path[0] === 'loop') return true;
    } else if (n.kind === 'if') {
      if (n.path[0] === 'loop') return true;
      if (readsLoop(n.then, templates, seen)) return true;
      if (n.else !== null && readsLoop(n.else, templates, seen)) return true;
    } else if (n.kind === 'for') {
      if (n.path[0] === 'loop') return true;
      if (readsLoop(n.body, templates, seen)) return true;
    } else if (n.kind === 'include') {
      if (seen.has(n.name)) continue;
      seen.add(n.name);
      const t = templates.get(n.name);
      if (t !== undefined && readsLoop(t, templates, seen)) return true;
    }
  }
  return false;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src, templates) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [], usesLoop: false };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile a parsed template into a plain function (scope, ctx, depth, out).
 * Same semantics as renderNodes on the same tree: the generated code is a
 * straight-line transcription of the nodes (text/var/raw/if/for/include),
 * with the same lookup/textOf/truthy helpers and the same include-depth
 * rule. A template that fails to compile simply stays interpreted.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const gen = (ns, scopeVar) => {
    let code = '';
    for (const n of ns) {
      if (n.kind === 'text') code += `out.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var') code += `out.push(ctx.esc(ctx.textOf(ctx.lk(${scopeVar},${JSON.stringify(n.path)}))));`;
      else if (n.kind === 'raw') code += `out.push(ctx.textOf(ctx.lk(${scopeVar},${JSON.stringify(n.path)})));`;
      else if (n.kind === 'if') {
        const cond = n.not
          ? `!ctx.truthy(ctx.lk(${scopeVar},${JSON.stringify(n.path)}))`
          : `ctx.truthy(ctx.lk(${scopeVar},${JSON.stringify(n.path)}))`;
        code += `if(${cond}){${gen(n.then, scopeVar)}}`;
        if (n.else !== null) code += `else{${gen(n.else, scopeVar)}}`;
      } else if (n.kind === 'for') {
        const u = uid++;
        const xs = `_x${u}`;
        const kk = `_k${u}`;
        const s2 = `_s${u}`;
        const ln = `_l${u}`;
        // The for-scope always carries `loop` (undefined when the body
        // cannot read it): one hidden class per loop variable.
        const loopPart = n.usesLoop
          ? `,loop:{index:${kk}+1,first:${kk}===0,last:${kk}===${ln}-1,length:${ln}}`
          : ',loop:undefined';
        code += `{const ${xs}=ctx.lk(${scopeVar},${JSON.stringify(n.path)});if(Array.isArray(${xs})){const ${ln}=${xs}.length;for(let ${kk}=0;${kk}<${ln};${kk}++){const ${s2}={vars:{${JSON.stringify(n.name)}:${xs}[${kk}]${loopPart}},parent:${scopeVar}};${gen(n.body, s2)}}}}`;
      } else if (n.kind === 'include') {
        const u = uid++;
        const cf = `_c${u}`;
        const nt = `_n${u}`;
        code += `{const ${cf}=ctx.compiled.get(${JSON.stringify(n.name)});if(${cf}!==undefined){if(depth<8)${cf}(${scopeVar},ctx,depth+1,out);}else{const ${nt}=ctx.templates.get(${JSON.stringify(n.name)});if(${nt}!==undefined&&depth<8)ctx.rn(${nt},${scopeVar},ctx,depth+1,out);}}`;
      }
    }
    return code;
  };
  return new Function('scope', 'ctx', 'depth', 'out', gen(nodes, 'scope'));
}

/** `nodes` rendered into array `out`, in `scope`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          // Every for-scope has the same two keys (loop is undefined when
          // the body cannot read it): one hidden class per loop variable
          // instead of a new shape per for, so property access stays
          // monomorphic while the code is still cold.
          const vars = { [n.name]: xs[k], loop: n.usesLoop ? { index: k + 1, first: k === 0, last: k === len - 1, length: len } : undefined };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const UNICODE_WS = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
/** The words of a body: runs of characters other than whitespace. One
 *  pass: ASCII whitespace separates, every other character is a word
 *  character — exact unless the text holds a Unicode whitespace character,
 *  in which case the reference's regex counts instead. */
function wordsOf(text) {
  if (UNICODE_WS.test(text)) {
    const m = text.match(/\S+/g);
    return m === null ? 0 : m.length;
  }
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, text });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

function tags(b) {
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function layouts(b) {
  // Cards are built once per source and shared: pageOf spreads the same
  // card the lists use, and reading_minutes is counted once per body.
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      let rm = s._readingMinutes;
      if (rm === undefined) {
        rm = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
        s._readingMinutes = rm;
      }
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: rm,
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, c);
    }
    return c;
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, compiled: b.compiled, escape: escapeHtml, esc: escapeHtml, lk: lookup, textOf, truthy, rn: renderNodes };
  const render = (name, vars) => {
    // The top scope always has the same seven keys in the same order
    // (absent ones undefined, which reads exactly like a missing key):
    // one hidden class for every render, so lookups stay monomorphic.
    const scope = { vars: { site, tags: allTags, recent, page: vars.page, posts: vars.posts, pager: vars.pager, tag: vars.tag }, parent: null };
    const out = [];
    const fn = b.compiled.get(name);
    if (fn !== undefined) {
      fn(scope, ctx, 0, out);
      return out.join('');
    }
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name], templates));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  // A for-loop's `loop` object is only built when its body can read it
  // (through includes, transitively). Templates are parsed in name order
  // and includes may point forward, so this pass runs after all parses.
  const markUsesLoop = (nodes, seen) => {
    for (const n of nodes) {
      if (n.kind === 'for') {
        n.usesLoop = readsLoop(n.body, templates, new Set());
        markUsesLoop(n.body, seen);
      } else if (n.kind === 'if') {
        markUsesLoop(n.then, seen);
        if (n.else !== null) markUsesLoop(n.else, seen);
      }
    }
  };
  for (const nodes of templates.values()) markUsesLoop(nodes, new Set());
  // JIT-compile every template; one that fails to compile stays
  // interpreted (e.g. if this runtime disallows code generation).
  const compiled = new Map();
  for (const [tname, nodes] of templates) {
    try {
      compiled.set(tname, compileTemplate(nodes));
    } catch {
      // interpreter fallback for this template
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    compiled,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}
