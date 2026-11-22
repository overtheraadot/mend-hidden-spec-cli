// main.ts is mend, the CLI SPEC.md specifies. It implements the whole of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three-tier line matcher, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines without breaks, and whether it ends with one (SPEC.md section 3). */
class Lines {
  readonly br: string;
  readonly lines: string[];
  finalBreak: boolean;
  constructor(br: string, lines: string[], finalBreak: boolean) {
    this.br = br;
    this.lines = lines;
    this.finalBreak = finalBreak;
  }
  static fromText(text: string): Lines {
    if (text === '') return new Lines('\n', [], false);
    const nl = text.indexOf('\n');
    const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
    const lines = text.split(br);
    let finalBreak = false;
    if (text.endsWith(br)) {
      lines.pop();
      finalBreak = true;
    }
    return new Lines(br, lines, finalBreak);
  }
  toText(): string {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.br) + (this.finalBreak ? this.br : '');
  }
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in order: used to print R lines instead of a D/A pair. */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines. One shared tier matcher for unified hunks,
// SEARCH/REPLACE blocks and V4A chunks.
// ---------------------------------------------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where the lines o occur in lines at the tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which o occurs in lines, with its occurrences; null when it occurs at no tier. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  ctx: boolean;
  /** Index of the context line inside O; -1 for a new line. */
  oIndex: number;
  text: string;
}

/** Resolve the lines of N at a match at position pos and tier tier (section 5). */
function resolveN(file: Lines, o: string[], n: NLine[], pos: number, tier: number): string[] {
  if (tier !== 2) return n.map((x) => (x.ctx ? file.lines[pos + x.oIndex]! : x.text));
  const f = leadWs(file.lines[pos]!);
  const p = leadWs(o[0]!);
  return n.map((x) => {
    if (x.ctx) return file.lines[pos + x.oIndex]!;
    if (x.text === '' || /^[ \t]+$/.test(x.text)) return x.text;
    return x.text.startsWith(p) ? f + x.text.slice(p.length) : x.text;
  });
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface UBodyItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}
interface UHunk {
  /** The old start A from the header (1-based). */
  a: number;
  body: UBodyItem[];
}
interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** The path after `--- ` / `+++ ` (up to the first tab, spaces removed, a/ or b/ removed); null for /dev/null. */
function headerPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function newUSection(diffOld: string | null, diffNew: string | null): USection {
  return { diffOld, diffNew, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
}

/**
 * Parse one section's header and hunks starting at `start`, returning the index of the next section's
 * first line (or the end of the patch). Throws Exit2 on a parse fault.
 */
function parseUnifiedSection(lines: string[], start: number, sec: USection): number {
  const n = lines.length;
  const nextIsPlusPlus = (j: number): boolean => (lines[j] ?? '').startsWith('+++ ');
  let i = start;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (sec.hunks.length > 0 && line.startsWith('--- ') && nextIsPlusPlus(i + 1)) return i;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: Number(m[1]), body: [] };
      sec.hunks.push(hunk);
      i += 1;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && nextIsPlusPlus(i + 1)) break;
        if (b.startsWith('@@')) break;
        if (b === '') {
          hunk.body.push({ kind: 'ctx', text: '' });
          i += 1;
        } else if (b[0] === ' ') {
          hunk.body.push({ kind: 'ctx', text: b.slice(1) });
          i += 1;
        } else if (b[0] === '-') {
          hunk.body.push({ kind: 'del', text: b.slice(1) });
          i += 1;
        } else if (b[0] === '+') {
          hunk.body.push({ kind: 'add', text: b.slice(1) });
          i += 1;
        } else if (b[0] === '\\') {
          hunk.body.push({ kind: 'bs', text: b.slice(1) });
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (sec.hunks.length === 0) {
      if (line.startsWith('--- ')) {
        if (nextIsPlusPlus(i + 1)) {
          if (sec.pairOld === null && sec.pairNew === null) {
            sec.pairOld = headerPath(line.slice(4));
            sec.pairNew = headerPath(lines[i + 1]!.slice(4));
          }
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (sec.renameFrom === null) sec.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (sec.renameTo === null) sec.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  return i;
}

function unifiedSections(lines: string[]): USection[] {
  const sections: USection[] = [];
  const n = lines.length;
  const nextIsPlusPlus = (j: number): boolean => (lines[j] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec = newUSection(m[1]!, m[2]!);
      sections.push(sec);
      i = parseUnifiedSection(lines, i + 1, sec);
    } else if (line.startsWith('--- ') && nextIsPlusPlus(i + 1)) {
      const sec = newUSection(null, null);
      sections.push(sec);
      i = parseUnifiedSection(lines, i, sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text; throws Fail on the first hunk that fails. */
function applyUnifiedHunks(before: string, hunks: UHunk[], strict: boolean, path: string): string {
  const file = Lines.fromText(before);
  let d = 0;
  for (const hunk of hunks) {
    const o: string[] = [];
    const n: NLine[] = [];
    for (const item of hunk.body) {
      if (item.kind === 'ctx') {
        o.push(item.text);
        n.push({ ctx: true, oIndex: o.length - 1, text: item.text });
      } else if (item.kind === 'del') o.push(item.text);
      else if (item.kind === 'add') n.push({ ctx: false, oIndex: -1, text: item.text });
    }
    let lastCtxAdd = -1;
    for (let k = 0; k < hunk.body.length; k++) {
      if (hunk.body[k]!.kind === 'ctx' || hunk.body[k]!.kind === 'add') lastCtxAdd = k;
    }
    const noEol = lastCtxAdd >= 0 && hunk.body[lastCtxAdd + 1]?.kind === 'bs';
    if (o.length === 0) {
      const pos = Math.min(hunk.a + d, file.lines.length);
      const wasEnd = pos === file.lines.length;
      const ins = n.map((x) => x.text);
      file.lines.splice(pos, 0, ...ins);
      if (wasEnd) file.finalBreak = !noEol;
      d += n.length;
      continue;
    }
    const found = findTier(file.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + o.length === file.lines.length;
    const resolved = resolveN(file, o, n, best, found.tier);
    file.lines.splice(best, o.length, ...resolved);
    if (atEnd) file.finalBreak = !noEol;
    d += n.length - o.length;
  }
  return file.toText();
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const norm = (p: string | null): string | null => (p === null || p === '/dev/null' ? null : p);
  const oldPath = norm(sec.pairOld ?? sec.renameFrom ?? sec.diffOld);
  const newPath = norm(sec.pairNew ?? sec.renameTo ?? sec.diffNew);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    const isCreate = oldPath === null || sec.newFile;
    const isDelete = newPath === null || sec.deletedFile;
    if (isCreate) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const added: string[] = [];
      let lastAddNoEol = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const item = h.body[k]!;
          if (item.kind === 'add') {
            added.push(item.text);
            lastAddNoEol = h.body[k + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(newPath, added.length === 0 ? '' : added.join('\n') + (lastAddNoEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldPath === null) return;
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || newPath === null) return;
    if (oldPath !== newPath) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const after = applyUnifiedHunks(tree.get(oldPath)!, sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, after);
      tree.moves.push({ old: oldPath, new: newPath });
      return;
    }
    if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
    const after = applyUnifiedHunks(tree.get(oldPath)!, sec.hunks, strict, oldPath);
    tree.now.set(oldPath, after);
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = Lines.fromText(before);
    const found = findTier(file.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NLine[] = newLines.map((t) => ({ ctx: false, oIndex: -1, text: t }));
    const resolved = resolveN(file, oldLines, n, pos, found.tier);
    file.lines.splice(pos, oldLines.length, ...resolved);
    tree.now.set(path, file.toText());
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = searchLine - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = searchLine + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  /** The @@ anchor, null when the chunk started at a body line; '' is no anchor. */
  anchor: string | null;
  /** Body lines as written: ' ' / '-' / '+' prefixed, or '' for an empty context line. */
  body: string[];
  eof: boolean;
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** The first line at or after `from` equal to the anchor, at the first tier with one; null when none. */
function findSingleLine(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** The first occurrence of o at or after `from`, at the first tier with one (an EOF chunk takes only
 *  an occurrence ending at the file's last line); null when none. */
function findOccFrom(lines: string[], o: string[], from: number, eof: boolean, strict: boolean): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (const p of occurrences(lines, o, t)) {
      if (p < from) continue;
      if (eof && p + o.length !== lines.length) continue;
      return { pos: p, tier: t };
    }
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const file = Lines.fromText(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const at = findSingleLine(file.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const b of chunk.body) {
        if (b === '') {
          o.push('');
          n.push({ ctx: true, oIndex: o.length - 1, text: '' });
        } else if (b[0] === ' ') {
          const t = b.slice(1);
          o.push(t);
          n.push({ ctx: true, oIndex: o.length - 1, text: t });
        } else if (b[0] === '-') o.push(b.slice(1));
        else if (b[0] === '+') n.push({ ctx: false, oIndex: -1, text: b.slice(1) });
      }
      if (o.length === 0) {
        const at = chunk.eof ? file.lines.length : cursor;
        const ins = n.map((x) => x.text);
        file.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = findOccFrom(file.lines, o, cursor, chunk.eof, strict);
      if (found === null) throw new Fail('no-match', path);
      const resolved = resolveN(file, o, n, found.pos, found.tier);
      file.lines.splice(found.pos, o.length, ...resolved);
      cursor = found.pos + resolved.length;
    }
    const out = file.toText();
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// Collect one V4A section's lines (with their 1-based line numbers), stopping
// before the next section start or the End Patch line. Blank lines at the end
// of a section are not part of it (SPEC.md section 8), so they are dropped.
function collectV4aSection(lines: string[], start: number, end: number): { sec: { text: string; no: number }[]; next: number } {
  const sec: { text: string; no: number }[] = [];
  let i = start;
  while (i < end && !isV4aSectionStart(lines[i]!)) {
    sec.push({ text: lines[i]!, no: i + 1 });
    i += 1;
  }
  while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
  return { sec, next: i };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let m = /^\*\*\* Add File: (.*)$/.exec(line);
    if (m !== null) {
      const path = m[1]!.trim();
      const { sec, next } = collectV4aSection(lines, i + 1, end);
      i = next;
      const content: string[] = [];
      for (const s of sec) {
        if (s.text === '') content.push('');
        else if (s.text.startsWith('+')) content.push(s.text.slice(1));
        else throw new Exit2(`error: parse ${s.no}`);
      }
      edits.push(v4aAddEdit(path, content));
      continue;
    }
    m = /^\*\*\* Delete File: (.*)$/.exec(line);
    if (m !== null) {
      const path = m[1]!.trim();
      const { sec, next } = collectV4aSection(lines, i + 1, end);
      i = next;
      for (const s of sec) {
        if (!blank(s.text)) throw new Exit2(`error: parse ${s.no}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    m = /^\*\*\* Update File: (.*)$/.exec(line);
    if (m !== null) {
      const path = m[1]!.trim();
      const updateNo = i + 1;
      const { sec, next } = collectV4aSection(lines, i + 1, end);
      i = next;
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenChunk = false;
      for (let k = 0; k < sec.length; k++) {
        const s = sec[k]!;
        const t = s.text;
        if (k === 0 && t.startsWith('*** Move to: ')) {
          moveTo = t.slice('*** Move to: '.length).trim();
          continue;
        }
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          seenChunk = true;
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${s.no}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (!seenChunk) {
              cur = { anchor: null, body: [], eof: false };
              chunks.push(cur);
              seenChunk = true;
            } else throw new Exit2(`error: parse ${s.no}`);
          }
          cur.body.push(t);
          continue;
        }
        throw new Exit2(`error: parse ${s.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 10: order and atomicity; section 1: invocation; section 2: output.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedSections(lines).map((s) => unifiedEdit(s, strict))
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A successful move prints `R <old> -> <new>` (sorted by <new>) instead of that pair's D and A lines.
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  const seenR = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const wasNew = tree.original(mv.new);
    const nowOld = tree.now.has(mv.old) ? tree.now.get(mv.old)! : wasOld;
    const nowNew = tree.now.has(mv.new) ? tree.now.get(mv.new)! : wasNew;
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      const k = `${mv.old}\0${mv.new}`;
      if (seenR.has(k)) continue;
      seenR.add(k);
      rOld.add(mv.old);
      rNew.add(mv.new);
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
    }
  }
  for (const p of changed) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
