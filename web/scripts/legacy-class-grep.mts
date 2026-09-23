// legacy-class-grep.mts — DEV-ONLY. Pass 2's P5 proof that a stylesheet's class rules have no
// markup left: it lists every class selector the given sheets define and prints each one
// `web/src` still writes as a class, with every place that writes it. No output, exit 0,
// means no element can match any of those rules.
//
//   node --experimental-strip-types web/scripts/legacy-class-grep.mts <sheet.css>... [--kept <sheet.css>...]
//
// P5 ran it against `web/src/legacy.css` and `web/src/features/audit/audit.css` before
// deleting them. To re-run the proof later, pass their text from git
// (`git show <rev>:web/src/legacy.css > legacy.css`).
//
// "Written as a class" is read from the TypeScript AST, not from text: a grep over text counts
// every comment that mentions `.card` and every data string that happens to be "on". A string
// counts when it can reach a `className`: it is inside a `className={…}` value or a
// `cn(…)`/`cva(…)` call, or it is the value of a top-level constant (`const CELL = {…}`) or the
// body of a top-level function that such a value names. A string that chooses a cva variant
// (`defaultVariants: { variant: "card" }`) is not class text. Inside a counted string:
//  - each whitespace-separated token is a class (`md`);
//  - a template literal's static head before `${` is a PREFIX, so `badge--${tone}` reaches
//    every `.badge--*`;
//  - a `.name` inside an arbitrary Tailwind variant (`[&_.actions]:gap-2`) selects by that
//    class, so it counts too.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
/** The sheets under test, and after `--kept` the sheets that stay: a class a kept sheet also
 *  defines (moved there, or a Tailwind utility of the same name in the built CSS) is listed
 *  apart and does not fail the proof. */
const args = process.argv.slice(2);
const keptAt = args.indexOf("--kept");
const sheets = keptAt < 0 ? args : args.slice(0, keptAt);
const keptSheets = keptAt < 0 ? [] : args.slice(keptAt + 1);
if (sheets.length === 0) {
  console.error("usage: legacy-class-grep.mts <sheet.css>... [--kept <sheet.css>...]");
  process.exit(2);
}

/** Every class a sheet's selectors name. A stretch of the sheet that ends at `{` is a selector
 *  list or an at-rule prelude; one that ends at `}` is declarations, whose numbers (`0.35`)
 *  must not read as classes. */
function classesOf(css: string): Set<string> {
  const out = new Set<string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== "{" && text[at] !== "}") continue;
    if (text[at] === "{") {
      const prelude = text.slice(start, at).replace(/"[^"]*"|'[^']*'/g, "");
      for (const match of prelude.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(match[1]);
    }
    start = at + 1;
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}${name}`;
    if (statSync(path).isDirectory()) return sourceFiles(`${path}/`);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

type Piece = { text: string; prefix: boolean; where: string };

const files = sourceFiles(SRC).map((path) => ({
  path,
  ast: ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
}));

/** Top-level constants and functions by name, across every file: a className names them. */
const declared = new Map<string, ts.Node[]>();
for (const { ast } of files) {
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const each of statement.declarationList.declarations) {
        if (ts.isIdentifier(each.name) && each.initializer !== undefined) {
          declared.set(each.name.text, [...(declared.get(each.name.text) ?? []), each.initializer]);
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
      declared.set(statement.name.text, [...(declared.get(statement.name.text) ?? []), statement.body]);
    }
  }
}

/** The strings under `node` that can become class text, following the names it uses. */
function piecesOf(node: ts.Node, seen: Set<ts.Node>, out: Piece[]): void {
  if (seen.has(node)) return;
  seen.add(node);
  const where = (at: ts.Node): string => {
    const file = at.getSourceFile();
    return `${file.fileName.slice(SRC.length)}:${file.getLineAndCharacterOfPosition(at.getStart()).line + 1}`;
  };
  const visit = (at: ts.Node): void => {
    if (ts.isStringLiteral(at) || ts.isNoSubstitutionTemplateLiteral(at)) {
      // A property KEY is a variant's name, not class text (`{ outline: "…" }`).
      if (at.parent !== undefined && ts.isPropertyAssignment(at.parent) && at.parent.name === at) return;
      out.push({ text: at.text, prefix: false, where: where(at) });
    } else if (ts.isTemplateExpression(at)) {
      out.push({ text: at.head.text, prefix: true, where: where(at) });
      for (const span of at.templateSpans) {
        visit(span.expression);
        out.push({ text: span.literal.text, prefix: false, where: where(at) });
      }
      return;
    } else if (ts.isIdentifier(at) && refersToValue(at)) {
      for (const target of declared.get(at.text) ?? []) piecesOf(target, seen, out);
    } else if (isVariantChoice(at)) {
      return;
    }
    ts.forEachChild(at, visit);
  };
  visit(node);
}

/** Whether an identifier names a constant or function whose strings can be class text: not a
 *  member or key name (`CELL.time`, `{ time: … }`), and not `cn` itself, whose body is
 *  tailwind-merge's configuration of the theme's names rather than classes. */
function refersToValue(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (id.text === "cn") return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  return true;
}

/** Whether a node CHOOSES a cva variant rather than spelling classes: `defaultVariants`, a
 *  `compoundVariants` entry's selectors, and the object handed to a variants function
 *  (`tickVariants({ state: "lock" })`). A `class` or `className` among them is class text. */
function isVariantChoice(node: ts.Node): boolean {
  if (!ts.isPropertyAssignment(node)) return false;
  const name = node.name.getText();
  if (name === "defaultVariants") return true;
  if (name === "class" || name === "className") return false;
  const object = node.parent;
  const holder = object.parent;
  if (ts.isArrayLiteralExpression(holder)) {
    return ts.isPropertyAssignment(holder.parent) && holder.parent.name.getText() === "compoundVariants";
  }
  return (
    ts.isCallExpression(holder) &&
    holder.arguments.includes(object as ts.Expression) &&
    !(ts.isIdentifier(holder.expression) && ["cn", "cva"].includes(holder.expression.text))
  );
}

const pieces: Piece[] = [];
const seen = new Set<ts.Node>();
for (const { ast } of files) {
  const walk = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "className" && node.initializer !== undefined) {
      piecesOf(node.initializer, seen, pieces);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["cn", "cva"].includes(node.expression.text)) {
      for (const argument of node.arguments) piecesOf(argument, seen, pieces);
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
}

const defined = new Map<string, string[]>();
for (const sheet of sheets) {
  for (const name of classesOf(readFileSync(sheet, "utf8"))) {
    defined.set(name, [...(defined.get(name) ?? []), sheet.replace(/^.*[\\/]/, "")]);
  }
}

const hits = new Map<string, Set<string>>();
const hit = (name: string, where: string): void => {
  hits.set(name, (hits.get(name) ?? new Set()).add(where));
};
for (const piece of pieces) {
  const tokens = piece.text.split(/\s+/).filter(Boolean);
  // A template head's LAST token runs into the `${…}` that follows it (`badge--${tone}`).
  const open = piece.prefix && !/\s$/.test(piece.text) ? tokens.pop() : undefined;
  for (const token of tokens) {
    if (defined.has(token)) hit(token, piece.where);
    for (const ref of token.matchAll(/\[[^\]]*?\.([A-Za-z_][\w-]*)/g)) {
      if (defined.has(ref[1])) hit(ref[1], `${piece.where} (selector in ${token})`);
    }
  }
  if (open !== undefined && open.length >= 2) {
    for (const name of defined.keys()) if (name.startsWith(open)) hit(name, `${piece.where} (prefix ${open})`);
  }
}

const kept = new Set(keptSheets.flatMap((sheet) => [...classesOf(readFileSync(sheet, "utf8"))]));
const sorted = [...hits].sort(([a], [b]) => a.localeCompare(b));
const report = (title: string, rows: typeof sorted): void => {
  if (rows.length === 0) return;
  console.log(title);
  for (const [name, where] of rows) {
    console.log(`.${name}  [${defined.get(name)?.join(", ")}]`);
    for (const each of where) console.log(`    ${each}`);
  }
};
const failing = sorted.filter(([name]) => !kept.has(name));
report("written, and defined by no kept sheet:", failing);
report("written, and also defined by a kept sheet:", sorted.filter(([name]) => kept.has(name)));
process.exit(failing.length > 0 ? 1 : 0);
