// Fastmake — a fast, from-scratch reimplementation of makefun-site 1.0.0.
//
// Written from the makefun-site README and the observed behaviour of its
// reference code, in my own words and structure. It returns, for one case's
// input, exactly the output tree makefun-site 1.0.0 builds: every page's
// index.html, the index and tag pages, build-report.txt and each static file,
// byte for byte. No dependencies, no I/O, no clock, no randomness.
//
// Speed comes from doing the same work with less of it:
//  - Markdown is rendered in one direct pass over the lines, with no token
//    objects and no per-character escaping: inline text is copied in whole
//    chunks and escaped in bulk, and the inline scanner jumps from one
//    construct to the next with native indexOf searches.
//  - Slugs are cached per run and take a pure-ASCII fast path (no NFKD
//    normalisation when the text holds no non-ASCII character).
//  - Front matter is scanned with indexOf over the header only; the body is
//    a slice, never a split-and-join.
//  - Templates are parsed once per case and rendered into an array that is
//    joined once, instead of repeated string concatenation.
//  - Word counting, link resolution and the small lookups are hand-rolled
//    loops instead of regular expressions.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const MARK_RE = /\p{M}/gu;

function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC_MAP[c]) : s;
}

/** Slug of `text`, cached in `cache` (one cache per run). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

function uniqueSlug(slug, taken, next) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = next.get(slug) || 2;
  let out = slug + '-' + n;
  while (taken.has(out)) {
    n++;
    out = slug + '-' + n;
  }
  next.set(slug, n + 1);
  taken.add(out);
  return out;
}

function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

/** Words of a body: runs of non-whitespace characters. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c <= 32 || c === 160;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return 'a quoted string is not closed';
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return 'a quoted string holds an escape other than \\" or \\\\';
        out += n;
        i++;
      } else if (c === '"') return 'a quoted string holds a stray quote';
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return 'a bare string opens on [';
  return { value: raw };
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return typeof s === 'string' ? `key "${key}": ${s}` : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return 'key "tags": not a list [a, b]';
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        if (tags[i] === '' || !FM_TAG.test(tags[i])) return 'key "tags": an empty tag, or one holding " [ or ]';
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : 'key "draft": true or false';
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : 'key "layout": not a template name';
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : 'key "slug": not a slug';
    default:
      return `unknown key "${key}"`;
  }
}

/** Parse front matter: { data, body } or { error }. `text` has "\n" ends. */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line: a line that is exactly '---'.
  let closeStart = -1;
  let closeEnd = -1;
  let pos = text.indexOf('\n---', 3);
  while (pos !== -1) {
    const after = pos + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = pos + 1;
      closeEnd = after;
      break;
    }
    pos = text.indexOf('\n---', pos + 1);
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1;
  let ls = 4; // start of the second line ('---\n' is 4 chars)
  while (ls < closeStart) {
    let le = text.indexOf('\n', ls);
    if (le === -1 || le >= closeStart) le = closeStart - 1;
    lineNo++;
    const line = text.slice(ls, le);
    ls = le + 1;
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if (typeof v === 'string') return { error: v };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Next inline-construct opener: backslash, backtick, star or '['. One
 * shared regex: every exec is preceded by setting lastIndex, so the nested
 * inline calls (which work on other strings) cannot disturb each other. */
const INLINE_RE = /[\\`*[]/g;

function isSpaceTab(c) { return c === 32 || c === 9; }

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  return line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Fence opener: language or '' ('' when the line is just the fence), else null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    const lang = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!lang) break;
    j++;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    if (!isSpaceTab(line.charCodeAt(j))) return null;
    j++;
  }
  return lang;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) if (!isSpaceTab(line.charCodeAt(j))) return false;
  return true;
}

/** Heading: { depth, text } or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || !isSpaceTab(line.charCodeAt(n))) return null;
  let a = n;
  while (a < line.length && isSpaceTab(line.charCodeAt(a))) a++;
  let b = line.length;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let j = 3; j < line.length; j++) if (!isSpaceTab(line.charCodeAt(j))) return false;
  return true;
}

function findUnescaped(s, what, from) {
  const w0 = what.charCodeAt(0);
  const w1 = what.length > 1 ? what.charCodeAt(1) : -1;
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (c !== w0) continue;
    if (w1 === -1 || s.charCodeAt(j + 1) === w1) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/**
 * Render `s` inline into `out` (an array of string pieces). `link` resolves
 * a link target to its href. Mirrors the reference exactly, including its
 * quirks: a code span closes at the next backtick even when escaped, and a
 * link's target is found with a plain (not escape-aware) indexOf(')').
 */
function inlineInto(s, link, out) {
  const len = s.length;
  let i = 0;
  while (i < len) {
    // Copy a run of plain text up to the next construct opener. The scan
    // runs in the regex engine, not in a per-character JavaScript loop.
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    const j = m === null ? len : m.index;
    if (j > i) {
      out.push(esc(s.slice(i, j)));
      i = j;
      if (i >= len) break;
    }
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < len && ESCAPABLE[s.charCodeAt(i + 1)] === 1) {
      const n = s[i + 1];
      out.push(ESC_MAP[n] !== undefined ? ESC_MAP[n] : n);
      i += 2;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out.push('<code>', esc(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s.slice(i + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out.push('<em>');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    // Unreachable for the four openers above; kept for safety.
    out.push(esc(s[i]));
    i++;
  }
}

/** Line classes, so each line is classified once instead of re-tested while
 * a paragraph looks for its end: 0 blank, 1 fence, 2 heading, 3 hr,
 * 4 quote, 5 bullet, 6 ordered, 7 anything else (a paragraph line). */
function classifyLines(lines) {
  const cls = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) { cls[i] = 0; continue; }
    if (fenceOpen(line) !== null) { cls[i] = 1; continue; }
    if (headingOf(line) !== null) { cls[i] = 2; continue; }
    if (isHr(line)) { cls[i] = 3; continue; }
    if (line.charCodeAt(0) === 62) { cls[i] = 4; continue; }
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) { cls[i] = 5; continue; }
    let d = 0;
    while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
    if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) { cls[i] = 6; continue; }
    cls[i] = 7;
  }
  return cls;
}

/** A list item's text for an ordered line, or null when it is not one. */
function orderedItem(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) return { text: line.slice(d + 2), start: Number(line.slice(0, d)) };
  return null;
}

/**
 * Render one body's Markdown: { html, toc, excerpt }. `slugCache` is the
 * run's slug cache, `link` the source's link resolver. Direct single pass:
 * no token objects are built.
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const cls = classifyLines(lines);
  // One shared piece array for the whole body: blocks are appended in
  // order, each followed by '\n', and joined once at the end. A block that
  // is also needed as a string (first paragraph's excerpt, a heading's
  // inline HTML for the toc) is read back from the pieces it just wrote.
  const out = [];
  const toc = [];
  const ids = new Set();
  const idNext = new Map();
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const kind = cls[i];
    if (kind === 0) { i++; continue; }
    const line = lines[i];
    if (kind === 1) {
      const lang = fenceOpen(line);
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>`);
      if (body.length > 0) {
        out.push(esc(body.join('\n')));
        out.push('\n');
      }
      out.push('</code></pre>', '\n');
      continue;
    }
    if (kind === 2) {
      const heading = headingOf(line);
      const id = uniqueSlug(slugify(heading.text, slugCache), ids, idNext);
      out.push(`<h${heading.depth} id="${id}">`);
      const mark = out.length;
      inlineInto(heading.text, link, out);
      let html = null;
      if (heading.depth === 2 || heading.depth === 3) {
        html = out.slice(mark).join('');
        toc.push({ level: heading.depth, id, html });
      }
      out.push(`</h${heading.depth}>`, '\n');
      i++;
      continue;
    }
    if (kind === 3) {
      out.push('<hr>', '\n');
      i++;
      continue;
    }
    if (kind === 4) {
      const body = [];
      while (i < lines.length && cls[i] === 4) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      if (body.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(body.join('\n'), link, out);
        out.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isOrdered = kind === 6;
      const items = [];
      let start = 1;
      let first = true;
      while (i < lines.length) {
        const l = lines[i];
        let m = null;
        if (isOrdered) {
          if (cls[i] === 6) {
            const o = orderedItem(l);
            m = o.text;
            if (first) start = o.start;
          }
        } else if (cls[i] === 5) m = l.slice(2);
        if (m !== null) {
          items.push([trimLine(m)]);
          first = false;
          i++;
        } else if (/^ {2,}\S/.test(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const parts of items) {
        out.push('<li>');
        inlineInto(parts.join('\n'), link, out);
        out.push('</li>', '\n');
      }
      out.push(`</${tag}>`, '\n');
      continue;
    }
    out.push('<p>');
    const mark = out.length;
    const body = [trimLine(line)];
    i++;
    while (i < lines.length) {
      const k = cls[i];
      if (k === 0 || k === 1 || k === 2 || k === 3) break;
      body.push(trimLine(lines[i++]));
    }
    inlineInto(body.join('\n'), link, out);
    if (excerpt === null) excerpt = out.slice(mark).join('');
    out.push('</p>', '\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

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
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
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
    const lineEnd = nl === -1 ? src.length : nl;
    let beforeOk = true;
    for (let j = lineStart; j < open; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) { beforeOk = false; break; }
    }
    let afterOk = true;
    for (let j = end; j < lineEnd; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) { afterOk = false; break; }
    }
    const standalone = beforeOk && afterOk;
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
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
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
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
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, node.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, node.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, node.path));
        const branch = v !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          if (!(k in xs)) continue;
          const vars = {};
          vars[node.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(node.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------- compiling templates
//
// A parsed template is also compiled to a plain JavaScript function, so
// rendering runs as direct property reads and pushes instead of walking a
// node tree with a scope chain. The compiler mirrors renderNodes exactly
// (same lookup, text, truth and include rules); if compilation is ever
// unavailable the tree-walk above is used instead.

/** One own-property step of a template path: the value's own property, or undefined. */
function getSeg(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

function lkExpr(path, sv) {
  let e = sv + '.' + path[0];
  for (let k = 1; k < path.length; k++) e = 'G(' + e + ',' + JSON.stringify(path[k]) + ')';
  return e;
}

let TMPL_UID = 0;

function genNodes(nodes, sv, out) {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out.push('O.push(' + JSON.stringify(node.text) + ');');
        break;
      case 'var':
        out.push('O.push(E(T(' + lkExpr(node.path, sv) + ')));');
        break;
      case 'raw':
        out.push('O.push(T(' + lkExpr(node.path, sv) + '));');
        break;
      case 'if': {
        const cond = 'Y(' + lkExpr(node.path, sv) + ')';
        out.push('if(' + (node.not ? '!' + cond : cond) + '){');
        genNodes(node.then, sv, out);
        if (node.else !== null) {
          out.push('}else{');
          genNodes(node.else, sv, out);
        }
        out.push('}');
        break;
      }
      case 'for': {
        const id = TMPL_UID++;
        const sv2 = 'S' + id;
        out.push('{const X' + id + '=' + lkExpr(node.path, sv) + ';if(Array.isArray(X' + id + ')){for(let K' + id + '=0;K' + id + '<X' + id + '.length;K' + id + '++){if(!(K' + id + ' in X' + id + '))continue;const ' + sv2 + '=Object.create(' + sv + ');' + sv2 + '.' + node.name + '=X' + id + '[K' + id + '];' + sv2 + '.loop={index:K' + id + '+1,first:K' + id + '===0,last:K' + id + '===X' + id + '.length-1,length:X' + id + '.length};');
        genNodes(node.body, sv2, out);
        out.push('}}}');
        break;
      }
      case 'include': {
        const id = TMPL_UID++;
        out.push('{if(D<8){const T' + id + '=TF[' + JSON.stringify(node.name) + '];if(T' + id + '!==undefined)T' + id + '(' + sv + ',D+1,O,TF);}}');
        break;
      }
    }
  }
}

/** Compile every parsed template to a function (S, D, O, TF), or null. */
function compileTemplates(templates) {
  const names = [...templates.keys()];
  const parts = ['"use strict";'];
  for (let i = 0; i < names.length; i++) {
    TMPL_UID = 0;
    const body = [];
    genNodes(templates.get(names[i]), 'S', body);
    parts.push('function f' + i + '(S,D,O,TF){' + body.join('') + '}');
  }
  parts.push('return {' + names.map((n, i) => JSON.stringify(n) + ':f' + i).join(',') + '};');
  const factory = new Function('T', 'E', 'Y', 'G', parts.join('\n'));
  return factory(textOf, esc, truthy, getSeg);
}

// -------------------------------------------------------------------- build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(cmp);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. Sources, sorted by path; line ends made "\n"; the rest is static.
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused, generator-owned dir, post with no
  // date, unknown layout, draft. The first failure is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (let d = 0; d < RESERVED.length; d++) {
      if (RESERVED[d] !== 'posts' && s.path.startsWith(RESERVED[d] + '/')) { own = RESERVED[d]; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slug made unique in its directory, in source order.
  const taken = new Map();
  const nextIn = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    let next = nextIn.get(dir);
    if (next === undefined) {
      next = new Map();
      nextIn.set(dir, next);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title, slugCache), set, next);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to pages and static files.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags !== undefined ? s.data.tags : [];
    for (const name of tags) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      const t = bySlug.get(slug);
      return t !== undefined ? t : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date !== undefined ? s.data.date : '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => {
    const c = s.post ? cards.get(s) : cardOf(s);
    return {
      ...c,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer !== undefined && s.newer !== null ? s.newer : null),
      older: linkOf(s.older !== undefined && s.older !== null ? s.older : null),
      is_post: s.post,
    };
  };

  // 7. Layouts: pages, index pages, tag pages, the tags page, statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  let compiled = null;
  try {
    compiled = compileTemplates(templates);
  } catch (e) {
    compiled = null;
  }
  // One base frame per case; each render hangs its own page/posts/pager/tag
  // off it, so the shared site/tags/recent are not re-copied per render.
  const baseFrame = Object.create(null);
  baseFrame.site = site;
  baseFrame.tags = allTags;
  baseFrame.recent = recent;
  const render = (name, vars) => {
    if (compiled !== null) {
      const frame = Object.create(baseFrame);
      Object.assign(frame, vars);
      const fn = compiled[name];
      if (fn === undefined) return null;
      const out = [];
      fn(frame, 0, out, compiled);
      return out.join('');
    }
    // Tree-walk fallback: its lookup reads own properties only, so the
    // frame must hold site/tags/recent itself, not on a prototype.
    const frame = Object.create(null);
    frame.site = site;
    frame.tags = allTags;
    frame.recent = recent;
    Object.assign(frame, vars);
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: frame, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(cmp);
  let nPages = 0;
  for (const s of kept) if (!s.post) nPages++;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
