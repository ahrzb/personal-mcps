// hub-typescript.ts — bounded in-memory TypeScript preflight for QuickJS programs.
//
// The Worker cannot read TypeScript's library files from a filesystem. The checked-in text
// module is the transitive ES2023 declaration graph from the exact runtime compiler version;
// updating `typescript` therefore requires regenerating that file in the same change. The
// compiler sees only that library, the caller's generated program declaration, and one
// submitted function body. It resolves no imports and performs no I/O.

import ts from "typescript";
import standardLibrary from "./quickjs-es2023-lib.txt";
import type { CatalogSnapshot } from "./hub-catalog";
import type { HubExecutionDiagnostic } from "./hub-contract";
import { renderProgramDeclaration } from "./hub-types";
import { HUB_DIAGNOSTIC_MAX, HUB_DIAGNOSTIC_MESSAGE_MAX_BYTES } from "./limits";
import { truncateUtf8 } from "./hub-types";

const PROGRAM_FILE = "program.ts";
const DECLARATION_FILE = "program.d.ts";
const LIBRARY_FILE = "lib.es2023.d.ts";
const PROGRAM_NAME = "__hubProgram";

/** Successful preflight output or bounded user-facing errors. JavaScript is emitted only
 * when syntactic and semantic checking both succeed, so evaluation cannot precede checking. */
export type HubProgramCompilation =
  | { readonly ok: true; readonly javascript: string }
  | { readonly ok: false; readonly diagnostics: readonly HubExecutionDiagnostic[] };

/** Typechecks one submitted function body against the exact caller-visible declaration and
 * emits the JavaScript expression QuickJS evaluates. No source or diagnostic is logged. */
export function compileHubProgram(snapshot: CatalogSnapshot, code: string): HubProgramCompilation {
  const source = `const ${PROGRAM_NAME} = async (): Promise<unknown> => {\n${code}\n};\n${PROGRAM_NAME};\n`;
  const files = new Map<string, string>([
    [PROGRAM_FILE, source],
    [DECLARATION_FILE, renderProgramDeclaration(snapshot)],
    [LIBRARY_FILE, standardLibrary],
  ]);
  const options: ts.CompilerOptions = {
    alwaysStrict: true,
    module: ts.ModuleKind.ESNext,
    noEmitOnError: true,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2023,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => LIBRARY_FILE,
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName);
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    readFile: (fileName) => files.get(fileName),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
  const program = ts.createProgram([...files.keys()], options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    return { ok: false, diagnostics: errors.slice(0, HUB_DIAGNOSTIC_MAX).map((diagnostic) => publicDiagnostic(diagnostic, snapshot)) };
  }

  let javascript = "";
  program.emit(undefined, (fileName, text) => {
    if (fileName === "program.js") javascript = text;
  });
  if (javascript.length === 0) {
    return {
      ok: false,
      diagnostics: [{ category: "error", code: 0, message: "TypeScript emitted no executable program" }],
    };
  }
  return { ok: true, javascript };
}

/**
 * Converts one compiler diagnostic without returning source text or generated filenames.
 * Program locations are translated from the synthetic function's line space to user lines;
 * unknown members of a generated service use the snapshot's short TypeScript names rather
 * than dumping the service's complete structural type.
 */
function publicDiagnostic(diagnostic: ts.Diagnostic, snapshot: CatalogSnapshot): HubExecutionDiagnostic {
  const message = truncateUtf8(
    unknownToolMessage(diagnostic, snapshot) ?? ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    HUB_DIAGNOSTIC_MESSAGE_MAX_BYTES,
  ).text;
  if (diagnostic.file === undefined || diagnostic.start === undefined || diagnostic.file.fileName !== PROGRAM_FILE) {
    return { category: "error", code: diagnostic.code, message };
  }
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    category: "error",
    code: diagnostic.code,
    message,
    line: Math.max(1, location.line),
    column: location.character + 1,
  };
}

/** A concise diagnostic for `mcp.<service>.<misspelling>`, or `null` for every other
 * compiler error. Suggestions are omitted on a distance tie rather than guessed. */
function unknownToolMessage(diagnostic: ts.Diagnostic, snapshot: CatalogSnapshot): string | null {
  if ((diagnostic.code !== 2339 && diagnostic.code !== 2551) || diagnostic.file?.fileName !== PROGRAM_FILE || diagnostic.start === undefined) {
    return null;
  }
  const start = diagnostic.start;
  let node: ts.Node = diagnostic.file;
  while (true) {
    const child = node
      .getChildren(diagnostic.file)
      .find((candidate) => candidate.getStart(diagnostic.file) <= start && start < candidate.getEnd());
    if (child === undefined) break;
    node = child;
  }
  while (node.parent !== undefined && !ts.isPropertyAccessExpression(node.parent)) node = node.parent;
  const access = node.parent;
  if (
    access === undefined ||
    !ts.isPropertyAccessExpression(access) ||
    access.name !== node ||
    !ts.isPropertyAccessExpression(access.expression) ||
    !ts.isIdentifier(access.expression.expression) ||
    access.expression.expression.text !== "mcp"
  ) {
    return null;
  }
  const serviceName = access.expression.name.text;
  const service = snapshot.services.find((candidate) => candidate.typescriptName === serviceName);
  if (service === undefined) return null;
  const toolName = access.name.text;
  const suggestion = closestName(
    toolName,
    service.tools.flatMap((tool) => (tool.typescriptName === null ? [] : [tool.typescriptName])),
  );
  return suggestion === null
    ? `unknown tool ${JSON.stringify(toolName)} on mcp.${serviceName}`
    : `unknown tool ${JSON.stringify(toolName)} on mcp.${serviceName}; did you mean ${JSON.stringify(suggestion)}?`;
}

/** Closest bounded identifier under a conservative edit-distance threshold. */
function closestName(input: string, candidates: readonly string[]): string | null {
  const threshold = Math.max(1, Math.floor(input.length * 0.4) + 1);
  let closest: string | null = null;
  let closestDistance = threshold + 1;
  let tied = false;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
      tied = false;
    } else if (distance === closestDistance) {
      tied = true;
    }
  }
  return tied || closestDistance > threshold ? null : closest;
}

/** Levenshtein distance for bounded TypeScript aliases without allocating a matrix. */
function editDistance(left: string, right: string): number {
  let previous = new Uint16Array(right.length + 1);
  let current = new Uint16Array(right.length + 1);
  for (let column = 0; column <= right.length; column += 1) previous[column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}
