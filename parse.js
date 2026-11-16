// Fast marked-18.1.3-compatible renderer (dependency-free, Node 22).
// Single pass: the block parser collects link reference definitions AND builds
// the HTML structure, with inline content deferred as placeholders (rendered
// below, once every definition in the document is known — so forward
// references resolve without a second block pass). The old two-pass path is
// kept only as a fallback when the input contains a NUL byte, which would
// collide with the placeholder marker.
const INLINE_PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;

export function parse(md) {
  if (md === "") return "";
  let s = md.replace(/\r\n?/g, "\n");
  const endsNL = s.endsWith("\n");
  let lines = s.split("\n");
  if (endsNL) lines.pop();
  const refs = new Map();
  refs.inAnchor = false;
  // NUL byte in input would collide with the placeholder marker: fall back
  // to the two-pass path (never seen in practice).
  if (s.indexOf("\u0000") >= 0) {
    parseBlocks(lines, 0, lines.length, refs, endsNL, false, true);
    refs.inAnchor = false;
    return parseBlocks(lines, 0, lines.length, refs, endsNL, false, false);
  }
  refs.jobs = [];
  const out = parseBlocks(lines, 0, lines.length, refs, endsNL, false, false);
  if (refs.jobs.length === 0) return out;
  // render the deferred inline jobs in document order, threading the
  // document-wide anchor state (an unclosed <a> in one paragraph suppresses
  // autolinks in the next) through them
  const rendered = new Array(refs.jobs.length);
  let inAnchor = false;
  for (let k = 0; k < refs.jobs.length; k++) {
    rendered[k] = parseInline(refs.jobs[k], refs, inAnchor);
    inAnchor = refs.inAnchor;
  }
  return out.replace(INLINE_PLACEHOLDER_RE, (m, idx) => rendered[+idx]);
}

// line is a block that can interrupt a paragraph (loose fence, ATX, html 1-6, quote, list, thematic)
// an empty list marker cannot interrupt, and an ordered list only interrupts when it starts with 1
function isInterruptLine(line, ind) {
  if (matchAtx(line, ind)) return true;
  if (fenceLoose(line, ind)) return true;
  const h = htmlBlockKind(line, ind);
  if (h && h.kind !== 7) return true;
  if (matchThematic(line, ind)) return true;
  let i = ind;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i - ind <= 3 && line.charCodeAt(i) === 62) return true;
  const lm = matchListMarker(line, ind);
  if (lm) {
    if (lm.empty) return false;
    if (lm.type === "ordered" && lm.num !== 1) return false;
    return true;
  }
  return false;
}

function parseBlocks(lines, start, end, refs, endsNL, tight, defsOnly, inList, inQuote) {
  let out = "";
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    // first non-whitespace char index + indent columns in one scan
    let ind = 0, fi = 0;
    while (fi < line.length) {
      const c = line.charCodeAt(fi);
      if (c === 32) { ind++; fi++; }
      else if (c === 9) { ind += 4 - (ind % 4); fi++; }
      else break;
    }
    const fc = line.charCodeAt(fi);
    // a letter-start line with indent < 4 can only be a paragraph (not ATX,
    // thematic, fence, HTML, quote or list) — skip the matcher calls
    if (ind < 4 && ((fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122))) {
      const res = collectParagraph(lines, i, end, refs, endsNL, tight, defsOnly, inList);
      out += res.html;
      i = res.next;
      continue;
    }
    // ATX heading
    const atx = matchAtx(line, 0);
    if (atx) {
      out += "<h" + atx.level + ">" + deferInline(atx.text, refs) + "</h" + atx.level + ">\n";
      i++;
      continue;
    }
    // thematic break
    if (matchThematic(line, 0)) { out += "<hr>\n"; i++; continue; }
    // fenced code (strict)
    const fence = matchFenceStrict(line, 0);
    if (fence) {
      let j = i + 1, content = [];
      while (j < end) {
        if (isClosingFence(lines[j], fence)) break;
        // a tilde fence parsed directly at blockquote level keeps its content
        // indentation (doc-22 ~~~typescript, doc-29 ~~~objective-c); a
        // backtick fence strips its indent, and a fence inside a list item
        // strips normally (its indent is already relative to the item)
        if (!defsOnly) {
          const stripN = (inQuote && fence.char === "~") ? 0 : fence.indent;
          content.push(stripChars(lines[j], stripN));
        }
        j++;
      }
      if (!defsOnly) {
        let text = content.join("\n");
        if (text.length > 0 && !text.endsWith("\n")) text += "\n";
        let lang = "";
        const info = unescapeBackslash(fence.info).trim();
        if (info.length > 0) lang = info.split(/\s+/)[0];
        out += "<pre><code" + (lang ? ' class="language-' + attrEscape(lang) + '"' : "") + ">" + escapeHtml(text) + "</code></pre>\n";
      }
      i = j < end ? j + 1 : j;
      continue;
    }
    // indented code
    if (ind >= 4) {
      let content = [], j = i;
      while (j < end) {
        const l = lines[j];
        if (isBlank(l)) {
          // keep only if a later indented line follows
          let k = j + 1;
          while (k < end && isBlank(lines[k])) k++;
          if (k < end && indentCols(lines[k]) >= 4) {
            if (!defsOnly) for (let b = j; b < k; b++) content.push(stripCols(lines[b], 4));
            j = k;
            continue;
          }
          break;
        }
        if (indentCols(l) < 4) break;
        if (!defsOnly) content.push(stripCols(l, 4));
        j++;
      }
      if (!defsOnly) {
        let text = content.join("\n");
        if (text.length > 0) text += "\n";
        out += "<pre><code>" + escapeHtml(text) + "</code></pre>\n";
      }
      i = j;
      continue;
    }
    // HTML block
    const hb = htmlBlockKind(line, 0);
    if (hb) {
      let j, text;
      if (hb.kind === 6 || hb.kind === 7) {
        // kinds 6-7 continue until a blank line
        const parts = [];
        j = i;
        while (j < end && !isBlank(lines[j])) { if (!defsOnly) parts.push(lines[j]); j++; }
        if (!defsOnly) text = parts.join("\n");
      } else {
        // kinds 1-5: end only at the matching end marker (a blank line never ends them)
        const parts = [line];
        j = i + 1;
        let done = htmlBlockEnd(line, hb.kind, hb.tag);
        while (!done && j < end) {
          const l = lines[j];
          if (!defsOnly) parts.push(l);
          j++;
          if (htmlBlockEnd(l, hb.kind, hb.tag)) done = true;
        }
        if (!defsOnly) text = parts.join("\n");
      }
      if (!defsOnly) {
        // trailing newline: next line is a separator (kind-specific) or last line + endsNL
        const isSep = (idx) => {
          if (idx >= end) return false;
          if (hb.kind === 6 || hb.kind === 7) return isBlank(lines[idx]);
          return lines[idx] === "";
        };
        if ((j < end && !isSep(j)) || (j >= end && endsNL)) text += "\n";
        out += text;
      }
      i = j;
      continue;
    }
    // blockquote
    if (line.charCodeAt(0) === 62 || (ind <= 3 && line.slice(ind, ind + 1) === ">")) {
      const res = collectQuote(lines, i, end, defsOnly);
      // the inner trailing-newline rule only sees the doc end when the quote is at the end
      const innerEndsNL = res.next >= end ? endsNL : false;
      out += "<blockquote>\n" + parseBlocks(res.lines, 0, res.lines.length, refs, innerEndsNL, false, defsOnly, inList, true) + "</blockquote>\n";
      i = res.next;
      continue;
    }
    // list
    const lm = matchListMarker(line, 0);
    if (lm) {
      const res = collectList(lines, i, end, refs, endsNL, defsOnly);
      out += res.html;
      i = res.next;
      continue;
    }
    // paragraph (with setext / table / link-ref-def handling)
    const res = collectParagraph(lines, i, end, refs, endsNL, tight, defsOnly, inList);
    out += res.html;
    i = res.next;
  }
  return defsOnly ? "" : out;
}


function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// columns of leading whitespace (tab = to next multiple of 4)
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// strip up to n COLUMNS from line start, counting every char (tab = to next multiple of 4)
function stripFirstCols(line, cols) {
  let col = 0, i = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else { return " ".repeat(col + w - cols) + line.slice(i + 1); }
    } else { col++; i++; }
  }
  return line.slice(i);
}

// expand the leading-whitespace tabs of a line to spaces, using the doc column
// where the line starts (tabs are column-based; a tab that survived a strip has
// lost its doc alignment unless re-expanded from its true start column)
function expandLeadingTabs(line, startCol) {
  // fast path: no tab anywhere → leading whitespace is all spaces, unchanged
  if (line.indexOf("\t") < 0) return line;
  let col = startCol, i = 0, out = "";
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { out += " "; col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); out += " ".repeat(w); col += w; i++; }
    else break;
  }
  return out + line.slice(i);
}

function stripCols(line, cols) {
  let col = 0, i = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else { return " ".repeat(col + w - cols) + line.slice(i + 1); }
    } else break;
  }
  return line.slice(i);
}

// strip up to n leading whitespace CHARACTERS (tab counts as 1)
function stripChars(line, n) {
  let i = 0;
  while (i < line.length && i < n) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return line.slice(i);
}

function escapeHtml(s) {
  // fast path: nothing to escape (the common case for plain text)
  if (s.indexOf("&") < 0 && s.indexOf("<") < 0 && s.indexOf(">") < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = "", last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = "&amp;";
    else if (c === 60) rep = "&lt;";
    else if (c === 62) rep = "&gt;";
    else if (c === 34) rep = "&quot;";
    else if (c === 39) rep = "&#39;";
    if (rep) { out += s.slice(last, i) + rep; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

function unescapeBackslash(s) {
  if (s.indexOf("\\") < 0) return s;
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, "$1");
}

// ATX: returns {level, text} or null
function matchAtx(line, ind) {
  let i = ind;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i - ind > 3) return null;
  let j = i, level = 0;
  while (j < line.length && line.charCodeAt(j) === 35 && level < 7) { level++; j++; }
  if (level === 0 || level > 6) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  let text = line.slice(j);
  text = text.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  // closing hash sequence preceded by a space
  const m = text.match(/^(.*?)[ \t]+#+[ \t]*$/);
  if (m) text = m[1].replace(/[ \t]+$/, "");
  if (/^#+$/.test(text)) text = "";
  return { level, text };
}

function matchSetext(line, ind) {
  let i = ind;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i - ind > 3) return 0;
  const c = line.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  // a contiguous run of the marker char, then only trailing spaces/tabs
  let j = i;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  if (j === i) return 0;
  while (j < line.length) {
    const d = line.charCodeAt(j);
    if (d !== 32 && d !== 9) return 0;
    j++;
  }
  return c === 61 ? 1 : 2;
}

function matchThematic(line, ind) {
  let i = ind;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i - ind > 3) return false;
  const c = line.charCodeAt(i);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let count = 0;
  for (let j = i; j < line.length; j++) {
    const d = line.charCodeAt(j);
    if (d === c) count++;
    else if (d !== 32 && d !== 9) return false;
  }
  return count >= 3;
}

// strict fence test: {char, len, info, indent} or null
function matchFenceStrict(line, ind) {
  let i = ind;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i - ind > 3) return null;
  const c = line.charCodeAt(i);
  if (c !== 96 && c !== 126) return null;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = line.slice(j);
  if (c === 96 && info.indexOf("`") >= 0) return null;
  return { char: String.fromCharCode(c), len, info, indent: i - ind };
}

// loose fence test (paragraph interruption only): a ``` fence whose info
// contains a backtick is NOT a fence at all (doc-05: "```inner backticks```"
// must not interrupt a paragraph; matchFenceStrict already rejects it)
function fenceLoose(line, ind) {
  let i = ind;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i - ind > 3) return false;
  const c = line.charCodeAt(i);
  if (c !== 96 && c !== 126) return false;
  let n = 0;
  while (i < line.length && line.charCodeAt(i) === c) { n++; i++; }
  if (n < 3) return false;
  if (c === 96 && line.slice(i).indexOf("`") >= 0) return false;
  return true;
}

function isClosingFence(line, f) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return false;
  const c = line.charCodeAt(i);
  if (c !== f.char.charCodeAt(0)) return false;
  let n = 0;
  while (i < line.length && line.charCodeAt(i) === c) { n++; i++; }
  if (n < f.len) return false;
  while (i < line.length) {
    if (line.charCodeAt(i) !== 32) return false;
    i++;
  }
  return true;
}

const BLOCK_TAGS = new Set(("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul").split(" "));
const HTML1_TAGS = new Set(["pre", "script", "style", "textarea"]);

// HTML block kind at line (0 = none, 1..7). Returns {kind, tag}
function htmlBlockKind(line, ind) {
  let i = ind;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i - ind > 3 || line.charCodeAt(i) !== 60) return null;
  const rest = line.slice(i + 1);
  // closing tag of a block-level element: kind 6 (continues until a blank line)
  if (rest.charCodeAt(0) === 47) {
    const m = rest.slice(1).match(/^([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/);
    if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { kind: 6, tag: m[1].toLowerCase() };
  }
  const m = rest.match(/^([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/);
  if (m) {
    const tag = m[1].toLowerCase();
    if (HTML1_TAGS.has(tag)) return { kind: 1, tag };
    if (BLOCK_TAGS.has(tag)) return { kind: 6, tag };
  }
  if (rest.startsWith("!--")) return { kind: 2 };
  if (rest.startsWith("?")) return { kind: 3 };
  if (rest.startsWith("!") && /^[A-Za-z]/.test(rest.slice(1))) return { kind: 4 };
  if (rest.startsWith("![CDATA[")) return { kind: 5 };
  // kind 7: complete open or closing tag alone on the line (validated
  // strictly, like an inline tag, not by a loose regex)
  {
    const tag = scanHtmlTag(line, i);
    if (tag && (tag.kind === "open" || tag.kind === "close")) {
      let e = tag.end;
      while (e < line.length && (line.charCodeAt(e) === 32 || line.charCodeAt(e) === 9)) e++;
      if (e >= line.length) return { kind: 7 };
    }
  }
  return null;
}

function htmlBlockEnd(line, kind, tag) {
  if (kind === 1) return new RegExp("</" + tag + "\\s*>", "i").test(line);
  if (kind === 2) return line.indexOf("-->") >= 0;
  if (kind === 3) return line.indexOf("?>") >= 0;
  if (kind === 4) return line.indexOf(">") >= 0;
  if (kind === 5) return line.indexOf("]]>") >= 0;
  return false;
}

function matchListMarker(line, ind) {
  let i = ind;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  const mind = i - ind;
  if (mind > 3) return null;
  if (matchThematic(line, ind)) return null;
  const c = line.charCodeAt(i);
  if (c === 42 || c === 45 || c === 43) {
    const after = line.charCodeAt(i + 1);
    if (after !== 32 && after !== 9 && i + 1 !== line.length) return null;
    let sp = 0, j = i + 1;
    while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) { sp++; j++; }
    const empty = j >= line.length;
    // content indent: marker indent + width + whitespace columns (1-4); 5+ means 1
    let col = mind + 1;
    for (let k = i + 1; k < j; k++) {
      if (line.charCodeAt(k) === 9) col += 4 - (col % 4);
      else col++;
    }
    const wsCols = col - (mind + 1);
    const contentIndent = empty ? mind + 2 : (wsCols >= 1 && wsCols <= 4 ? mind + 1 + wsCols : mind + 2);
    return { type: "bullet", bullet: String.fromCharCode(c), width: 1, contentIndent, empty, markerIndent: mind };
  }
  if (c >= 48 && c <= 57) {
    let j = i;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57 && j - i < 9) j++;
    if (j - i > 9 || j - i === 0) return null;
    const d = line.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    const after = line.charCodeAt(j + 1);
    if (after !== 32 && after !== 9 && j + 1 !== line.length) return null;
    let sp = 0, k = j + 1;
    while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) { sp++; k++; }
    const empty = k >= line.length;
    const width = (j - i) + 1;
    let col = mind + width;
    for (let q = j + 1; q < k; q++) {
      if (line.charCodeAt(q) === 9) col += 4 - (col % 4);
      else col++;
    }
    const wsCols = col - (mind + width);
    const contentIndent = empty ? mind + width + 1 : (wsCols >= 1 && wsCols <= 4 ? mind + width + wsCols : mind + width + 1);
    return { type: "ordered", num: parseInt(line.slice(i, j), 10), delim: String.fromCharCode(d), width, contentIndent, empty, markerIndent: mind };
  }
  return null;
}

function sameMarker(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "bullet") return a.bullet === b.bullet;
  return a.delim === b.delim;
}

// strip nested blockquote markers (each preceded by <=3 spaces, followed by <=1 space)
function stripQuoteMarkers(line) {
  let s = line;
  while (true) {
    let k = 0;
    while (k < s.length && s.charCodeAt(k) === 32) k++;
    if (k > 3 || s.charCodeAt(k) !== 62) return s;
    s = s.slice(k + 1);
    if (s.charCodeAt(0) === 32) s = s.slice(1);
  }
}

// innermost content of a line: strip quote markers and list markers repeatedly
function coreOf(line) {
  let s = line;
  while (true) {
    s = stripQuoteMarkers(s);
    const lm = matchListMarker(s, 0);
    if (!lm) return s;
    s = stripFirstCols(s, lm.contentIndent);
    if (s === "") return "";
  }
}

// paragraph open inside a collected container: the deepest open block is a paragraph
// (forward scan on the innermost core of each line)
function paraOpenIn(collected) {
  let inPara = false, inFence = null;
  for (let k = 0; k < collected.length; k++) {
    const l = coreOf(collected[k]);
    if (inFence) { if (isClosingFence(l, inFence)) inFence = null; continue; }
    if (isBlank(l)) { inPara = false; continue; }
    if (matchAtx(l, 0) || matchThematic(l, 0) || fenceLoose(l, 0)) { inPara = false; continue; }
    const h = htmlBlockKind(l, 0);
    if (h && h.kind !== 7) { inPara = false; continue; }
    if (indentCols(l) >= 4 && !inPara) { inPara = false; continue; }
    if (matchListMarker(l, 0)) { inPara = false; continue; }
    const f = matchFenceStrict(l, 0);
    if (f) { inFence = f; inPara = false; continue; }
    inPara = true;
  }
  return inPara;
}

function collectQuote(lines, i, end, defsOnly) {
  const out = [];
  let j = i, inFence = null, fenceDepth = 0, prevLazy = false;
  while (j < end) {
    const line = lines[j];
    let k = 0;
    while (k < line.length && line.charCodeAt(k) === 32) k++;
    if (k <= 3 && line.charCodeAt(k) === 62) {
      // marker line: strip marker (k spaces + >) + 1 optional whitespace column
      let stripN = k + 1;
      const after = line.charCodeAt(k + 1);
      if (after === 32 || after === 9) stripN = k + 2;
      let rest = stripFirstCols(line, stripN);
      // expand leading tabs from their true doc column even inside a fence:
      // a tab in fenced-code content is expanded to spaces by tab stops
      // (doc-17: "> \tindented" in a ~~~~~console fence -> 2 spaces)
      rest = expandLeadingTabs(rest, stripN);
      // a spaces-only rest from a marker line is paragraph content, not a blank line
      if (rest.length > 0 && isBlank(rest) && paraOpenIn(out)) {
        out[out.length - 1] += "\n" + rest;
        prevLazy = false;
      } else {
        out.push(rest);
        prevLazy = false;
      }
      // fence tracking: count fences opened inside a nested quote container too.
      // A fence opened at nesting depth D is closed when a marker line arrives
      // with depth < D (its container ended, e.g. doc-21 line 175 `> request`
      // ends the inner `> >` quote that held the ```rust fence).
      let inner = rest, depth = 1;
      while (true) {
        let k2 = 0;
        while (k2 < inner.length && inner.charCodeAt(k2) === 32) k2++;
        if (k2 <= 3 && inner.charCodeAt(k2) === 62) {
          inner = inner.slice(k2 + 1);
          if (inner.charCodeAt(0) === 32) inner = inner.slice(1);
          depth++;
        } else break;
      }
      if (inFence) {
        if (depth < fenceDepth || isClosingFence(inner, inFence)) inFence = null;
      } else { const f2 = matchFenceStrict(inner, 0); if (f2) { inFence = f2; fenceDepth = depth; } }
      j++;
      continue;
    }
    if (isBlank(line)) {
      // a blank line without a marker ends the quote
      break;
    }
    // lazy line (a thematic break does not continue the quote): merge into the
    // previous line so the re-parse treats it as paragraph text
    if (!inFence && paraOpenIn(out) && !isInterruptLine(line, 0)) {
      let l = line;
      const ic = indentCols(l);
      if (ic >= 4) l = stripCols(l, 4);
      if (prevLazy && matchSetext(l, 0)) l = "    " + l;
      out[out.length - 1] += "\n" + l;
      prevLazy = true;
      j++;
      continue;
    }
    break;
  }
  return { lines: out, next: j };
}

function collectList(lines, i, end, refs, endsNL, defsOnly) {
  const first = matchListMarker(lines[i], 0);
  const ordered = first.type === "ordered";
  const startNum = ordered ? first.num : 0;
  const items = [];
  const itemEnds = [];
  let loose = false;
  let j = i;
  let lastContentIndent = first.contentIndent;
  while (j < end) {
    const lm = matchListMarker(lines[j], 0);
    if (!lm || !sameMarker(lm, first)) break;
    if (lm.markerIndent >= lastContentIndent && items.length > 0) break;
    const ci = lm.contentIndent;
    lastContentIndent = ci;
    const itemLines = [];
    // first line content: strip the marker + following space (marker chars count as columns)
    const firstLine = expandLeadingTabs(stripFirstCols(lines[j], ci), ci);
    itemLines.push(firstLine);
    // hasContent is tracked incrementally (a scan over itemLines per blank line is O(n^2))
    let hasContent = !isBlank(firstLine);
    j++;
    let paraOpen = !isBlank(firstLine) && !matchAtx(firstLine, 0) && !matchThematic(firstLine, 0) && !fenceLoose(firstLine, 0);
    let inFence = matchFenceStrict(firstLine, 0);
    let fenceContent = false;
    let blanks = 0;
    while (j < end) {
      const l = lines[j];
      if (isBlank(l)) {
        // an empty item followed by a blank line is done; later content is outside
        if (!hasContent) break;
        itemLines.push(""); blanks++; paraOpen = false; j++; continue;
      }
      const nm = matchListMarker(l, 0);
      if (nm && nm.markerIndent < ci) break;
      const ic = indentCols(l);
      if (ic >= ci) {
        // expand leading tabs from the true column too: a tab in fenced code
        // expands by its original column (doc-01: 5 spaces + tab -> 3 spaces),
        // and stripCols alone leaves the tab literal
        const s = expandLeadingTabs(stripCols(l, ci), ci);
        itemLines.push(s);
        if (!isBlank(s)) hasContent = true;
        blanks = 0;
        if (!isBlank(s)) {
          if (inFence) { if (isClosingFence(s, inFence)) { inFence = null; fenceContent = false; } else fenceContent = true; }
          else { const f = matchFenceStrict(s, 0); if (f) { inFence = f; fenceContent = false; } }
          paraOpen = !matchAtx(s, 0) && !matchThematic(s, 0) && !fenceLoose(s, 0) && !inFence;
        }
        j++;
        continue;
      }
      // inside a fenced code block, an unindented content line belongs to the
      // fence only once the fence already holds content (doc-02/05: a column-0
      // line after indented content lines is swallowed; doc-13/17: a column-0
      // line as the FIRST content line breaks out of the list item, leaving
      // an EMPTY fence and the line as a top-level block). Breaking here in
      // doc-02 would orphan the closing fence into a new block that swallows
      // the rest of the document, including link reference definitions
      if (inFence && fenceContent) {
        itemLines.push(l);
        hasContent = true;
        blanks = 0;
        if (isClosingFence(l, inFence)) { inFence = null; fenceContent = false; }
        j++;
        continue;
      }
      // lazy continuation: merge into the previous line so the re-parse treats
      // it as paragraph text (a stripped list marker must not start a new list)
      if (paraOpen && !isInterruptLine(l, 0)) {
        let ll = l;
        if (indentCols(ll) >= 4) ll = stripCols(ll, 4);
        itemLines[itemLines.length - 1] += "\n" + ll;
        blanks = 0;
        j++;
        continue;
      }
      break;
    }
    // trim trailing blanks; they belong to outer level for the last item
    let trim = 0;
    while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1])) { itemLines.pop(); trim++; }
    const itemBlankSeparated = blanks > 0 && trim === 0;
    // looseness within item: blank line separating two top-level blocks
    // (rendering only — skipped in the defs pass, where only the item
    // boundaries and the recursive def collection matter)
    let innerLoose = false;
    if (!defsOnly) {
      let seenText = false, f2 = null;
      const isCodeLine = (l) => indentCols(l) >= 4 && !matchAtx(l, 0) && !matchThematic(l, 0) && !fenceLoose(l, 0);
      for (let k = 0; k < itemLines.length; k++) {
        const l = itemLines[k];
        if (f2) { if (isClosingFence(l, f2)) f2 = null; continue; }
        if (isBlank(l)) {
          if (seenText) {
            // find the previous and next non-blank lines
            let prev = null, next = null;
            for (let m = k - 1; m >= 0; m--) { if (!isBlank(itemLines[m])) { prev = itemLines[m]; break; } }
            for (let m = k + 1; m < itemLines.length; m++) { if (!isBlank(itemLines[m])) { next = itemLines[m]; break; } }
            if (prev !== null && next !== null) {
              // a blank between two indented-code lines is inside the code block;
              // a blank before a line inside a sublist (prev is its marker and the
              // next line is indented to the sublist's content) is inside the sublist
              const prevMarker = matchListMarker(prev, 0);
              const bothCode = isCodeLine(prev) && isCodeLine(next);
              const insideSublist = prevMarker !== null && indentCols(next) >= prevMarker.contentIndent;
              // a blank is only a top-level separator (making the list loose) when
              // the next block is a top-level block of this item; a blank before an
              // indented line lives inside a nested sub-list (doc-01: blank before
              // an indented "* [x]" item) and must not loosen the outer list
              const nextMarker = matchListMarker(next, 0);
              const nextIndent = indentCols(next);
              const nextIsTopLevel = nextMarker ? nextIndent === 0 : (isCodeLine(next) || nextIndent === 0);
              // a blank before a list marker that continues an already-open
              // sub-list of the same kind is inside that sub-list (doc-03:
              // blank before "+ More" when a "+" list already started and the
              // previous line is indented inside it) — not a top-level break
              let continuesSublist = false;
              if (nextMarker && nextIndent === 0 && prev && indentCols(prev) > 0) {
                for (let m = k - 1; m >= 0; m--) {
                  const ml = itemLines[m];
                  if (isBlank(ml)) continue;
                  if (indentCols(ml) === 0 && !matchListMarker(ml, 0)) break; // top-level text: sub-list ended
                  const mm = matchListMarker(ml, 0);
                  if (mm && mm.type === nextMarker.type && (mm.type !== "bullet" || mm.bullet === nextMarker.bullet)) {
                    continuesSublist = true;
                    break;
                  }
                  // indented line or different marker: keep scanning back
                }
              }
              // a blank between two markers of the same sub-list (prev and
              // next are the same kind) is inside that sub-list, not a
              // top-level break (doc-04: blank between "1)" and "2)" inside
              // an ordered sub-list must not loosen the outer "+" list)
              const sameSublist = prevMarker !== null && nextMarker !== null && sameMarker(prevMarker, nextMarker);
              if (nextIsTopLevel && !bothCode && !insideSublist && !continuesSublist && !sameSublist) innerLoose = true;
            }
          }
          continue;
        }
        seenText = true;
        const f = matchFenceStrict(l, 0);
        if (f) f2 = f;
      }
    }
    if (innerLoose) loose = true;
    items.push(itemLines);
    itemEnds.push(j);
    // blank lines between items: skip, list continues if sibling follows
    let b = j;
    while (b < end && isBlank(lines[b])) b++;
    if (b < end) {
      const nm = matchListMarker(lines[b], 0);
      if (nm && sameMarker(nm, first) && nm.markerIndent < lastContentIndent) {
        // trailing blanks separate the items only when the item had content
        if (b > j || (trim > 0 && itemLines.length > 0)) loose = true;
        j = b;
        continue;
      }
    }
    // list ends; trailing blanks belong to outer level
    j = j; // j already points at first trailing blank (or end)
    break;
  }
  // render
  let html = ordered ? "<ol" + (startNum !== 1 ? ' start="' + startNum + '"' : "") + ">\n" : "<ul>\n";
  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    // the inner trailing-newline rule only sees the doc end when the item is at the end
    const ie = itemEnds[ii];
    const itemEndsNL = ie >= end ? endsNL : false;
    // task list checkbox on first line
    if (it.length > 0) {
      const m = it[0].match(/^\[([ xX])\][ \t]/);
      if (m) {
        it[0] = (m[1] === " " ? '<input disabled="" type="checkbox"> ' : '<input checked="" disabled="" type="checkbox"> ') + it[0].slice(m[0].length);
      }
    }
    // in the defs pass the item's blocks still need parsing (defs inside
    // items) but the <li> string is discarded, so don't build it
    if (defsOnly) {
      parseBlocks(it, 0, it.length, refs, itemEndsNL, !loose, defsOnly, true);
    } else {
      html += "<li>" + parseBlocks(it, 0, it.length, refs, itemEndsNL, !loose, defsOnly, true) + "</li>\n";
    }
  }
  html += ordered ? "</ol>\n" : "</ul>\n";
  return { html: defsOnly ? "" : html, next: j };
}

function splitTableCells(line) {
  // trim first: a leading | after whitespace still opens the row (the
  // empty cell before it is discarded), and a trailing | likewise
  let s = line.trim();
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 124 && s.charCodeAt(s.length - 2) !== 92) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) { cur += "|"; i++; continue; }
    if (c === 124) { cells.push(cur); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map(x => x.trim());
}

function isDelimiterRow(line) {
  const cells = splitTableCells(line);
  if (cells.length === 0) return null;
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
  }
  return cells.map(c => (c.charCodeAt(0) === 58 ? (c.charCodeAt(c.length - 1) === 58 ? "center" : "left") : (c.charCodeAt(c.length - 1) === 58 ? "right" : "")));
}

function collectParagraph(lines, i, end, refs, endsNL, tight, defsOnly, inList) {
  let j = i;
  const para = [];
  while (j < end) {
    const l = lines[j];
    if (j > i && isBlank(l)) break;
    // a setext underline after paragraph text ends the paragraph (before the
    // interrupt check: --- is also a thematic break) — unless the paragraph
    // so far is entirely link reference definitions (then it is paragraph text)
    if (j > i && para.length >= 1 && matchSetext(l, 0) > 0) {
      const soFar = para.join("\n");
      if (parseDefs(soFar, new Map()).rest === "") { para.push(l); j++; continue; }
      para.push(l); j++; break;
    }
    if (j > i && isInterruptLine(l, 0)) break;
    // inside a list item, a nested ordered list may start a sub-list even
    // when it does not start with 1 (doc-03: 872468. under a bullet item)
    if (j > i && inList) {
      const lm2 = matchListMarker(l, 0);
      if (lm2 && !lm2.empty && lm2.type === "ordered" && lm2.num !== 1) break;
    }
    para.push(l);
    j++;
    // a setext underline ends the paragraph
    if (para.length > 1 && matchSetext(l, 0) > 0) break;
  }
  // link reference definitions from the start
  let text = para.join("\n");
  const defRes = parseDefs(text, refs);
  let rest = defRes.rest;
  let html = "";
  if (rest === "") {
    return { html: "", next: j };
  }
  const restLines = rest.split("\n");
  // table (checked before setext: delimiter row is the second line)
  // exception: a 2-line paragraph whose line 2 is a setext underline is a heading, not a table
  // the delimiter row must be indented at most 3 spaces; it must contain a
  // '-' (cheap pre-filter before the split+regex in isDelimiterRow)
  if (restLines.length >= 2 && indentCols(restLines[1]) <= 3 && restLines[1].indexOf("-") >= 0) {
    const aligns = isDelimiterRow(restLines[1]);
    if (aligns && !(restLines.length === 2 && matchSetext(restLines[1], 0) > 0)) {
      const header = splitTableCells(restLines[0]);
      if (header.length === aligns.length) {
        // greedy body: every following line is a row until a spaces-only blank or a block start
        const rows = restLines.slice(2);
        while (j < end) {
          const l = lines[j];
          if (/^ *$/.test(l)) break; // spaces-only blank ends the body (tab-only line is a row)
          if (matchAtx(l, 0) || matchThematic(l, 0) || fenceLoose(l, 0) || matchListMarker(l, 0) || htmlBlockKind(l, 0)) break;
          let k = 0;
          while (k < l.length && l.charCodeAt(k) === 32) k++;
          if (k <= 3 && l.charCodeAt(k) === 62) break; // blockquote marker
          if (indentCols(l) >= 4 && /\S/.test(l)) break; // indented code start (a whitespace-only line is a row, not code)
          rows.push(l);
          j++;
        }
        html = "<table>\n<thead>\n<tr>\n";
        for (let k = 0; k < header.length; k++) {
          html += "<th" + (aligns[k] ? ' align="' + aligns[k] + '"' : "") + ">" + deferInline(header[k], refs) + "</th>\n";
        }
        html += "</tr>\n</thead>\n";
        if (rows.length > 0) {
          html += "<tbody>";
          for (const r of rows) {
            const cells = splitTableCells(r);
            html += "<tr>\n";
            for (let k = 0; k < header.length; k++) {
              const cell = k < cells.length ? cells[k] : "";
              html += "<td" + (aligns[k] ? ' align="' + aligns[k] + '"' : "") + ">" + deferInline(cell, refs) + "</td>\n";
            }
            html += "</tr>\n";
          }
          html += "</tbody>";
        }
        html += "</table>\n";
        return { html, next: j };
      }
    }
  }
  // setext heading: last line is the underline
  if (restLines.length >= 2) {
    const se = matchSetext(restLines[restLines.length - 1], 0);
    if (se > 0) {
      const t = restLines.slice(0, -1).join("\n").replace(/^[ \t]+|[ \t]+$/g, "");
      html = "<h" + se + ">" + deferInline(t, refs) + "</h" + se + ">\n";
      return { html, next: j };
    }
  }
  const inner = deferInline(rest, refs);
  html = tight ? inner : "<p>" + inner + "</p>\n";
  return { html, next: j };
}

function normLabel(raw) {
  let s = raw;
  // ß/ẞ folding is rare — skip the regex replaces when neither is present
  if (s.indexOf("ß") >= 0 || s.indexOf("\u1E9E") >= 0) {
    s = s.replace(/\u1E9E/g, "ss").replace(/ß/g, "ss");
  }
  s = s.toLowerCase();
  // most labels have no whitespace at all — skip the collapse+trim then
  if (!/\s/.test(s)) return s;
  return s.replace(/\s+/g, " ").trim();
}

function parseDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  let consumed = false;
  while (true) {
    // skip whitespace/newlines
    while (pos < n && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9 || text.charCodeAt(pos) === 10)) pos++;
    if (pos >= n || text.charCodeAt(pos) !== 91) break;
    // label: no unescaped [, ends at first unescaped ]
    let p = pos + 1, label = "", ok = false;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 92 && p + 1 < n) { label += text[p] + text[p + 1]; p += 2; continue; }
      if (c === 91) break;
      if (c === 93) { ok = true; break; }
      label += text[p];
      p++;
    }
    if (!ok) break;
    // an empty (or whitespace-only) label is not a valid definition
    if (normLabel(label) === "") break;
    p++;
    // optional spaces, then :
    let q = p;
    while (q < n && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9)) q++;
    if (q >= n || text.charCodeAt(q) !== 58) break;
    q++;
    // optional whitespace incl newlines, then destination
    while (q < n && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9 || text.charCodeAt(q) === 10)) q++;
    if (q >= n) break;
    let dest = "";
    if (text.charCodeAt(q) === 60) {
      let r = q + 1;
      while (r < n && text.charCodeAt(r) !== 62 && text.charCodeAt(r) !== 10) { dest += text[r]; r++; }
      if (r >= n || text.charCodeAt(r) !== 62) break;
      q = r + 1;
    } else {
      let r = q;
      while (r < n) {
        const c = text.charCodeAt(r);
        if (c === 32 || c === 9 || c === 10) break;
        if (c === 92 && r + 1 < n && isAsciiPunct(text.charCodeAt(r + 1))) { dest += text[r + 1]; r += 2; continue; }
        dest += text[r];
        r++;
      }
      if (dest === "") break;
      q = r;
    }
    // optional title: must be preceded by >=1 whitespace (space/tab/newline),
    // may start on the next line, but not across a blank line
    let title = null, titleEnd = q, defBad = false;
    let w = q, wsCount = 0, crossedNL = false;
    while (w < n) {
      const c = text.charCodeAt(w);
      if (c === 32 || c === 9) { w++; wsCount++; continue; }
      if (c === 10) {
        let w2 = w + 1;
        while (w2 < n && (text.charCodeAt(w2) === 32 || text.charCodeAt(w2) === 9)) w2++;
        if (w2 >= n || text.charCodeAt(w2) === 10) break; // blank line or EOF: no title
        w = w2; wsCount++; crossedNL = true; continue;
      }
      break;
    }
    if (w < n) {
      const tc = text.charCodeAt(w);
      if (tc === 10) {
        // newline after destination: definition ends here, valid
      } else if (tc === 34 || tc === 39 || tc === 40) {
        if (wsCount === 0) { defBad = true; }
        else {
          const close = tc === 40 ? 41 : tc;
          let s2 = w + 1, t = "";
          let closed = false;
          while (s2 < n) {
            const c = text.charCodeAt(s2);
            if (c === 92 && s2 + 1 < n && isAsciiPunct(text.charCodeAt(s2 + 1))) { t += text[s2 + 1]; s2 += 2; continue; }
            if (c === close) { closed = true; break; }
            if (c === 10) {
              // title may span lines but not blank line
              if (text.charCodeAt(s2 + 1) === 10) break;
            }
            t += text[s2];
            s2++;
          }
          if (closed) {
            // after title, only spaces then EOL/EOF allowed; extra text on the
            // same line invalidates the def, on a later line just drops the title
            let a = s2 + 1;
            while (a < n && (text.charCodeAt(a) === 32 || text.charCodeAt(a) === 9)) a++;
            if (a >= n || text.charCodeAt(a) === 10) {
              title = t;
              titleEnd = s2 + 1;
            } else if (!crossedNL) {
              defBad = true;
            } else {
              titleEnd = q;
            }
          } else if (!crossedNL) {
            defBad = true; // unterminated title on the same line invalidates the def
          } else {
            titleEnd = q; // unterminated title on a later line: drop it, keep the def
          }
        }
      } else if (!crossedNL) {
        // non-title text after the destination on the same line invalidates
        // the definition (doc-40: [lines cache]: v2.1.0 type tests... is not
        // a definition, so [lines cache][] must not link). Text on a later
        // line (crossedNL) is separate content; the definition stands.
        defBad = true;
      }
    }
    if (defBad) break;
    const norm = normLabel(label);
    if (norm !== "" && !refs.has(norm)) {
      refs.set(norm, { dest, title });
    }
    consumed = true;
    pos = titleEnd;
    // continue: more defs may follow
  }
  if (!consumed) return { rest: text };
  // rest = text after last def, with leading blank-line handling
  let rest = text.slice(pos);
  rest = rest.replace(/^\n+/, "");
  return { rest };
}

// ---------- inline parsing ----------
function isSpaceCh(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xA0 || (c >= 0x2000 && c <= 0x200A) || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isPunctCh(ch) {
  if (ch.length === 0) return false;
  const c = ch.codePointAt(0);
  if (isAsciiPunct(c)) return true;
  if (c < 128) return false;
  try { return /[\p{P}\p{S}]/u.test(ch); } catch (e) { return c > 127; }
}
function isWordCh(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
}

// flanking for a delimiter run at [s,e) in text
function flanking(text, s, e) {
  const before = s > 0 ? text[s - 1] : "";
  const after = e < text.length ? text[e] : "";
  const beforeWS = s === 0 || isSpaceCh(before.codePointAt(0) || 32);
  const afterWS = e >= text.length || isSpaceCh(after.codePointAt(0) || 32);
  const beforePunct = s > 0 && isPunctCh(before);
  const afterPunct = e < text.length && isPunctCh(after);
  const leftFlanking = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const rightFlanking = !beforeWS && (!beforePunct || afterWS || afterPunct);
  return { leftFlanking, rightFlanking, beforePunct, afterPunct };
}

function decodeNumericRef(s) {
  // s like #123 or #x1F600
  let cp;
  if (s.charCodeAt(1) === 120 || s.charCodeAt(1) === 88) cp = parseInt(s.slice(2), 16);
  else cp = parseInt(s.slice(1), 10);
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return "\uFFFD";
  return String.fromCodePoint(cp);
}

// process &...; in a raw text fragment: numeric decoded, named verbatim, else &amp;
function processEntities(raw) {
  if (raw.indexOf("&") < 0) return escapeHtml(raw);
  let out = "", i = 0;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c !== 38) { i++; continue; }
    // find ;
    let j = i + 1, ok = false, kind = 0;
    if (raw.charCodeAt(j) === 35) {
      let k = j + 1, hex = false;
      if (raw.charCodeAt(k) === 120 || raw.charCodeAt(k) === 88) { hex = true; k++; }
      let digits = 0;
      if (hex) {
        while (k < raw.length && /[0-9A-Fa-f]/.test(raw[k])) { k++; digits++; }
        if (digits > 0 && digits <= 6 && raw.charCodeAt(k) === 59) { ok = true; kind = 1; j = k; }
      } else {
        while (k < raw.length && /[0-9]/.test(raw[k])) { k++; digits++; }
        if (digits > 0 && digits <= 7 && raw.charCodeAt(k) === 59) { ok = true; kind = 1; j = k; }
      }
    } else {
      let k = j;
      while (k < raw.length && /[A-Za-z0-9]/.test(raw[k])) k++;
      if (k > j && raw.charCodeAt(k) === 59) { ok = true; kind = 2; j = k; }
    }
    if (ok) {
      out += escapeHtml(raw.slice(0, i));
      if (kind === 1) out += escapeHtml(decodeNumericRef(raw.slice(i + 1, j)));
      else out += raw.slice(i, j + 1);
      raw = raw.slice(j + 1);
      i = 0;
    } else {
      i++;
    }
  }
  return out + escapeHtml(raw);
}

function textNode(raw) {
  return { t: "text", s: processEntities(raw) };
}

// clean a link destination (percent-encode, keep valid %XX, lone surrogates -> U+FFFD)
const DEST_KEEP = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'();/?:@&=+$,#[]".split(""));
const DEST_DIRTY_RE = /[^A-Za-z0-9_.!~*'();\/?:@&=+$,#\[\]%-]/;
function cleanDest(dest) {
  // fast path: every char is kept verbatim (incl. %, which marked leaves
  // alone) — no encoding needed, return the string unchanged
  if (!DEST_DIRTY_RE.test(dest)) return dest;
  let out = "";
  for (let i = 0; i < dest.length; i++) {
    const ch = dest[i];
    const c = dest.charCodeAt(i);
    if (c === 37) {
      // marked leaves % alone (valid %XX kept, lone % not encoded)
      out += "%";
      continue;
    }
    if (DEST_KEEP.has(ch)) { out += ch; continue; }
    if (c >= 0xD800 && c <= 0xDBFF) {
      const c2 = dest.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
        const cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out += encodeURIComponent(String.fromCodePoint(cp));
        i++;
      } else {
        out += "%EF%BF%BD";
      }
      continue;
    }
    if (c >= 0xDC00 && c <= 0xDFFF) { out += "%EF%BF%BD"; continue; }
    out += encodeURIComponent(ch);
  }
  return out;
}

// autolink hrefs percent-encode [ and ] (regular link dests keep them)
function cleanAutoHref(dest) {
  return cleanDest(dest).replace(/\[/g, "%5B").replace(/\]/g, "%5D");
}

function attrEscape(s) {
  // fast path: nothing to escape
  if (s.indexOf("&") < 0 && s.indexOf("<") < 0 && s.indexOf(">") < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  // attribute escaping: & passes through when it starts a valid entity reference
  let out = "", i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      let j = i + 1, ok = false;
      if (s.charCodeAt(j) === 35) {
        let k = j + 1;
        if (s.charCodeAt(k) === 120 || s.charCodeAt(k) === 88) k++;
        let d = 0;
        while (k < s.length && /[0-9A-Fa-f]/.test(s[k])) { k++; d++; }
        if (d > 0 && s.charCodeAt(k) === 59) ok = true;
      } else {
        let k = j;
        while (k < s.length && /[A-Za-z0-9]/.test(s[k])) k++;
        if (k > j && s.charCodeAt(k) === 59) ok = true;
      }
      out += ok ? "&" : "&amp;"; i++;
    } else if (c === 60) { out += "&lt;"; i++; }
    else if (c === 62) { out += "&gt;"; i++; }
    else if (c === 34) { out += "&quot;"; i++; }
    else if (c === 39) { out += "&#x27;"; i++; }
    else { out += s[i]; i++; }
  }
  return out;
}

// label backtick rule: every backtick run must pair (code span, lengths need not match)
// or be a run of >=2 immediately before the closing bracket. Returns true if label ok.
function labelBackticksOk(label) {
  let i = 0;
  const n = label.length;
  while (i < n) {
    const c = label.charCodeAt(i);
    if (c === 92 && i + 1 < n) { i += 2; continue; }
    if (c === 91) {
      // skip nested brackets whole
      let depth = 1, j = i + 1;
      while (j < n && depth > 0) {
        if (label.charCodeAt(j) === 92) { j += 2; continue; }
        if (label.charCodeAt(j) === 91) depth++;
        else if (label.charCodeAt(j) === 93) depth--;
        j++;
      }
      i = j;
      continue;
    }
    if (c === 96) {
      let j = i;
      while (j < n && label.charCodeAt(j) === 96) j++;
      const run = j - i;
      // run of >=2 immediately before closing bracket (end of label)
      if (j >= n && run >= 2) return true;
      // find a closing run: next backtick run after non-backtick content
      let k = j;
      while (k < n && label.charCodeAt(k) !== 96) k++;
      if (k >= n) return false;
      let m = k;
      while (m < n && label.charCodeAt(m) === 96) m++;
      // closing run found (lengths need not match)
      i = m;
      continue;
    }
    i++;
  }
  return true;
}

// parse inline destination after ']' at position p (text[p] === '('). Returns {dest, title, end} or null.
function parseInlineDest(text, p) {
  let i = p + 1;
  const n = text.length;
  while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9 || text.charCodeAt(i) === 10)) i++;
  if (i >= n) return null;
  let dest = "";
  if (text.charCodeAt(i) === 60) {
    let j = i + 1;
    while (j < n && text.charCodeAt(j) !== 62 && text.charCodeAt(j) !== 10) {
      // a backslash escapes the next ASCII punctuation, so \> does not close
      if (text.charCodeAt(j) === 92 && j + 1 < n && isAsciiPunct(text.charCodeAt(j + 1))) { dest += text[j + 1]; j += 2; continue; }
      dest += text[j]; j++;
    }
    if (j >= n || text.charCodeAt(j) !== 62) return null;
    i = j + 1;
  } else {
    let depth = 0, j = i;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      if (c === 92 && j + 1 < n && isAsciiPunct(text.charCodeAt(j + 1))) { dest += text[j + 1]; j += 2; continue; }
      dest += text[j];
      j++;
    }
    // an empty destination is valid ([link]() -> href=""); the closing ) check below decides
    i = j;
  }
  // optional title
  let title = null;
  let k = i;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9 || text.charCodeAt(k) === 10)) k++;
  if (k < n) {
    const tc = text.charCodeAt(k);
    if (tc === 34 || tc === 39 || tc === 40) {
      const close = tc === 40 ? 41 : tc;
      let s2 = k + 1, t = "", closed = false;
      while (s2 < n) {
        const c = text.charCodeAt(s2);
        if (c === 92 && s2 + 1 < n && isAsciiPunct(text.charCodeAt(s2 + 1))) { t += text[s2 + 1]; s2 += 2; continue; }
        if (c === close) { closed = true; break; }
        t += text[s2];
        s2++;
      }
      if (closed) {
        let a = s2 + 1;
        while (a < n && (text.charCodeAt(a) === 32 || text.charCodeAt(a) === 9 || text.charCodeAt(a) === 10)) a++;
        if (a < n && text.charCodeAt(a) === 41) { title = t; i = a; }
        else return null;
      } else return null;
    }
  }
  let a = i;
  while (a < n && (text.charCodeAt(a) === 32 || text.charCodeAt(a) === 9 || text.charCodeAt(a) === 10)) a++;
  if (a >= n || text.charCodeAt(a) !== 41) return null;
  return { dest, title, end: a + 1 };
}

// masking-rule link shape (stricter label, looser dest): label has no [ outside code span,
// every backtick run pairs with a later run of same length with no backtick between (after
// neutralising inner backticks); dest allows spaces + one level of balanced parens.
// Returns end position of the destination or -1.
function maskingLinkEnd(text, openPos, closePos) {
  const label = text.slice(openPos + 1, closePos);
  // label: no [ outside code span
  let i = 0, inCode = false, codeLen = 0;
  while (i < label.length) {
    const c = label.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c === 96) {
      let j = i;
      while (j < label.length && label.charCodeAt(j) === 96) j++;
      const run = j - i;
      if (!inCode) { inCode = true; codeLen = run; i = j; continue; }
      if (run === codeLen) { inCode = false; i = j; continue; }
      i = j; continue;
    }
    if (c === 91 && !inCode) return -1;
    i++;
  }
  if (inCode) return -1;
  // every backtick run OUTSIDE a code span pairs up (runs inside a code span
  // are content, neutralised — doc-16: the single ` inside `` a ` b `` must
  // not block masking); each length must appear an even number of times
  const runs = [];
  {
    let k = 0, inCode2 = false, codeLen2 = 0;
    while (k < label.length) {
      if (label.charCodeAt(k) === 96) {
        let j = k;
        while (j < label.length && label.charCodeAt(j) === 96) j++;
        const run = j - k;
        if (!inCode2) { inCode2 = true; codeLen2 = run; runs.push(run); }
        else if (run === codeLen2) { inCode2 = false; runs.push(run); }
        // else: inside a code span, content — skip
        k = j;
      } else k++;
    }
  }
  {
    const counts = new Map();
    for (const r of runs) counts.set(r, (counts.get(r) || 0) + 1);
    for (const c of counts.values()) if (c % 2 !== 0) return -1;
  }
  // destination after ]
  let p = closePos + 1;
  if (text.charCodeAt(p) !== 40) return -1;
  let depth = 0, j = p + 1;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) return j + 1;
      depth--;
    } else if (c === 10) return -1;
    j++;
  }
  return -1;
}

// find closing bracket for a bracket at pos (depth-aware, escapes respected); -1 if none
function findCloseBracket(text, pos) {
  let depth = 0, i = pos;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// would the bracket at openPos form a link? (label backtick rule + destination parse)
function wouldFormLink(text, openPos, refs) {
  const img = text.charCodeAt(openPos - 1) === 33;
  const closePos = findCloseBracket(text, openPos);
  if (closePos < 0) return false;
  const label = text.slice(openPos + 1, closePos);
  if (!labelBackticksOk(label)) return false;
  // a link's text may not contain another link: if any inner [ (not an
  // image) would itself form a link, this outer one cannot (doc-12:
  // [author [stream...](URL1)](URL2) — URL2 must autolink instead)
  if (!img) {
    for (let k = openPos + 1; k < closePos; k++) {
      if (text.charCodeAt(k) === 91 && text.charCodeAt(k - 1) !== 33) {
        if (wouldFormLink(text, k, refs)) return false;
      }
    }
  }
  const after = closePos + 1;
  if (text.charCodeAt(after) === 40) {
    return parseInlineDest(text, after) !== null;
  }
  if (text.charCodeAt(after) === 91) {
    const end2 = findCloseBracket(text, after);
    if (end2 < 0) return false;
    const lab2 = end2 === after + 1 ? label : text.slice(after + 1, end2);
    return refs.has(normLabel(lab2));
  }
  return refs.has(normLabel(label));
}

// scan an HTML tag starting at pos (text[pos] === '<'); returns {end, kind, name} or null
function scanHtmlTag(text, pos) {
  const n = text.length;
  if (text.startsWith("<!--", pos)) {
    // empty comments <!--> and <!---> end immediately
    if (text.charCodeAt(pos + 4) === 62) return { end: pos + 5, kind: "comment" };
    if (text.charCodeAt(pos + 4) === 45 && text.charCodeAt(pos + 5) === 62) return { end: pos + 6, kind: "comment" };
    let j = text.indexOf("-->", pos + 4);
    if (j < 0) {
      j = text.indexOf("--!>", pos + 4);
      if (j < 0) return null;
      return { end: j + 4, kind: "comment" };
    }
    return { end: j + 3, kind: "comment" };
  }
  if (text.startsWith("<?", pos)) {
    const j = text.indexOf("?>", pos + 2);
    if (j < 0) return null;
    return { end: j + 2, kind: "pi" };
  }
  if (text.startsWith("<![CDATA[", pos)) {
    const j = text.indexOf("]]>", pos + 9);
    if (j < 0) return null;
    return { end: j + 3, kind: "cdata" };
  }
  if (text.startsWith("<!", pos) && pos + 2 < n && /[A-Za-z]/.test(text[pos + 2])) {
    const j = text.indexOf(">", pos + 2);
    if (j < 0) return null;
    return { end: j + 1, kind: "decl" };
  }
  let i = pos + 1;
  let closing = false;
  if (text.charCodeAt(i) === 47) { closing = true; i++; }
  if (i >= n) return null;
  const nc = text.charCodeAt(i);
  // tag name: must start with a letter, then letters/digits/hyphen only
  if (!((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122))) return null;
  let j = i;
  while (j < n) {
    const c = text.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  const name = text.slice(i, j).toLowerCase();
  if (closing) {
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10)) j++;
    if (j < n && text.charCodeAt(j) === 62) return { end: j + 1, kind: "close", name };
    return null;
  }
  // attributes
  while (j < n) {
    // skip whitespace
    let k = j;
    while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9 || text.charCodeAt(k) === 10)) k++;
    if (k >= n) return null;
    const c = text.charCodeAt(k);
    if (c === 62) return { end: k + 1, kind: "open", name };
    if (c === 47) {
      if (text.charCodeAt(k + 1) === 62) return { end: k + 2, kind: "open", name };
      return null;
    }
    // an attribute name must be preceded by whitespace (not glued to the
    // tag name or the previous attribute)
    if (k === j) return null;
    // attribute name: [A-Za-z_:][A-Za-z0-9_:\.-]*
    const ac = text.charCodeAt(k);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return null;
    let a = k + 1;
    while (a < n) {
      const d = text.charCodeAt(a);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 46 || d === 45) a++;
      else break;
    }
    // after name: must be whitespace, =, /, or >
    if (a < n) {
      const d = text.charCodeAt(a);
      if (d !== 32 && d !== 9 && d !== 10 && d !== 61 && d !== 47 && d !== 62) return null;
    }
    j = a;
    // optional value
    const jAfterName = j;
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10)) j++;
    let hasValue = false;
    if (j < n && text.charCodeAt(j) === 61) {
      hasValue = true;
      j++;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10)) j++;
      if (j >= n) return null;
      const q = text.charCodeAt(j);
      if (q === 34 || q === 39) {
        let v = j + 1;
        while (v < n && text.charCodeAt(v) !== q) v++;
        if (v >= n) return null;
        j = v + 1;
      } else {
        let v = j;
        while (v < n) {
          const d = text.charCodeAt(v);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          v++;
        }
        if (v === j) return null;
        j = v;
      }
    }
    // after a value: must be whitespace, /, or >
    if (hasValue && j < n) {
      const d = text.charCodeAt(j);
      if (d !== 32 && d !== 9 && d !== 10 && d !== 47 && d !== 62) return null;
    }
    if (!hasValue) {
      // valueless attribute: rewind so the loop-top whitespace skip sees
      // the space (otherwise the no-whitespace-before-attribute check
      // would falsely fire on the next attribute)
      j = jAfterName;
    }
  }
  return null;
}

// angle-bracket autolink at pos; returns {end, href, display} or null
function angleAutolink(text, pos) {
  const n = text.length;
  let j = pos + 1;
  // scheme
  let k = j;
  while (k < n) {
    const c = text.charCodeAt(k);
    if (c === 58) break;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) break;
    k++;
  }
  if (k > j + 1 && k < n && text.charCodeAt(k) === 58 && k - j >= 2) {
    let e = k + 1;
    while (e < n && text.charCodeAt(e) !== 62 && text.charCodeAt(e) !== 32 && text.charCodeAt(e) !== 10) e++;
    if (e < n && text.charCodeAt(e) === 62 && e > k + 1) {
      const href = text.slice(j, e);
      return { end: e + 1, href, display: href };
    }
  }
  // email
  let e = j;
  while (e < n && text.charCodeAt(e) !== 62 && text.charCodeAt(e) !== 32 && text.charCodeAt(e) !== 10) e++;
  if (e < n && text.charCodeAt(e) === 62) {
    const cand = text.slice(j, e);
    if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(cand)) {
      return { end: e + 1, href: "mailto:" + cand, display: cand };
    }
  }
  return null;
}

function plainTextOf(nodes) {
  let out = "";
  for (const nd of nodes) {
    if (!nd) continue;
    if (nd.t === "text") out += nd.raw || "";
    else if (nd.t === "code") out += nd.raw || "";
    else if (nd.t === "delim") out += nd.ch.repeat(nd.len);
    else if (nd.t === "link") out += plainTextOf(nd.kids);
    else if (nd.t === "img") out += nd.alt || "";
    else if (nd.t === "br") out += "\n";
    else if (nd.t === "autolink") out += nd.display || "";
    else if (nd.t === "em" || nd.t === "strong" || nd.t === "del") out += plainTextOf(nd.kids);
  }
  return out;
}

// main inline scan: returns {nodes, hidden}
// next inline special char: backslash, newline, backtick, <, [, ], ![, *, _, ~
const INLINE_SPECIAL_RE = /[\\`\n<[\]*_~]|!\[/g;

function scanInline(text, refs, entryInAnchor) {
  if (entryInAnchor === undefined) entryInAnchor = refs.inAnchor;
  const nodes = [];
  const hidden = [];
  const stack = []; // open bracket node indices
  let hasDelim = false; // a * or _ delimiter run was seen
  let hasTilde = false; // a ~ delimiter run was seen
  let textBuf = "", textStart = 0;
  const n = text.length;
  function flush() {
    if (textBuf.length > 0) {
      const nd = textNode(textBuf);
      nd.raw = textBuf;
      nd.a = textStart;
      // b is the end position in the ORIGINAL text (i), not textStart +
      // rendered length: backslash escapes shorten the rendered text
      nd.b = i;
      nodes.push(nd);
      textBuf = "";
    }
  }
  let i = 0;
  while (i < n) {
    // bulk fast path: swallow a run of plain text up to the next special char
    INLINE_SPECIAL_RE.lastIndex = i;
    const sm = INLINE_SPECIAL_RE.exec(text);
    const nxt = sm ? sm.index : n;
    if (nxt > i) {
      if (textBuf.length === 0) textStart = i;
      textBuf += text.slice(i, nxt);
      i = nxt;
      continue;
    }
    const c = text.charCodeAt(i);
    if (c === 92) { // backslash
      const nc = text.charCodeAt(i + 1);
      if (nc === 10) {
        if (textBuf.length > 0) { textBuf = textBuf.replace(/[ \t]+$/, ""); }
        flush();
        nodes.push({ t: "br", a: i, b: i + 2 });
        i += 2;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      if (nc >= 0 && isAsciiPunct(nc)) {
        if (nc === 38) {
          // escaped &: a literal amp, must NOT start an entity
          flush();
          nodes.push({ t: "text", s: "&amp;", raw: "&", a: i, b: i + 2 });
          i += 2;
          textStart = i;
          continue;
        }
        if (textBuf.length === 0) textStart = i;
        textBuf += text[i + 1];
        i += 2;
        continue;
      }
      if (textBuf.length === 0) textStart = i;
      textBuf += "\\";
      i++;
      continue;
    }
    if (c === 10) { // newline: hard break if 2+ trailing spaces
      let sp = 0;
      for (let k = textBuf.length - 1; k >= 0 && (textBuf.charCodeAt(k) === 32 || textBuf.charCodeAt(k) === 9); k--) sp++;
      if (sp >= 2) {
        textBuf = textBuf.slice(0, textBuf.length - sp);
        flush();
        nodes.push({ t: "br", a: i, b: i + 1 });
        i++;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      if (textBuf.length === 0) textStart = i;
      textBuf += "\n";
      i++;
      continue;
    }
    if (c === 96) { // backtick run
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const run = j - i;
      // find global closing run of same length (indexOf jumps to the next
      // backtick instead of stepping char by char)
      let close = -1, closeEnd = -1;
      let k = j;
      while (k < n) {
        k = text.indexOf("`", k);
        if (k < 0) break;
        let m = k;
        while (m < n && text.charCodeAt(m) === 96) m++;
        if (m - k === run) { close = k; closeEnd = m; break; }
        k = m;
      }
      // enclosing bracket that would form a link?
      let blockedBy = -1;
      if (close >= 0 && stack.length > 0) {
        for (let s = stack.length - 1; s >= 0; s--) {
          const bi = stack[s];
          const bnode = nodes[bi];
          if (!bnode || bnode.t !== "bracket") continue;
          const cpos = findCloseBracket(text, bnode.pos);
          if (cpos >= 0 && close > cpos && wouldFormLink(text, bnode.pos, refs)) { blockedBy = cpos; break; }
        }
      }
      if (close >= 0 && blockedBy < 0) {
        // form code span (also record hidden if a bracket sits between runs)
        if (stack.length > 0) {
          for (let s = stack.length - 1; s >= 0; s--) {
            const bnode = nodes[stack[s]];
            if (bnode && bnode.pos > i && bnode.pos < close) { hidden.push([i, closeEnd]); break; }
          }
        }
        let content = text.slice(j, close);
        if (content.indexOf("\n") >= 0) content = content.replace(/\n/g, " ");
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flush();
        nodes.push({ t: "code", s: escapeHtml(content), raw: content, a: i, b: closeEnd });
        i = closeEnd;
        continue;
      }
      if (close >= 0 && blockedBy >= 0) {
        // global pairing exists past a forming bracket: literal run, hide whole span
        hidden.push([i, closeEnd]);
        if (textBuf.length === 0) textStart = i;
        textBuf += text.slice(i, j);
        i = j;
        continue;
      }
      if (textBuf.length === 0) textStart = i;
      textBuf += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === 60) { // < angle autolink or html tag
      const aa = angleAutolink(text, i);
      if (aa) {
        flush();
        nodes.push({ t: "autolink", href: cleanAutoHref(aa.href), display: aa.display, a: i, b: aa.end });
        i = aa.end;
        continue;
      }
      const tag = scanHtmlTag(text, i);
      if (tag) {
        flush();
        const raw = text.slice(i, tag.end);
        nodes.push({ t: "html", s: raw, a: i, b: tag.end });
        // anchor state (marked: startATag /^<a /i, endATag /^<\/a>/i —
        // a tab or newline after <a does NOT open an anchor, </A> closes one)
        if (tag.kind === "open" && tag.name === "a") {
          const afterName = text.slice(i + 2, tag.end);
          if (/^ /.test(afterName)) refs.inAnchor = true;
        } else if (tag.kind === "close" && tag.name === "a") {
          if (/^<\/a>/i.test(raw)) refs.inAnchor = false;
        }
        i = tag.end;
        continue;
      }
      if (textBuf.length === 0) textStart = i;
      textBuf += "<";
      i++;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // delimiter run
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const ch = String.fromCharCode(c);
      const fl = flanking(text, i, j);
      let open = false, close = false;
      if (ch === "_") {
        open = fl.leftFlanking && (!fl.rightFlanking || fl.beforePunct);
        close = fl.rightFlanking && (!fl.leftFlanking || fl.afterPunct);
      } else {
        open = fl.leftFlanking;
        close = fl.rightFlanking;
      }
      flush();
      if (c === 126) hasTilde = true; else hasDelim = true;
      nodes.push({ t: "delim", ch, len: j - i, open, close, pos: i, a: i, b: j });
      i = j;
      continue;
    }
    if (c === 91 || (c === 33 && text.charCodeAt(i + 1) === 91)) { // [ or ![
      flush();
      const img = c === 33;
      const pos = img ? i + 1 : i;
      nodes.push({ t: "bracket", img, pos, a: i, b: pos + 1 });
      stack.push(nodes.length - 1);
      i = pos + 1;
      continue;
    }
    if (c === 93) { // ] try to form link
      flush(); // the label text must be in nodes before slicing kids
      // find nearest open bracket
      let bi = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (nodes[stack[s]] && nodes[stack[s]].t === "bracket") { bi = stack[s]; break; }
      }
      let formed = null;
      if (bi >= 0) {
        const bnode = nodes[bi];
        const label = text.slice(bnode.pos + 1, i);
        if (labelBackticksOk(label)) {
          const kids = nodes.slice(bi + 1);
          const hasLink = !bnode.img && kids.some(k => k && k.t === "link");
          if (!hasLink) {
            const after = i + 1;
            let dest = null, title = null, end = -1;
            if (text.charCodeAt(after) === 40) {
              const d = parseInlineDest(text, after);
              if (d) { dest = d.dest; title = d.title; end = d.end; }
              else {
                // inline destination invalid: fall back to shortcut reference
                const ref = refs.get(normLabel(label));
                if (ref) { dest = ref.dest; title = ref.title; end = i + 1; }
              }
            } else if (text.charCodeAt(after) === 91) {
              const end2 = findCloseBracket(text, after);
              if (end2 >= 0) {
                const lab2 = end2 === after + 1 ? label : text.slice(after + 1, end2);
                const ref = refs.get(normLabel(lab2));
                if (ref) { dest = ref.dest; title = ref.title; end = end2 + 1; }
              }
            } else {
              const ref = refs.get(normLabel(label));
              if (ref) { dest = ref.dest; title = ref.title; end = i + 1; }
            }
            if (dest !== null) {
              formed = { dest, title, end, kids, bnode };
            }
          }
        }
      }
      if (formed) {
        // leftover bracket nodes inside the label become literal text
        const kids = formed.kids.map(k => {
          if (k && k.t === "bracket") {
            const t = textNode(k.img ? "![" : "[");
            t.raw = k.img ? "![" : "[";
            t.a = k.a; t.b = k.b;
            return t;
          }
          return k;
        }).filter(k => k);
        // process kids level (autolinks, masking, emphasis) with label's own ranges
        // extended autolinks (www/scheme/email) must not form inside link text
        // (nested <a>); refs.inAnchor suppresses them for the kids' level
        const labelHidden = hidden.filter(r => r[0] >= formed.bnode.pos && r[1] <= i);
        // marked restores inLink after tokenizing a link label, so tags
        // inside the label must not leak into the outer anchor state:
        // recompute the state as of just before this label's '['
        let preLabelAnchor = entryInAnchor;
        for (const nd2 of nodes) {
          if (nd2 && nd2.t === "html" && nd2.a < formed.bnode.pos) {
            if (/^<a /i.test(nd2.s)) preLabelAnchor = true;
            else if (/^<\/a>/i.test(nd2.s)) preLabelAnchor = false;
          }
        }
        refs.inAnchor = true;
        processLevel(kids, text, refs, labelHidden, formed.bnode.pos + 1, i, true);
        refs.inAnchor = preLabelAnchor;
        flush();
        nodes.length = bi;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s] >= bi) stack.splice(s, 1);
        }
        if (formed.bnode.img) {
          const alt = processEntities(plainTextOf(kids));
          nodes.push({ t: "img", src: cleanDest(formed.dest), title: formed.title, alt, a: formed.bnode.pos - 1, b: formed.end });
        } else {
          nodes.push({ t: "link", href: cleanDest(formed.dest), title: formed.title, kids, a: formed.bnode.pos, b: formed.end });
        }
        i = formed.end;
        textStart = i;
        continue;
      }
      // failed: the bracket this ] closes is consumed (popped) even when no
      // link forms, so a later ] cannot reuse it as the link opener
      if (bi >= 0) {
        const si = stack.indexOf(bi);
        if (si >= 0) stack.splice(si, 1);
        const bnode = nodes[bi];
        const label = text.slice(bnode.pos + 1, i);
        if ((label.indexOf("`") >= 0 || label.indexOf("[") >= 0)) {
          const mend = maskingLinkEnd(text, bnode.pos, i);
          if (mend > 0) hidden.push([bnode.pos, mend]);
        }
      }
      if (textBuf.length === 0) textStart = i;
      textBuf += "]";
      i++;
      continue;
    }
    if (textBuf.length === 0) textStart = i;
    textBuf += text[i];
    i++;
  }
  flush();
  return { nodes, hidden, hasDelim, hasTilde };
}

// ---------- extended autolinks ----------
const BACKPEDAL_TRAIL = new Set("?!.,:;*_~'\"".split(""));
function backpedal(s) {
  // cut before an & starting an entity-like sequence
  const m = s.search(/&(?:#\d+;|#x[0-9A-Fa-f]+;|[A-Za-z][A-Za-z0-9]*;)/);
  if (m >= 0) s = s.slice(0, m);
  let changed = true;
  while (changed && s.length > 0) {
    changed = false;
    const last = s.charCodeAt(s.length - 1);
    if (last === 41) { // )
      // stack semantics: is the final ) matched? (only the LAST ) matters)
      let d2 = 0, lastMatched = false;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 40) d2++;
        else if (c === 41) { lastMatched = d2 > 0; if (d2 > 0) d2--; }
      }
      if (!lastMatched) { s = s.slice(0, -1); changed = true; continue; }
    }
    if (BACKPEDAL_TRAIL.has(s[s.length - 1])) { s = s.slice(0, -1); changed = true; }
  }
  return s;
}

const LOCAL_SET = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-".split(""));
function isLocalCh(c) { return LOCAL_SET.has(c); }

// email candidate at @ position; returns {start, end, addr} or null. nodes: current node list (for rescue check)
function matchEmail(text, atPos, nodes) {
  // local part: walk back
  let ls = atPos;
  while (ls > 0 && isLocalCh(text[ls - 1])) ls--;
  // advance past leading chars that are not letters or digits
  while (ls < atPos && !/[A-Za-z0-9]/.test(text[ls])) ls++;
  if (ls >= atPos) return null;
  // domain scan: [A-Za-z0-9.-] plus _ only when not followed by _
  let de = atPos + 1;
  while (de < text.length) {
    const c = text[de];
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "." || c === "-") { de++; continue; }
    if (c === "_" && text[de + 1] !== "_") { de++; continue; }
    break;
  }
  if (de <= atPos + 1) return null;
  let domain = text.slice(atPos + 1, de);
  // a trailing _ that closes an emphasis opened before the email is a
  // delimiter, not part of the domain (doc-26: _method ... install@cinder
  // .example.com_ links fully). With no opener before the email (gfm-632:
  // a.b-c_d@a.b_) the _ stays and labelsOk shortening yields no link.
  if (domain.endsWith("_") && nodes) {
    let hasOpener = false;
    for (const nd of nodes) {
      if (nd && nd.t === "delim" && nd.ch === "_" && nd.open && nd.pos < ls) { hasOpener = true; break; }
    }
    if (hasOpener) domain = domain.replace(/_+$/, "");
  }
  // validate labels with shortening
  function labelsOk(d) {
    const labs = d.split(".");
    if (labs.length < 2) return false;
    for (let k = 0; k < labs.length; k++) {
      const lab = labs[k];
      if (lab.length === 0) return false;
      if (!/^[A-Za-z0-9_-]+$/.test(lab)) return false;
      if (k > 0 && !/[A-Za-z0-9]$/.test(lab)) return false;
    }
    return true;
  }
  let shortened = false;
  while (domain.length > 0 && !labelsOk(domain)) {
    const dot = domain.lastIndexOf(".");
    if (dot < 0) { domain = ""; break; }
    domain = domain.slice(0, dot);
    shortened = true;
  }
  if (domain === "") {
    // rescue: full address may still link if an openable _ run precedes it
    return emailRescue(text, atPos, ls, de, nodes);
  }
  let end = atPos + 1 + domain.length;
  // char after must not be word char or hyphen — but a __ run after the
  // domain is an emphasis delimiter, not a domain continuation (doc-04:
  // because@mark.example.com__ must link the full .com). A single trailing
  // _ keeps the old shortening behaviour (gfm-632: a.b-c_d@a.b_ = no link).
  // A _ that is an emphasis delimiter closing an opener before the email
  // (doc-26: _method ... install@cinder.example.com_) is likewise not a
  // domain continuation.
  const after = text[end];
  const isDoubleUnder = after === "_" && text[end + 1] === "_";
  let afterIsDelim = false;
  if (after === "_" && nodes) {
    for (const nd of nodes) {
      if (nd && nd.t === "delim" && nd.ch === "_" && nd.pos === end) { afterIsDelim = true; break; }
    }
  }
  if (after && !isDoubleUnder && !afterIsDelim && (isWordCh(after.codePointAt(0)) || after === "-")) {
    const dot = domain.lastIndexOf(".");
    if (dot < 0) return emailRescue(text, atPos, ls, de, nodes);
    domain = domain.slice(0, dot);
    end = atPos + 1 + domain.length;
    shortened = true;
    if (domain.indexOf(".") < 0) return emailRescue(text, atPos, ls, de, nodes);
  }
  if (shortened && after === "_") {
    const r = emailRescue(text, atPos, ls, de, nodes);
    if (r) return r;
  }
  return { start: ls, end, addr: text.slice(ls, end) };
}

function emailRescue(text, atPos, ls, de, nodes) {
  // full address (strip trailing _ run from domain scan)
  let fullEnd = de;
  while (fullEnd > atPos + 1 && text[fullEnd - 1] === "_") fullEnd--;
  if (fullEnd <= atPos + 1) return null;
  const domain = text.slice(atPos + 1, fullEnd);
  const labs = domain.split(".");
  if (labs.length < 2) return null;
  for (let k = 0; k < labs.length; k++) {
    const lab = labs[k];
    if (lab.length === 0 || !/^[A-Za-z0-9_-]+$/.test(lab)) return null;
    if (k > 0 && !/[A-Za-z0-9]$/.test(lab)) return null;
  }
  // the underscore run immediately before the address must be an openable _ delimiter
  for (let i = ls - 1; i >= 0 && text[i] === "_"; i--) {}
  // find delim node ending exactly at ls
  let ok = false;
  for (const nd of nodes) {
    if (nd && nd.t === "delim" && nd.ch === "_" && nd.b === ls) {
      const fl = flanking(text, nd.a, nd.b);
      if (fl.leftFlanking && (!fl.rightFlanking || fl.beforePunct)) ok = true;
    }
  }
  if (!ok) return null;
  return { start: ls, end: fullEnd, addr: text.slice(ls, fullEnd) };
}

function matchWww(text, pos) {
  // text[pos] starts with "www."
  let i = pos + 4;
  const n = text.length;
  // domain: labels starting/ending alnum, >=1 dot, last label has a letter
  let de = i;
  while (de < n) {
    const c = text[de];
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "." || c === "-" || c === "_") { de++; continue; }
    if (c === "\\") { de++; continue; } // backslash = path separator for domain validation
    break;
  }
  let domEnd = de;
  // domain ends at first backslash
  const bs = text.indexOf("\\", i);
  if (bs >= 0 && bs < de) domEnd = bs;
  let domain = text.slice(i, domEnd);
  // strip trailing dots (sentence punctuation, not part of the domain)
  while (domain.length > 0 && domain.charCodeAt(domain.length - 1) === 46) domain = domain.slice(0, -1);
  // strip a trailing underscore: it is an emphasis delimiter, not part of
  // the domain (doc-07: www.relay.com_ inside _..._ must still linkify)
  while (domain.length > 0 && domain.charCodeAt(domain.length - 1) === 95) domain = domain.slice(0, -1);
  const labs = domain.split(".");
  if (labs.length < 2) return null;
  for (const lab of labs) {
    if (lab.length === 0) return null;
    if (!/^[A-Za-z0-9]/.test(lab) || !/[A-Za-z0-9]$/.test(lab)) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(lab)) return null;
  }
  if (!/[A-Za-z]/.test(labs[labs.length - 1])) return null;
  // path: from domEnd (or de) until whitespace or <
  let pe = domEnd;
  // if domain ended at backslash, path starts there
  let e = de;
  while (e < n) {
    const c = text.charCodeAt(e);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    e++;
  }
  let raw = text.slice(pos, e);
  raw = backpedal(raw);
  // a trailing underscore right after the domain (no path) is an emphasis
  // delimiter, not part of the URL (doc-07: www.relay.com_ in _..._)
  if (raw.indexOf("/", 4) === -1) {
    while (raw.length > 4 && raw.charCodeAt(raw.length - 1) === 95) raw = raw.slice(0, -1);
  }
  if (raw.length <= 4) return null;
  return { start: pos, end: pos + raw.length, url: raw };
}

function matchScheme(text, pos) {
  const n = text.length;
  let i = pos;
  if (!((text.charCodeAt(i) >= 65 && text.charCodeAt(i) <= 90) || (text.charCodeAt(i) >= 97 && text.charCodeAt(i) <= 122))) return null;
  let j = i + 1;
  while (j < n && j - i < 32) {
    const c = text.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
    else break;
  }
  if (j - i < 2 || j - i > 32) return null;
  if (text.charCodeAt(j) !== 58) return null;
  const scheme = text.slice(i, j).toLowerCase();
  let e = j + 1;
  while (e < n) {
    const c = text.charCodeAt(e);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    e++;
  }
  let raw = text.slice(i, e);
  const after = raw.slice(scheme.length + 1);
  if (!/[A-Za-z0-9]/.test(after)) return null;
  if (scheme === "mailto" || scheme === "xmpp") {
    // strict email shape after scheme, at most one path segment
    const at = after.indexOf("@");
    if (at < 0) return null;
    const em = matchEmailSimple(after, at);
    if (!em) return null;
    let end2 = em.end;
    // a / path segment is included only when it has content after it;
    // a trailing / alone stays literal
    if (after[end2] === "/" && end2 + 1 < after.length && /[A-Za-z0-9@.]/.test(after[end2 + 1])) {
      let p = end2 + 1;
      while (p < after.length && /[A-Za-z0-9@.]/.test(after[p])) p++;
      end2 = p;
    }
    if (after[end2] && after[end2] !== "/" && /[A-Za-z0-9]/.test(after[end2])) return null;
    raw = raw.slice(0, scheme.length + 1 + end2);
    return { start: pos, end: pos + raw.length, url: raw, scheme };
  }
  raw = backpedal(raw);
  // truncate at the first unmatched "(" — parens in an autolink must balance
  // (doc-08: https://sub.domain.example.io)](https://npmjs.com/heading
  // must stop before the "("; the rest is a separate autolink)
  {
    const stack = [];
    for (let k = 0; k < raw.length; k++) {
      const c = raw.charCodeAt(k);
      if (c === 40) stack.push(k);
      else if (c === 41 && stack.length > 0) stack.pop();
    }
    if (stack.length > 0) raw = raw.slice(0, stack[0]);
  }
  raw = backpedal(raw);
  if (raw.length <= scheme.length + 1) return null;
  return { start: pos, end: pos + raw.length, url: raw, scheme };
}

function matchEmailSimple(text, atPos) {
  let ls = atPos;
  while (ls > 0 && isLocalCh(text[ls - 1])) ls--;
  while (ls < atPos && !/[A-Za-z0-9]/.test(text[ls])) ls++;
  if (ls >= atPos) return null;
  let de = atPos + 1;
  while (de < text.length && /[A-Za-z0-9._-]/.test(text[de])) de++;
  // strip trailing dots (sentence punctuation, not part of the domain)
  while (de > atPos + 1 && text.charCodeAt(de - 1) === 46) de--;
  const domain = text.slice(atPos + 1, de);
  const labs = domain.split(".");
  if (labs.length < 2) return null;
  for (let k = 0; k < labs.length; k++) {
    if (!/^[A-Za-z0-9_-]+$/.test(labs[k])) return null;
    if (k > 0 && !/[A-Za-z0-9]$/.test(labs[k])) return null;
  }
  return { start: ls, end: de };
}

// split nodes for an autolink candidate [s,e]; returns true if placed
function placeAutolink(nodes, text, s, e, href, displayRaw) {
  // abort if a code/html/link/img/autolink node overlaps
  for (const nd of nodes) {
    if (!nd) continue;
    if (nd.t === "code" || nd.t === "html" || nd.t === "link" || nd.t === "img" || nd.t === "autolink") {
      if (nd.a < e && nd.b > s) return false;
    }
  }
  const out = [];
  let placed = false;
  // map an original-text position to a position inside nd.raw (rendered):
  // each backslash escape before it shortens the rendered text by one
  const countEsc = (a, b) => {
    let c = 0;
    for (let k = a; k < b; k++) {
      if (text.charCodeAt(k) === 92 && k + 1 < b && isAsciiPunct(text.charCodeAt(k + 1))) { c++; k++; }
    }
    return c;
  };
  for (const nd of nodes) {
    if (!nd) continue;
    if (nd.t === "text") {
      if (nd.b <= s || nd.a >= e) { out.push(nd); continue; }
      const rs = s - nd.a - countEsc(nd.a, s);
      const re = e - nd.a - countEsc(nd.a, e);
      if (nd.a < s) {
        const lraw = nd.raw.slice(0, rs);
        const left = textNode(lraw);
        left.raw = lraw;
        left.a = nd.a; left.b = s;
        out.push(left);
      }
      if (!placed) {
        const disp = textNode(displayRaw);
        out.push({ t: "autolink", href, display: disp.s, a: s, b: e });
        placed = true;
      }
      if (nd.b > e) {
        const rraw = nd.raw.slice(re);
        const right = textNode(rraw);
        right.raw = rraw;
        right.a = e; right.b = nd.b;
        out.push(right);
      }
      continue;
    }
    if (nd.t === "delim") {
      if (nd.a >= s && nd.b <= e) continue; // consumed into the URL
      out.push(nd);
      continue;
    }
    if (nd.t === "br") {
      // a backslash-newline hard break whose backslash is inside the URL
      // is consumed by the autolink (doc-10: .../of.\ at line end is part
      // of the URL, not a <br>); the newline after it stays as a soft break
      if (nd.a >= s && nd.a < e) {
        const nl = textNode("\n");
        nl.raw = "\n"; nl.a = nd.a + 1; nl.b = nd.b;
        out.push(nl);
        continue;
      }
      out.push(nd); continue;
    }
    out.push(nd);
  }
  if (!placed) return false;
  nodes.length = 0;
  for (const nd of out) nodes.push(nd);
  return true;
}

// leftmost valid scheme-autolink start at/after i (or -1): a scheme is a
// letter, then 1-31 scheme chars, then ':', 2-32 chars total, at a word
// boundary. Found by jumping to the next ':' and walking back over the
// scheme-char run (a regex /[A-Za-z][A-Za-z0-9+.-]{1,31}:/ backtracks badly
// on long words without a colon).
function nextSchemePos(text, i, hi, lo) {
  let c = text.indexOf(":", i);
  while (c >= 0 && c < hi) {
    let s = c - 1, len = 0;
    while (s >= 0 && len < 33) {
      const ch = text.charCodeAt(s);
      if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 43 || ch === 45 || ch === 46) { s--; len++; }
      else break;
    }
    const runStart = s + 1;
    // the forward scan must not return a start behind the search position
    // (that would send the caller backwards and loop forever)
    for (let p = runStart < i ? i : runStart; p < c; p++) {
      const f = text.charCodeAt(p);
      if (!((f >= 65 && f <= 90) || (f >= 97 && f <= 122))) continue;
      if (p !== lo && p > 0 && isWordCh(text.charCodeAt(p - 1))) continue;
      if (c - p < 2 || c - p > 32) continue;
      return p;
    }
    c = text.indexOf(":", c + 1);
  }
  return -1;
}

function processLevel(nodes, text, refs, hidden, lo, hi, entryInAnchor, hasDelim = true, hasTilde = true) {
  if (entryInAnchor === undefined) entryInAnchor = refs.inAnchor;
  // extended autolinks (first scheme position is computed once here and
  // reused as the jump scan's starting cache — cheaper than the regex test,
  // which backtracks on long words without a colon)
  const firstScheme = (text.indexOf("www.") >= 0 || text.indexOf("@") >= 0) ? -2 : nextSchemePos(text, lo, hi, lo);
  const plausiblyBasic = firstScheme === -2 || firstScheme >= 0;
  if (plausiblyBasic) {
    // anchor state at a position: the entry state toggled by <a> / </a> html
    // nodes before it. Marked checks inLink inline while scanning, so a </a>
    // later in the same paragraph must not re-enable an earlier URL (doc-33:
    // the <a /> block sets it, the </a> at the paragraph's end clears it).
    // Built lazily — only when autolinks are plausible — since it costs a
    // walk over all nodes.
    const anchorTrans = [];
    for (const nd of nodes) {
      if (nd && nd.t === "html") {
        if (/^<a /i.test(nd.s)) anchorTrans.push([nd.a, true]);
        else if (/^<\/a>/i.test(nd.s)) anchorTrans.push([nd.a, false]);
      }
    }
    const inAnchorAt = (pos) => {
      let v = entryInAnchor;
      for (let q = 0; q < anchorTrans.length; q++) {
        if (anchorTrans[q][0] < pos) v = anchorTrans[q][1];
        else break;
      }
      return v;
    };
    // inside an anchor at entry with no transition in this paragraph, no
    // autolink can form at all
    if (!(entryInAnchor && anchorTrans.length === 0)) {
    // blocked spans: link/img/code/html/autolink nodes
    const blocked = [];
    for (const nd of nodes) {
      if (nd && (nd.t === "link" || nd.t === "img" || nd.t === "code" || nd.t === "html" || nd.t === "autolink")) blocked.push([nd.a, nd.b]);
    }
    const inBlocked = (s, e) => blocked.some(b => s < b[1] && e > b[0]);
    // jump scan: hop straight to the next www. / @ / scheme-like position
    // instead of stepping char by char (the per-char loop was the hotspot)
    let i = lo;
    // -2 not computed, -1 none, >=0 next scheme position; firstScheme (when
    // >= 0) is the first one, already computed for the plausibly check
    let cachedScheme = firstScheme;
    while (i < hi) {
      const nextWww = text.indexOf("www.", i);
      const nextAt = text.indexOf("@", i);
      if (cachedScheme === -2 || (cachedScheme >= 0 && cachedScheme < i)) {
        cachedScheme = nextSchemePos(text, i, hi, lo);
      }
      const nextScheme = cachedScheme;
      let next = hi, kind = 0; // 1 www, 2 @, 3 scheme
      if (nextWww >= 0 && nextWww < hi && nextWww < next) { next = nextWww; kind = 1; }
      if (nextAt >= 0 && nextAt < hi && nextAt < next) { next = nextAt; kind = 2; }
      if (nextScheme >= 0 && nextScheme < hi && nextScheme < next) { next = nextScheme; kind = 3; }
      if (next >= hi) break;
      if (kind === 3 && nextWww === next) kind = 1; // www wins a tie (tested first)
      i = next;
      let cand = null;
      if (kind === 1) {
        if (text.startsWith("www.", i) && (i === 0 || !isWordCh(text.charCodeAt(i - 1)))) {
          cand = matchWww(text, i);
          if (cand) {
            cand.href = "http://" + cleanAutoHref(cand.url.replace(/\\(.)/g, (m, ch) => isAsciiPunct(ch.charCodeAt(0)) ? ch : m));
            cand.display = cand.url.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, "$1");
            cand.kind = "www";
          }
        }
      } else if (kind === 2) {
        const em = matchEmail(text, i, nodes);
        if (em) {
          cand = { start: em.start, end: em.end, href: "mailto:" + cleanAutoHref(em.addr), display: em.addr, kind: "email" };
        }
      } else if ((text.charCodeAt(i) >= 65 && text.charCodeAt(i) <= 90) || (text.charCodeAt(i) >= 97 && text.charCodeAt(i) <= 122)) {
        // a scheme autolink must start at a word boundary (not mid-word,
        // so a failed mailto: is not re-matched as ailto:)
        if (i === lo || !isWordCh(text.charCodeAt(i - 1))) {
          cand = matchScheme(text, i);
          if (cand) {
            cand.href = cleanAutoHref(cand.url);
            cand.display = cand.url;
            cand.kind = "scheme";
          }
        }
      }
      if (cand && cand.start >= lo && cand.end <= hi && !inBlocked(cand.start, cand.end) && !inAnchorAt(cand.start)) {
        // suppression: enclosing bracket that would form a link
        let suppressed = false;
        for (const nd of nodes) {
          if (nd && nd.t === "bracket" && nd.pos < cand.start) {
            const cpos = findCloseBracket(text, nd.pos);
            if (cpos > cand.start && wouldFormLink(text, nd.pos, refs)) { suppressed = true; break; }
          }
        }
        if (!suppressed) {
          if (placeAutolink(nodes, text, cand.start, cand.end, cand.href, cand.display)) {
            // recompute blocked spans after mutation
            blocked.length = 0;
            for (const nd of nodes) {
              if (nd && (nd.t === "link" || nd.t === "img" || nd.t === "code" || nd.t === "html" || nd.t === "autolink")) blocked.push([nd.a, nd.b]);
            }
            i = cand.end;
            continue;
          }
        }
        i = cand.end;
        continue;
      }
      i++;
    }
    } // end: not (entry anchor with no transition)
  } // end: plausiblyBasic
  // hidden ranges: suppress delimiters inside them
  if (hidden.length > 0) {
    for (const nd of nodes) {
      if (nd && nd.t === "delim") {
        for (const r of hidden) {
          if (nd.pos >= r[0] && nd.pos < r[1]) { nd.open = false; nd.close = false; break; }
        }
      }
    }
  }
  // emphasis + strikethrough (skipped when the scan saw no delimiters
  // of that kind — the passes are no-ops then, just a walk over the nodes)
  if (hasDelim) processEmphasis(nodes, text);
  if (hasTilde) processStrikethrough(nodes);
}

// ---------- emphasis (closer-first, per CommonMark spec) ----------
function ruleOfThree(o, d) {
  // the rule of three bars a match when the combined length is a multiple
  // of three and exactly one of the two delimiters can both open and close
  if ((o.len + d.len) % 3 !== 0) return false;
  const oBoth = o.open && o.close;
  const dBoth = d.open && d.close;
  return oBoth !== dBoth;
}

// --- marked emStrong leftover simulation ---
// Classify a delimiter run of ch at [s,e) in text by marked's RDelim groups
// (ct for *, kt for _): 0 = invisible to the closer scan, 1/2 = closer-only,
// 3/4 = opener-like (adds to the opener debt), 5/6 = both-flanked
// (rule-of-three check).
function delimRunGroup(text, ch, s, e) {
  const prev = s > 0 ? text[s - 1] : "";
  const next = e < text.length ? text[e] : "";
  const prevWS = prev !== "" && isSpaceCh(prev.codePointAt(0));
  const nextWS = next !== "" && isSpaceCh(next.codePointAt(0));
  const prevPunct = prev !== "" && isPunctCh(prev);
  const nextPunct = next !== "" && isPunctCh(next);
  const prevWord = prev !== "" && !prevWS && !prevPunct;
  const nextWord = next !== "" && !nextWS && !nextPunct;
  const nextEnd = next === "";
  if (ch === "*") {
    if (prevPunct && (nextWS || nextEnd)) return 1;
    if (prevWord && (nextPunct || nextWS || nextEnd)) return 2;
    if ((prevPunct || prevWS) && nextWord) return 3;
    if (prevWS && nextPunct) return 4;
    if (prevPunct && nextPunct) return 5;
    if (prevWord && nextWord) return 6;
    return 0;
  }
  // "_" (kt): group 3 is space-only before, group 6 takes punct-or-word before
  if (prevPunct && (nextWS || nextEnd)) return 1;
  if (prevWord && (nextPunct || nextWS || nextEnd)) return 2;
  if (prevWS && nextWord) return 3;
  if (prevWS && nextPunct) return 4;
  if (prevPunct && nextPunct) return 5;
  if ((prevPunct || prevWord) && nextWord) return 6;
  return 0;
}

// delimiter open/close flags for a run at [s,e), as scanInline computes them
function delimFlags(ch, text, s, e) {
  const fl = flanking(text, s, e);
  if (ch === "_") {
    return {
      open: fl.leftFlanking && (!fl.rightFlanking || fl.beforePunct),
      close: fl.rightFlanking && (!fl.leftFlanking || fl.afterPunct),
    };
  }
  return { open: fl.leftFlanking, close: fl.rightFlanking };
}

// Simulate marked's emStrong closer scan for an opener/closer pair and return
// how many stars of the closer run marked consumes into the element (or null
// when the scan does not end at this closer). Marked keeps a debt m (opener
// length plus opener-like runs minus closers consumed) and a refund f
// (rule-of-three-skipped both-flanked runs); the final closer uses
// min(b, b+m+f) stars. When that exceeds the opener length, the excess stars
// land INSIDE the element (doc-11/doc-30: **return that *old*two***).
function simulateCloserUsed(text, ch, opener, closer, nodes, oiIdx, ciIdx) {
  const k = opener.len;
  let runStart = opener.a;
  const cc = ch.charCodeAt(0);
  while (runStart > 0 && text.charCodeAt(runStart - 1) === cc) runStart--;
  const y = (opener.a - runStart) + k;
  const o = opener.a > 0 && text[opener.a - 1] === ch;
  // R: the opener is preceded by non-space text and (followed by punctuation
  // or, for *, preceded by a non-punctuation char)
  const p = runStart > 0 ? text[runStart - 1] : "";
  const afterRun = opener.a + k < text.length ? text[opener.a + k] : "";
  const d = afterRun !== "" && isPunctCh(afterRun) ? afterRun : "";
  const h = p === "*" || p === "_" || (p !== "" && isPunctCh(p));
  const R = p !== "" && p.trim() !== "" && (d !== "" || (ch === "*" && !h));
  // ranges masked from marked's scan (code spans, links, autolinks, tags)
  const skip = [];
  const collect = (nds) => {
    for (const nd of nds) {
      if (!nd) continue;
      if (nd.t === "code" || nd.t === "link" || nd.t === "img" || nd.t === "autolink" || nd.t === "html") skip.push([nd.a, nd.b]);
      if (nd.kids) collect(nd.kids);
    }
  };
  const contentNodes = [];
  for (let q = oiIdx + 1; q < ciIdx; q++) if (nodes[q]) contentNodes.push(nodes[q]);
  collect(contentNodes);
  skip.sort((a, b) => a[0] - b[0]);
  const inSkip = (pos) => {
    for (let q = 0; q < skip.length; q++) if (pos >= skip[q][0] && pos < skip[q][1]) return skip[q][1];
    return 0;
  };
  // skip-pattern at the scan start: ^[^_*]*?__[^_*]*?\*[^_*]*?(?=__) (for *)
  // or ^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*) (for _) — that one delimiter run
  // is consumed by the match and never classified
  let skipRun = null;
  {
    const slice = text.slice(opener.a + k, closer.b);
    const re = ch === "*" ? /^[^_*]*?__[^_*]*?(\*)[^_*]*?__/ : /^[^_*]*?\*\*[^_*]*?(_)[^_*]*?\*\*/;
    const m0 = re.exec(slice);
    if (m0) {
      const at = opener.a + k + m0.index + m0[0].indexOf(m0[1]);
      skipRun = [at, at + 1];
    }
  }
  let m = k, f = 0;
  let i = opener.a + k;
  const end = closer.b;
  while (i < end) {
    const jump = inSkip(i);
    if (jump) { i = jump; continue; }
    if (text.charCodeAt(i) !== cc) { i++; continue; }
    let j = i;
    while (j < end && text.charCodeAt(j) === cc) j++;
    if (skipRun && i >= skipRun[0] && i < skipRun[1]) { i = j; continue; }
    const b = j - i;
    const g = delimRunGroup(text, ch, i, j);
    if (g === 0) { i = j; continue; }
    if (g === 3 || g === 4) { m += b; i = j; continue; }
    if (g === 5 || g === 6 || R) {
      if (o && (g === 5 || g === 6)) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; i = j; continue; }
    }
    m -= b;
    if (m > 0) { i = j; continue; }
    // terminal closer: is it our closer run?
    if (i !== closer.a || j !== closer.b) return null;
    return Math.min(b, b + m + f);
  }
  return null;
}

function processEmphasis(nodes, text) {
  // skip when no delimiter at all
  let anyDelim = false;
  for (const nd of nodes) if (nd && nd.t === "delim" && (nd.open || nd.close)) { anyDelim = true; break; }
  if (!anyDelim) return;
  // double-run-at-start invisibility
  {
    let first = -1, second = -1;
    for (let k = 0; k < nodes.length; k++) {
      if (!nodes[k]) continue;
      if (nodes[k].t === "delim") { if (first < 0) first = k; else { second = k; break; } }
      else if (nodes[k].t === "text") { if (first >= 0) break; }
      else break;
    }
    if (first >= 0 && second >= 0) {
      const a = nodes[first], b = nodes[second];
      if (a.len >= 2 && b.len === 1 && a.ch !== b.ch) { b.open = false; b.close = false; }
    }
  }
  const openers = []; // delimiter node objects that can open, in order
  // openers_bottom (spec): once an open-only opener is fully consumed by a
  // match, a later SEPARATE closer of the same char may not look back past
  // the opener just before it (e.g. *first changes **code**request* leaves
  // the outer * literal, while *foo**bar**baz* still forms the outer em
  // because its inner ** opener can also close). A leftover from the same
  // closer run is exempt: the bottom is only set when the closer is fully
  // consumed too, so the leftover is re-processed before any bottom exists.
  const bottom = { "*": null, "_": null };
  const bottomLen = { "*": 0, "_": 0 };
  let j = 0;
  while (j < nodes.length) {
    const nd = nodes[j];
    if (!nd || nd.t !== "delim") { j++; continue; }
    if (nd.ch === "~") { j++; continue; } // strikethrough is handled separately
    if (nd.close) {
      // look back for the nearest matching opener
      let oi = -1;
      let blockedByBottom = false;
      for (let s = openers.length - 1; s >= 0; s--) {
        const o = openers[s];
        // bottom: a shorter closer may not look back past it (doc-03: outer
        // * len1 blocked by inner ** len2; doc-02: outer ** len2 is not
        // shorter, so it still matches and the outer strong forms). A closer
        // longer than the bottom opener skips it ONLY if an earlier opener
        // of at least the closer's length exists (doc-11: final ** len2
        // skips the * len1 and matches the outer ** len2; doc-04/20/27:
        // no earlier opener, so the trailing ** still matches the outer *
        // len1 and forms the em).
        if (o === bottom[nd.ch] && nd.len < bottomLen[nd.ch]) { blockedByBottom = true; break; }
        if (o === bottom[nd.ch] && o.len < nd.len) {
          let earlier = -1;
          for (let t = s - 1; t >= 0; t--) {
            const e = openers[t];
            if (e.ch !== nd.ch) continue;
            if (e.len < nd.len) continue;
            if (ruleOfThree(e, nd)) continue;
            earlier = t; break;
          }
          if (earlier < 0) { oi = s; break; }
          continue;
        }
        if (o.ch !== nd.ch) continue;
        if (ruleOfThree(o, nd)) continue;
        oi = s;
        break;
      }
      if (oi >= 0) {
        const opener = openers[oi];
        const openerWasOpenOnly = opener.open && !opener.close;
        // the closest same-char opener before the matched one: the bottom
        let prevSame = null;
        for (let s = oi - 1; s >= 0; s--) {
          if (openers[s].ch === nd.ch) { prevSame = openers[s]; break; }
        }
        const oiIdx = nodes.indexOf(opener);
        const ciIdx = j;
        // inner content between opener and closer
        let content = [];
        for (let k = oiIdx + 1; k < ciIdx; k++) if (nodes[k]) content.push(nodes[k]);
        // marked's closer accounting (simulateCloserUsed): when the closer
        // run is longer than the opener, the excess stars land INSIDE the
        // element iff the opener's debt plus rule-of-three refunds cover
        // them; otherwise they stay outside as a leftover delimiter.
        const origOLen = opener.len, origCLen = nd.len;
        let simUsed = null;
        if (origCLen > origOLen) simUsed = simulateCloserUsed(text, opener.ch, opener, nd, nodes, oiIdx, ciIdx);
        let delimUse, openerExcess, closerInside, closerOutside, openerLeftover;
        if (simUsed === null) {
          delimUse = Math.min(origOLen, origCLen);
          openerExcess = 0; closerInside = 0;
          openerLeftover = origOLen - delimUse;
          closerOutside = origCLen - delimUse;
        } else {
          delimUse = Math.min(origOLen, simUsed);
          openerExcess = origOLen - delimUse;
          closerInside = simUsed - delimUse;
          openerLeftover = 0;
          closerOutside = origCLen - simUsed;
        }
        // excess stars become delimiter nodes inside the element, so the
        // recursion into the kids can still pair them (marked re-tokenizes
        // the inner text: **a b*c d*** -> <strong>a b<em>c d</em></strong>)
        if (openerExcess > 0) {
          const fl = delimFlags(opener.ch, text, opener.a + delimUse, opener.a + origOLen);
          content.unshift({ t: "delim", ch: opener.ch, len: openerExcess, open: fl.open, close: fl.close, pos: opener.a + delimUse, a: opener.a + delimUse, b: opener.a + origOLen });
        }
        if (closerInside > 0) {
          const fl = delimFlags(nd.ch, text, nd.a, nd.a + closerInside);
          content.push({ t: "delim", ch: nd.ch, len: closerInside, open: fl.open, close: fl.close, pos: nd.a, a: nd.a, b: nd.a + closerInside });
        }
        // form nested emphasis while both sides have delimiters left
        let oLen = delimUse, cLen = delimUse;
        let wrapped = content;
        let firstUse = 0;
        while (oLen > 0 && cLen > 0) {
          const use = Math.min((oLen >= 2 && cLen >= 2) ? 2 : 1, oLen, cLen);
          if (!firstUse) firstUse = use;
          wrapped = [{ t: use === 1 ? "em" : "strong", kids: wrapped, a: opener.a, b: nd.b }];
          oLen -= use;
          cLen -= use;
        }
        // leftovers stay as delimiter nodes (they can still match later)
        const replacement = [];
        if (openerLeftover > 0) {
          replacement.push({ t: "delim", ch: opener.ch, len: openerLeftover, open: opener.open, close: opener.close, pos: opener.a, a: opener.a, b: opener.a + openerLeftover });
        }
        for (const w of wrapped) replacement.push(w);
        if (closerOutside > 0) {
          replacement.push({ t: "delim", ch: nd.ch, len: closerOutside, open: nd.open, close: nd.close, pos: nd.b - closerOutside, a: nd.b - closerOutside, b: nd.b });
        }
        // remove the matched opener (and any openers inside the span) from the stack
        for (let s = openers.length - 1; s >= 0; s--) {
          const o = openers[s];
          const idx = nodes.indexOf(o);
          if (idx >= oiIdx && idx <= ciIdx) openers.splice(s, 1);
        }
        nodes.splice(oiIdx, ciIdx - oiIdx + 1, ...replacement);
        // open-only opener fully consumed by a both closer: set the bottom so
        // a later separate closer cannot look back past the opener just
        // before it (doc-03: *first changes **code**request* — inner ** is
        // open-only + both; cm-410 *foo **bar** baz* has a close-only inner
        // closer, so no bottom and the outer em still forms; doc-01
        // **public as *so*other* option html** — the inner *so* EM also sets
        // the bottom, so the * after "other" (len 1 < outer ** len 2) cannot
        // close the outer **, and the final ** forms the strong)
        const openerFully = openerExcess === 0 && openerLeftover === 0;
        const closerFully = closerOutside === 0;
        if (openerWasOpenOnly && nd.open && openerFully && closerFully && prevSame) {
          bottom[nd.ch] = prevSame;
          bottomLen[nd.ch] = Math.max(opener.len, prevSame.len);
        }
        // continue scanning after the replacement; the leftover opener (if any)
        // is already in the nodes array but not in the openers stack — push it
        if (openerLeftover > 0) {
          const leftNode = nodes[oiIdx];
          if (leftNode && leftNode.t === "delim" && leftNode.open) openers.push(leftNode);
        }
        // a leftover closer must be re-processed: it can still close an
        // earlier opener (e.g. the outer emphasis around a just-formed strong)
        if (closerOutside > 0) {
          j = oiIdx + replacement.length - 1;
        } else {
          j = oiIdx + replacement.length;
        }
        continue;
      }
      // blocked by the bottom: this closer must not pair in the recursion
      // into an emphasis node's kids (doc-11: the * after "parse" was
      // blocked by the bottom in the main pass, so it stays literal even
      // inside the outer strong). Only bottom-blocked closers are marked,
      // not closers that merely found no opener.
      if (blockedByBottom) nd.close = false;
    }
    if (nd.open) openers.push(nd);
    j++;
  }
  // remaining delimiters become literal text (except ~, left for strikethrough)
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd && nd.t === "delim" && nd.ch !== "~") {
      const t = textNode(nd.ch.repeat(nd.len));
      t.raw = nd.ch.repeat(nd.len);
      t.a = nd.a; t.b = nd.b;
      nodes[k] = t;
    }
  }
  // recurse into emphasis nodes' kids
  for (const nd of nodes) {
    if (nd && (nd.t === "em" || nd.t === "strong")) processEmphasis(nd.kids, text);
  }
}

function processStrikethrough(nodes) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = 0; j < nodes.length; j++) {
      const d = nodes[j];
      if (!d || d.t !== "delim" || d.ch !== "~" || !d.close) continue;
      // strikethrough uses a run of 1 or 2 tildes; 3+ is literal
      if (d.len < 1 || d.len > 2) continue;
      // look back for nearest opener of the same length (1 or 2)
      for (let k = j - 1; k >= 0; k--) {
        const o = nodes[k];
        if (!o) continue;
        if (o.t === "delim" && o.ch === "~" && o.open && o.len === d.len) {
          const kids = [];
          for (let m = k + 1; m < j; m++) if (nodes[m]) kids.push(nodes[m]);
          const container = { t: "del", kids, a: o.a, b: d.b };
          nodes.splice(k, j - k + 1, container);
          changed = true;
          break;
        }
        // keep scanning: code spans, emphasis, links can sit inside a del
      }
      if (changed) break;
    }
  }
  // recurse into emphasis nodes' kids (strikethrough can nest inside them)
  for (const nd of nodes) {
    if (nd && (nd.t === "em" || nd.t === "strong" || nd.t === "del")) processStrikethrough(nd.kids);
  }
  // any ~ delimiter left unmatched becomes literal text
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd && nd.t === "delim" && nd.ch === "~") {
      const t = textNode(nd.ch.repeat(nd.len));
      t.raw = nd.ch.repeat(nd.len);
      t.a = nd.a; t.b = nd.b;
      nodes[k] = t;
    }
  }
}

function renderNodes(nodes) {
  let out = "";
  for (const nd of nodes) {
    if (!nd) continue;
    if (nd.t === "text") out += nd.s;
    else if (nd.t === "code") out += "<code>" + nd.s + "</code>";
    else if (nd.t === "html") out += nd.s;
    else if (nd.t === "br") out += "<br>";
    else if (nd.t === "autolink") out += '<a href="' + attrEscape(nd.href) + '">' + attrEscape(nd.display) + "</a>";
    else if (nd.t === "link") {
      out += '<a href="' + attrEscape(nd.href) + '"' + (nd.title !== null && nd.title !== undefined ? ' title="' + attrEscape(nd.title) + '"' : "") + ">" + renderNodes(nd.kids) + "</a>";
    } else if (nd.t === "img") {
      out += '<img src="' + attrEscape(nd.src) + '" alt="' + nd.alt + '"' + (nd.title !== null && nd.title !== undefined ? ' title="' + attrEscape(nd.title) + '"' : "") + ">";
    } else if (nd.t === "em") out += "<em>" + renderNodes(nd.kids) + "</em>";
    else if (nd.t === "strong") out += "<strong>" + renderNodes(nd.kids) + "</strong>";
    else if (nd.t === "del") out += "<del>" + renderNodes(nd.kids) + "</del>";
    else if (nd.t === "bracket") out += nd.img ? "![" : "[";
    else if (nd.t === "delim") out += nd.ch.repeat(nd.len);
  }
  return out;
}

function parseInline(text, refs, entryInAnchor) {
  if (text === "") return "";
  if (entryInAnchor === undefined) entryInAnchor = refs.inAnchor;
  const { nodes, hidden, hasDelim, hasTilde } = scanInline(text, refs, entryInAnchor);
  processLevel(nodes, text, refs, hidden, 0, text.length, entryInAnchor, hasDelim, hasTilde);
  return renderNodes(nodes);
}

// Deferred inline rendering: in the single-pass path refs.jobs is an array;
// push the text and return a placeholder (rendered after the block pass,
// when every link reference definition is known). When refs.jobs is absent
// (the two-pass NUL fallback) render immediately.
function deferInline(text, refs) {
  if (!refs.jobs) return parseInline(text, refs);
  const idx = refs.jobs.length;
  refs.jobs.push(text);
  return "\u0000" + idx + "\u0000";
}
