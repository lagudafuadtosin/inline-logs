// Adds, comments out, uncomments and removes console calls in a file, using
// TypeScript's own parser, so a "console.log(" inside a string, a template
// or a comment is never touched and a call over several lines is one call.
// Works on offsets in the document text and returns edits, so it is unit
// tested without VS Code. Built into its own file (dist/logedit.js) and
// loaded on first use, as it carries the TypeScript parser.
import ts from "typescript";

/** One change to the document, in offsets into its text before any change. */
export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

/** A part of the file that is script: the whole of a .js or .ts file, the <script> blocks of .svelte, .vue and .html, and an .astro file's frontmatter too. */
export interface Region {
  start: number;
  end: number;
  kind: ts.ScriptKind;
}

export interface Style {
  quote: '"' | "'" | "`";
  semi: boolean;
}

const SCRIPT_LANGS: Record<string, ts.ScriptKind> = {
  javascript: ts.ScriptKind.JS,
  javascriptreact: ts.ScriptKind.JSX,
  typescript: ts.ScriptKind.TS,
  typescriptreact: ts.ScriptKind.TSX,
};
const EXTENSIONS: Record<string, ts.ScriptKind> = {
  ".js": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".ts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
};
const MARKUP = new Set(["svelte", "vue", "html", "astro"]);

/** True for the languages these commands work in. */
export function supports(languageId: string, fileName: string): boolean {
  return languageId in SCRIPT_LANGS || MARKUP.has(languageId) || extOf(fileName) in EXTENSIONS || [".svelte", ".vue", ".html", ".astro"].includes(extOf(fileName));
}

function extOf(fileName: string): string {
  const m = /\.[^./\\]+$/.exec(fileName);
  return m ? m[0].toLowerCase() : "";
}

export function regions(text: string, languageId: string, fileName: string): Region[] {
  const ext = extOf(fileName);
  const whole = SCRIPT_LANGS[languageId] ?? EXTENSIONS[ext];
  if (whole !== undefined && !MARKUP.has(languageId)) return [{ start: 0, end: text.length, kind: whole }];
  const out: Region[] = [];
  if (languageId === "astro" || ext === ".astro") {
    const fm = /^\s*---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (fm) {
      const start = fm.index + fm[0].indexOf(fm[1]);
      out.push({ start, end: start + fm[1].length, kind: ts.ScriptKind.TS });
    }
  }
  const script = /<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi;
  for (let m = script.exec(text); m; m = script.exec(text)) {
    const attrs = m[1] ?? "";
    // Not JavaScript: JSON data, templates.
    if (/\btype\s*=\s*["']?(?!module|text\/javascript|application\/javascript)[^"'\s>]+/i.test(attrs)) continue;
    const start = m.index + m[0].indexOf(">") + 1;
    const ts_ = /\blang\s*=\s*["']?ts\b/i.test(attrs) || languageId === "astro";
    out.push({ start, end: start + m[2].length, kind: ts_ ? ts.ScriptKind.TS : ts.ScriptKind.JS });
  }
  return out;
}

interface Parsed {
  region: Region;
  sf: ts.SourceFile;
}

function parse(text: string, rs: Region[]): Parsed[] {
  return rs.map((region) => ({ region, sf: ts.createSourceFile("x" + kindExt(region.kind), text.slice(region.start, region.end), ts.ScriptTarget.Latest, true, region.kind) }));
}

function kindExt(k: ts.ScriptKind): string {
  return k === ts.ScriptKind.TSX ? ".tsx" : k === ts.ScriptKind.JSX ? ".jsx" : k === ts.ScriptKind.TS ? ".ts" : ".js";
}

/** The quote the file uses most for plain strings, and whether its statements end in semicolons. */
export function detectStyle(text: string, rs: Region[]): Style {
  const quotes = { '"': 0, "'": 0, "`": 0 };
  let withSemi = 0;
  let without = 0;
  for (const { sf } of parse(text, rs)) {
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteral(n) && !ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent)) {
        const q = sf.text[n.getStart(sf)];
        if (q === '"' || q === "'") quotes[q]++;
      } else if (ts.isNoSubstitutionTemplateLiteral(n)) {
        quotes["`"]++;
      } else if (ts.isStringLiteral(n)) {
        const q = sf.text[n.getStart(sf)];
        if (q === '"' || q === "'") quotes[q] += 0.5;
      }
      if (ts.isExpressionStatement(n) || ts.isVariableStatement(n) || ts.isReturnStatement(n)) {
        if (sf.text[n.end - 1] === ";") withSemi++;
        else without++;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const quote = quotes["'"] > quotes['"'] && quotes["'"] >= quotes["`"] ? "'" : quotes["`"] > quotes['"'] && quotes["`"] > quotes["'"] ? "`" : '"';
  return { quote, semi: withSemi >= without };
}

function lineStart(text: string, offset: number): number {
  const i = Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1));
  return i + 1;
}

function lineEnd(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
  return i;
}

function indentAt(text: string, offset: number): string {
  const s = lineStart(text, offset);
  return /^[ \t]*/.exec(text.slice(s, lineEnd(text, s)))![0];
}

function lineOf(text: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] !== "\n")) n++;
  }
  return n;
}

/** The deepest node that holds [pos, end). */
function nodeAt(sf: ts.SourceFile, pos: number, end: number): ts.Node {
  let found: ts.Node = sf;
  const visit = (n: ts.Node) => {
    if (n.getStart(sf) <= pos && end <= n.getEnd()) {
      found = n;
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return found;
}

const LIST_PARENTS = (n: ts.Node) => ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) || ts.isModuleBlock(n);

function bodyBlock(n: ts.Node): ts.Block | undefined {
  // Functions and classes have a body, loops a statement.
  const b = (n as { body?: ts.Node }).body ?? (ts.isIterationStatement(n, false) ? n.statement : ts.isIfStatement(n) ? n.thenStatement : ts.isTryStatement(n) ? n.tryBlock : undefined);
  return b && ts.isBlock(b) ? b : undefined;
}

export interface InsertRequest {
  /** Selection in offsets. An empty one means "the name under the cursor". */
  start: number;
  end: number;
  /** Shown before the expression in the label: the file name. */
  fileLabel: string;
  eol: string;
  /** One level of indentation, from the editor's settings. */
  indentUnit: string;
  /** "log" by default. */
  method?: string;
}

export interface InsertResult {
  edit: TextEdit;
  expression: string;
  /** 0-based line the new log is on. */
  line: number;
}

/**
 * A console.log for the selected expression, or the name under the cursor
 * (with the object it belongs to: a.b.c with the cursor on c), on the line
 * after the statement it is in. Inside a block that statement opens (a
 * function's parameters, a loop's variable, an if's condition), the log
 * goes first in the block. Before a return or throw, as after it would never run.
 */
export function insertLog(text: string, languageId: string, fileName: string, req: InsertRequest): InsertResult | { error: string } {
  const rs = regions(text, languageId, fileName);
  const region = rs.find((r) => r.start <= req.start && req.end <= r.end);
  if (!region) return { error: "put the cursor in JavaScript or TypeScript code" };
  const [{ sf }] = parse(text, [region]);
  const base = region.start;
  const local = { start: req.start - base, end: req.end - base };
  let expression = text.slice(req.start, req.end).trim();
  let target: ts.Node;
  if (expression) {
    target = nodeAt(sf, local.start + (text.slice(req.start, req.end).length - text.slice(req.start, req.end).trimStart().length), local.start + text.slice(req.start, req.end).trimEnd().length);
  } else {
    // The name under the cursor, or right before it.
    let n = nodeAt(sf, local.start, local.start);
    if (!ts.isIdentifier(n) && !ts.isPrivateIdentifier(n) && local.start > 0) n = nodeAt(sf, local.start - 1, local.start - 1);
    if (!ts.isIdentifier(n) && n.kind !== ts.SyntaxKind.ThisKeyword) return { error: "put the cursor on a name or select an expression" };
    while (n.parent && (ts.isPropertyAccessExpression(n.parent) || ts.isPropertyAccessChain?.(n.parent)) && (n.parent as ts.PropertyAccessExpression).name === n) n = n.parent;
    // A declaration's name: the variable itself. A shorthand or destructured name too.
    expression = n.getText(sf);
    target = n;
  }
  // Where it goes.
  let at: { offset: number; indent: string; after: boolean } | undefined;
  for (let n: ts.Node | undefined = target; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isClassElement(n) && !ts.isMethodDeclaration(n) && !ts.isConstructorDeclaration(n) && !ts.isGetAccessor(n) && !ts.isSetAccessor(n)) return { error: "a class field is not a place a log can go" };
    if (ts.isParameter(n)) {
      const fn = n.parent as ts.FunctionLikeDeclaration;
      const body = fn.body;
      if (!body || !ts.isBlock(body)) return { error: "this function has no braces to put a log in" };
      at = blockStart(text, sf, base, body, req.indentUnit);
      break;
    }
    if (n.parent && LIST_PARENTS(n.parent) && ts.isStatement(n)) {
      const body = bodyBlock(n);
      if (body && target.getStart(sf) < body.getStart(sf)) {
        at = blockStart(text, sf, base, body, req.indentUnit);
      } else if (ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isBreakOrContinueStatement(n)) {
        at = { offset: base + lineStart(sf.text, n.getStart(sf)), indent: indentAt(sf.text, n.getStart(sf)), after: false };
      } else {
        at = { offset: base + lineEnd(sf.text, n.getEnd()), indent: indentAt(sf.text, n.getStart(sf)), after: true };
      }
      break;
    }
  }
  if (!at) return { error: "no statement to put a log after" };
  const style = detectStyle(text, rs);
  const line = lineOf(text, at.offset) + (at.after ? 1 : 0);
  const label = `${req.fileLabel}:${line + 1} ${expression.replace(/\s+/g, " ")}`;
  const call = `console.${req.method ?? "log"}(${quote(label, style.quote)}, ${expression})${style.semi ? ";" : ""}`;
  const newText = at.after ? `${req.eol}${at.indent}${call}` : `${at.indent}${call}${req.eol}`;
  return { edit: { start: at.offset, end: at.offset, newText }, expression, line };
}

function blockStart(_text: string, sf: ts.SourceFile, base: number, body: ts.Block, unit: string): { offset: number; indent: string; after: boolean } {
  const open = body.getStart(sf);
  const first = body.statements[0];
  const firstOnOwnLine = first && lineOf(sf.text, first.getStart(sf)) > lineOf(sf.text, open);
  const indent = firstOnOwnLine ? indentAt(sf.text, first.getStart(sf)) : indentAt(sf.text, open) + unit;
  return { offset: base + lineEnd(sf.text, open), indent, after: true };
}

function quote(s: string, q: Style["quote"]): string {
  const body = s.replace(/\\/g, "\\\\").replace(q === "`" ? /`|\$\{/g : new RegExp(q, "g"), (m) => "\\" + m);
  return q + body + q;
}

// ---- finding real console calls ------------------------------------------

export interface ConsoleCall {
  /** The call, in document offsets. */
  start: number;
  end: number;
  /** The statement it is the whole of, when it is one (document offsets). */
  statement?: { start: number; end: number; inList: boolean };
  /** The arrow function it is the whole body of: () => console.log(x). */
  arrowBody?: boolean;
  method: string;
}

function isConsoleCall(n: ts.Node): n is ts.CallExpression {
  if (!ts.isCallExpression(n)) return false;
  const e = n.expression;
  return (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "console") || (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "console" && ts.isStringLiteralLike(e.argumentExpression));
}

function methodOf(n: ts.CallExpression): string {
  const e = n.expression;
  return ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : "";
}

/** Every console.<method>(...) call in the file's code, outermost only (a console call inside another one goes with it). */
export function findConsoleCalls(text: string, languageId: string, fileName: string): ConsoleCall[] {
  const out: ConsoleCall[] = [];
  for (const { region, sf } of parse(text, regions(text, languageId, fileName))) {
    const base = region.start;
    const visit = (n: ts.Node) => {
      if (isConsoleCall(n)) {
        const p = n.parent;
        const c: ConsoleCall = { start: base + n.getStart(sf), end: base + n.getEnd(), method: methodOf(n) };
        if (p && ts.isExpressionStatement(p) && p.expression === n) c.statement = { start: base + p.getStart(sf), end: base + p.getEnd(), inList: !!p.parent && LIST_PARENTS(p.parent) };
        else if (p && ts.isArrowFunction(p) && p.body === n) c.arrowBody = true;
        out.push(c);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

export interface EditResult {
  edits: TextEdit[];
  /** Calls changed. */
  done: number;
  /** Calls left alone: part of a bigger expression, so they cannot go without changing what the code does. */
  skipped: number;
}

/** Text before `start` on its line is only spaces, and after `end` only spaces or a // comment. */
function aloneOnLines(text: string, start: number, end: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStart(text, start), start)) && /^[ \t]*(\/\/.*)?$/.test(text.slice(end, lineEnd(text, end)));
}

/** Each console call that is a statement of its own becomes a // comment (a /* *\/ one when it shares its line with other code). */
export function commentOut(text: string, languageId: string, fileName: string): EditResult {
  const edits: TextEdit[] = [];
  let skipped = 0;
  let done = 0;
  for (const c of findConsoleCalls(text, languageId, fileName)) {
    const s = c.statement;
    if (!s || !s.inList) {
      skipped++;
      continue;
    }
    done++;
    if (aloneOnLines(text, s.start, s.end)) {
      const column = s.start - lineStart(text, s.start);
      for (let ls = lineStart(text, s.start); ls <= s.end; ) {
        const le = lineEnd(text, ls);
        const lead = /^[ \t]*/.exec(text.slice(ls, le))![0].length;
        edits.push({ start: ls + Math.min(column, lead), end: ls + Math.min(column, lead), newText: "// " });
        if (le >= text.length) break;
        ls = le + (text[le] === "\r" && text[le + 1] === "\n" ? 2 : 1);
        if (ls > s.end) break;
      }
    } else if (!text.slice(s.start, s.end).includes("*/")) {
      edits.push({ start: s.start, end: s.start, newText: "/* " }, { start: s.end, end: s.end, newText: " */" });
    } else {
      done--;
      skipped++;
    }
  }
  return { edits, done, skipped };
}

/** Each console call that is a statement of its own goes, with its line when it has the line to itself. A call that is a whole arrow body becomes {}. */
export function removeAll(text: string, languageId: string, fileName: string): EditResult {
  const edits: TextEdit[] = [];
  let skipped = 0;
  let done = 0;
  for (const c of findConsoleCalls(text, languageId, fileName)) {
    const s = c.statement;
    if (s && s.inList) {
      if (aloneOnLines(text, s.start, s.end)) {
        const from = lineStart(text, s.start);
        let to = lineEnd(text, s.end);
        to += text[to] === "\r" && text[to + 1] === "\n" ? 2 : to < text.length ? 1 : 0;
        // The last line of the file: take the line break before it instead.
        const start = to >= text.length && from > 0 && text[to - 1] !== "\n" ? from - (text[from - 2] === "\r" ? 2 : 1) : from;
        edits.push({ start, end: to, newText: "" });
      } else {
        let end = s.end;
        while (text[end] === " " || text[end] === "\t") end++;
        edits.push({ start: s.start, end, newText: "" });
      }
      done++;
    } else if (s) {
      // The whole body of an if, a loop or a label: an empty block keeps the code's shape.
      edits.push({ start: s.start, end: s.end, newText: "{}" });
      done++;
    } else if (c.arrowBody) {
      edits.push({ start: c.start, end: c.end, newText: "{}" });
      done++;
    } else {
      skipped++;
    }
  }
  return { edits, done, skipped };
}

interface CommentRange {
  start: number;
  end: number;
  multi: boolean;
}

/** Every comment in the code, found where the parser finds them (never inside a string or a template). */
function comments(text: string, languageId: string, fileName: string): CommentRange[] {
  const seen = new Map<number, CommentRange>();
  for (const { region, sf } of parse(text, regions(text, languageId, fileName))) {
    const add = (rs: ts.CommentRange[] | undefined) => {
      for (const r of rs ?? []) seen.set(region.start + r.pos, { start: region.start + r.pos, end: region.start + r.end, multi: r.kind === ts.SyntaxKind.MultiLineCommentTrivia });
    };
    const visit = (n: ts.Node) => {
      add(ts.getLeadingCommentRanges(sf.text, n.pos));
      add(ts.getTrailingCommentRanges(sf.text, n.end));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    add(ts.getLeadingCommentRanges(sf.text, sf.endOfFileToken.pos));
  }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

/** True when `code` is exactly one statement that is a console call, with no syntax errors. */
function isConsoleStatement(code: string): boolean {
  const sf = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (errors.length || sf.statements.length !== 1) return false;
  const st = sf.statements[0];
  return ts.isExpressionStatement(st) && isConsoleCall(st.expression);
}

/** Commented-out console calls back to code: // runs over one or more lines, and /* *\/ comments. */
export function uncomment(text: string, languageId: string, fileName: string): EditResult {
  const edits: TextEdit[] = [];
  let done = 0;
  const all = comments(text, languageId, fileName);
  // Line comments that have their line to themselves, in runs of neighbouring lines.
  const lineComments = all.filter((c) => !c.multi && /^[ \t]*$/.test(text.slice(lineStart(text, c.start), c.start)));
  const body = (c: CommentRange) => text.slice(c.start + 2, c.end).replace(/^ /, "");
  for (let i = 0; i < lineComments.length; i++) {
    if (!/^\s*console\s*(\.|\[)/.test(body(lineComments[i]))) continue;
    for (let j = i; j < Math.min(lineComments.length, i + 80); j++) {
      if (j > i && lineOf(text, lineComments[j].start) !== lineOf(text, lineComments[j - 1].start) + 1) break;
      const code = lineComments
        .slice(i, j + 1)
        .map(body)
        .join("\n");
      if (isConsoleStatement(code)) {
        for (const c of lineComments.slice(i, j + 1)) edits.push({ start: c.start, end: c.start + (text[c.start + 2] === " " ? 3 : 2), newText: "" });
        done++;
        i = j;
        break;
      }
    }
  }
  for (const c of all) {
    if (!c.multi) continue;
    const inner = text.slice(c.start + 2, c.end - 2);
    if (/^\s*console\s*(\.|\[)/.test(inner) && isConsoleStatement(inner.trim())) {
      edits.push({ start: c.start, end: c.end, newText: inner.replace(/^ /, "").replace(/ $/, "") });
      done++;
    }
  }
  return { edits, done, skipped: 0 };
}
