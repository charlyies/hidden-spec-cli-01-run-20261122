// main.ts is mend, the CLI SPEC.md specifies. It implements every section of
// SPEC.md: the command line, the output and exit codes, safe paths, format
// detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

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

/** A file as lines plus its own line break and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves applied by edits that succeeded, in order: [old, new]. */
  readonly moves: Array<[string, string]> = [];
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

// ---- three-tier line matching (SPEC section 5) ----

const TIERS = [0, 1, 2];

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], want: string[], tier: number): number[] {
  const nWant = want.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (normLine(lines[i + j]!, tier) !== nWant[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(lines: string[], want: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of strict ? [0] : TIERS) {
    const occ = occurrences(lines, want, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** One body line of a hunk or chunk. rawEmpty: the patch line was literally empty. */
interface BodyLine {
  kind: string;
  text: string;
  rawEmpty: boolean;
}

/** Old lines O and new lines N of one hunk/chunk/block; ctxN[j] is the index in O of N[j] when N[j] is a context line, else -1. */
interface ON {
  O: string[];
  N: string[];
  ctxN: number[];
}

function onFromBody(body: BodyLine[]): ON {
  const O: string[] = [];
  const N: string[] = [];
  const ctxN: number[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      ctxN.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      ctxN.push(-1);
      N.push(b.text);
    }
  }
  return { O, N, ctxN };
}

/** Replace the O lines at pos with N, honouring context lines and tier-2 re-indent. */
function spliceLines(fileLines: string[], pos: number, O: string[], N: string[], ctxN: number[], tier: number): string[] {
  const out = fileLines.slice(0, pos);
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWs(fileLines[pos]!);
    P = leadingWs(O[0]!);
  }
  for (let j = 0; j < N.length; j++) {
    const cj = ctxN[j]!;
    if (cj >= 0) {
      out.push(fileLines[pos + cj]!);
    } else {
      let l = N[j]!;
      if (tier === 2 && l !== '' && l.trim() !== '' && l.startsWith(P)) l = F + l.slice(P.length);
      out.push(l);
    }
  }
  for (let k = pos + O.length; k < fileLines.length; k++) out.push(fileLines[k]!);
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastCtxOrPlusNoNL(body: BodyLine[]): boolean {
  for (let bi = body.length - 1; bi >= 0; bi--) {
    const b = body[bi]!;
    if (b.kind === ' ' || b.kind === '+') {
      return bi + 1 < body.length && body[bi + 1]!.kind === '\\';
    }
  }
  return false;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** Apply unified hunks in order to a file model (SPEC section 6). */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N, ctxN } = onFromBody(h.body);
    const noNL = lastCtxOrPlusNoNL(h.body);
    if (O.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...N);
      if (atEnd) model.finalBreak = !noNL;
      d += N.length;
    } else {
      const found = findTier(model.lines, O, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const runsToEnd = best + O.length === model.lines.length;
      model.lines = spliceLines(model.lines, best, O, N, ctxN, found.tier);
      if (runsToEnd) model.finalBreak = !noNL;
      d += N.length - O.length;
    }
  }
}

// ---- unified diffs (SPEC section 6) ----

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  dashSet: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Path from a `--- ` / `+++ ` header line: after the four characters, up to the first tab, trimmed; /dev/null is no file; a leading a/ or b/ is removed. */
function dashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const kind = sec.isCreate || sec.oldPath === null ? 'create' : sec.isDelete || sec.newPath === null ? 'delete' : sec.oldPath !== sec.newPath ? 'move' : 'change';
    if (kind === 'create') {
      const p = sec.newPath;
      if (p === null) throw new Fail('unsafe', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      let noNL = false;
      for (const h of sec.hunks) {
        for (let bi = 0; bi < h.body.length; bi++) {
          const b = h.body[bi]!;
          if (b.kind === '+') {
            outLines.push(b.text);
            noNL = bi + 1 < h.body.length && h.body[bi + 1]!.kind === '\\';
          }
        }
      }
      tree.now.set(p, outLines.length === 0 ? '' : outLines.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const p = sec.oldPath;
      if (p === null) throw new Fail('unsafe', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (kind === 'move') {
      const oldP = sec.oldPath!;
      const newP = sec.newPath!;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const model = parseFile(before);
      applyHunks(model, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeFile(model));
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = sec.oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = parseFile(before);
    applyHunks(model, sec.hunks, strict, p);
    tree.now.set(p, serializeFile(model));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let curHunk: Hunk | null = null;
  let inBody = false;
  let headerSeen = false;
  const flushHunk = (): void => {
    if (curHunk !== null && cur !== null) {
      while (curHunk.body.length > 0 && curHunk.body[curHunk.body.length - 1]!.rawEmpty) curHunk.body.pop();
      cur.hunks.push(curHunk);
      curHunk = null;
    }
    inBody = false;
  };
  const startSection = (oldP: string | null, newP: string | null): void => {
    flushHunk();
    if (cur !== null) sections.push(cur);
    cur = { oldPath: oldP, newPath: newP, dashSet: false, isCreate: false, isDelete: false, hunks: [] };
    headerSeen = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inBody) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        flushHunk();
      } else if (line === '') {
        curHunk!.body.push({ kind: ' ', text: '', rawEmpty: true });
        i++;
        continue;
      } else {
        const c = line[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          curHunk!.body.push({ kind: c, text: c === '\\' ? line : line.slice(1), rawEmpty: false });
          i++;
          continue;
        }
        flushHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !headerSeen) {
        cur.oldPath = dashPath(line);
        cur.newPath = dashPath(lines[i + 1]!);
        cur.dashSet = true;
      } else {
        startSection(dashPath(line), dashPath(lines[i + 1]!));
        cur!.dashSet = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      flushHunk();
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      inBody = true;
      headerSeen = true;
      i++;
      continue;
    }
    if (cur !== null && !headerSeen) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ') && !cur.dashSet) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !cur.dashSet) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  flushHunk();
  if (cur !== null) sections.push(cur);
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

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
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    model.lines = spliceLines(model.lines, pos, oldLines, newLines, newLines.map(() => -1), found.tier);
    tree.now.set(path, serializeFile(model));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type V4ASection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | undefined; chunks: V4AChunk[] };

function applyV4AChunks(model: FileModel, chunks: V4AChunk[], strict: boolean, failPath: string): void {
  let cursor = 0;
  const tiers = strict ? [0] : TIERS;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      let found = -1;
      for (const tier of tiers) {
        for (let i = cursor; i < model.lines.length; i++) {
          if (normLine(model.lines[i]!, tier) === normLine(chunk.anchor, tier)) {
            found = i;
            break;
          }
        }
        if (found >= 0) break;
      }
      if (found < 0) throw new Fail('no-match', failPath);
      cursor = found + 1;
    }
    const { O, N, ctxN } = onFromBody(chunk.body);
    if (O.length === 0) {
      const pos = chunk.eof ? model.lines.length : cursor;
      model.lines.splice(pos, 0, ...N);
      cursor = pos + N.length;
    } else {
      let foundTier = -1;
      let foundPos = -1;
      for (const tier of tiers) {
        const occ = occurrences(model.lines, O, tier).filter((p) => p >= cursor && (!chunk.eof || p + O.length === model.lines.length));
        if (occ.length > 0) {
          foundTier = tier;
          foundPos = occ[0]!;
          break;
        }
      }
      if (foundPos < 0) throw new Fail('no-match', failPath);
      model.lines = spliceLines(model.lines, foundPos, O, N, ctxN, foundTier);
      cursor = foundPos + N.length;
    }
  }
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = parseFile(before);
    applyV4AChunks(model, sec.chunks, strict, sec.path);
    const out = serializeFile(model);
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

const V4A_START = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = V4A_START.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kindWord = m[1]!;
    const path = m[2]!.trim();
    const headerIdx = i;
    i++;
    const raw: Array<[number, string]> = [];
    while (i < last) {
      const l = lines[i]!;
      if (V4A_START.test(l)) break;
      raw.push([i, l]);
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]![1])) raw.pop();
    if (kindWord === 'Add File') {
      const fileLines: string[] = [];
      for (const [idx, l] of raw) {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aEdit({ kind: 'add', path, fileLines }, strict));
    } else if (kindWord === 'Delete File') {
      for (const [idx, l] of raw) {
        if (!blank(l)) throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aEdit({ kind: 'delete', path }, strict));
    } else {
      let k = 0;
      let moveTo: string | undefined;
      if (k < raw.length && raw[k]![1].startsWith('*** Move to: ')) {
        moveTo = raw[k]![1].slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      let haveChunk = false;
      for (; k < raw.length; k++) {
        const [idx, l] = raw[k]!;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(curChunk);
          haveChunk = true;
        } else if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${idx + 1}`);
          curChunk.eof = true;
          curChunk = null;
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (!haveChunk) {
              curChunk = { anchor: null, eof: false, body: [] };
              chunks.push(curChunk);
              haveChunk = true;
            } else {
              throw new Exit2(`error: parse ${idx + 1}`);
            }
          }
          curChunk.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), rawEmpty: l === '' });
        } else {
          throw new Exit2(`error: parse ${idx + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headerIdx + 1}`);
      edits.push(v4aEdit({ kind: 'update', path, moveTo, chunks }, strict));
    }
  }
  return edits;
}

// ---- JSON edits (SPEC section 9) ----

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

// ---- run (SPEC sections 1, 2, 10) ----

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string; write: { p: string; now: string | null } | null }> = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}`, write: null });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, write: { p, now } });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
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
