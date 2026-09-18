// hub-compile.ts — test support (not a suite): typechecks generated declaration text with
// the repository's own TypeScript, in memory.
//
// §23.7's contract is "tests compile hostile, recursive, and fallback declarations with
// TypeScript", so the compiler is the oracle — not a string comparison. Files live in a
// virtual host layered over the real lib files, so nothing is written to disk and no
// project config is consulted; `types: []` keeps ambient @types packages out, which is
// exactly the checker environment `program.d.ts` must stand on its own in.
//
// deps: typescript (devDependency) — nothing else.

import ts from "typescript";

/**
 * Typechecks `files` (path → source) and returns flattened diagnostics, empty when every
 * file typechecks. Declaration files may be scripts (global `mcp`) or modules (exported
 * subset declarations); probes are ordinary modules that consume them.
 */
export function compileDiagnostics(files: Readonly<Record<string, string>>): readonly string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  // The compiler asks for candidates it built by joining paths, so keep each virtual file
  // under both its caller spelling and the absolute spelling the module resolver probes.
  // `ts.sys` is the real filesystem underneath (lib files come from there); the compiler
  // host's own `readFile`/`fileExists` are optional members and are replaced wholesale.
  const virtualFiles = new Map<string, string>();
  for (const [fileName, text] of Object.entries(files)) {
    const normalized = fileName.replace(/^\.\//, "").replace(/\\/g, "/");
    virtualFiles.set(normalized, text);
    virtualFiles.set(ts.sys.resolvePath(normalized).replace(/\\/g, "/"), text);
  }
  const virtual = (fileName: string): string | undefined => {
    const normalized = fileName.replace(/^\.\//, "").replace(/\\/g, "/");
    return virtualFiles.get(normalized) ?? virtualFiles.get(ts.sys.resolvePath(normalized).replace(/\\/g, "/"));
  };
  host.fileExists = (fileName) => virtual(fileName) !== undefined || ts.sys.fileExists(fileName);
  const readFile = (fileName: string): string | undefined => virtual(fileName) ?? ts.sys.readFile(fileName);
  host.readFile = readFile;
  host.getSourceFile = (fileName, languageVersion) => {
    const text = readFile(fileName);
    return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const program = ts.createProgram(Object.keys(files), options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    return diagnostic.file === undefined ? message : `${diagnostic.file.fileName}: ${message}`;
  });
}
