/**
 * cli/src/errors.ts — the frozen error contract (§10 "Errors"): one error type, one
 * renderer, one did-you-mean helper. The code vocabulary below is FROZEN — prose may be
 * reworded, a code may never be renamed, and the human/JSON grammar `emitError` produces
 * is what every agent driving this CLI parses (§8: column-0 `error:`/`usage:`/`hint:`
 * prefixes, never line counts).
 *
 * deps: none
 */

/** §10's stable snake_case code vocabulary. `usage` is the sole exit-2 code; every other
 * code exits 1 (a well-formed command that fails at runtime or on the wire, never a
 * malformed one). The vocabulary may grow; these nine may never be renamed. */
export type CliErrorCode =
  | "usage"
  | "not_found"
  | "invalid_arguments"
  | "unauthenticated"
  | "ambiguous_id"
  | "approval_required"
  | "remote_error"
  | "login_timeout"
  | "no_url"
  /** A destructive command with no terminal to ask and no `--yes` (§10's non-TTY refusal).
   * Added 2026-09-01 by the CLI DX migration — the vocabulary may grow, and §10 gives that
   * refusal an exit status (1) and a stderr home but no code of its own; without one it
   * would be the only failure that cannot ride the `--json` error document. */
  | "confirmation_required";

/** Extra fields the JSON error document may carry, per code (§10): a not_found/invalid_arguments
 * suggestion, and the tool's expected-arguments schema rendered from `inputSchema`. */
export type CliErrorExtra = {
  didYouMean?: string;
  expectedArguments?: unknown;
  [key: string]: unknown;
};

export type CliErrorOptions = {
  /** Shown after the message, human form only, as one `usage: …` line (§10's grammar). */
  usage?: string;
  /** Zero or more `hint: …` lines — the JSON form's `hint` field is the FIRST of these. */
  hints?: string[];
  /** Human-only indented lines under the error line (did-you-mean, an arguments table…);
   * each entry may itself be multi-line — every line is indented uniformly by `emitError`. */
  detail?: string[];
  extra?: CliErrorExtra;
};

/**
 * The one error type every command throws to report a stable, agent-parseable failure.
 * `exitCode` is derived from `code` at construction — `usage` is 2, everything else 1
 * (§10) — so a caller never has to keep the two in sync by hand.
 */
export class CliError extends Error {
  code: CliErrorCode;
  exitCode: 1 | 2;
  usage?: string;
  hints: string[];
  detail: string[];
  extra?: CliErrorExtra;

  constructor(code: CliErrorCode, message: string, opts: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = code === "usage" ? 2 : 1;
    this.usage = opts.usage;
    this.hints = opts.hints ?? [];
    this.detail = opts.detail ?? [];
    this.extra = opts.extra;
  }
}

/** Any thrown value, normalized to a CliError: a CliError passes through unchanged; an
 * unexpected Error (a hub failure that never got its own code, a network exception) becomes
 * a bare `remote_error` carrying its message — never a stack trace, never `undefined`. */
function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof Error) return new CliError("remote_error", err.message);
  return new CliError("remote_error", String(err));
}

/** Indents every line of `text` by `spaces` — a detail entry may already be a multi-line
 * block (an arguments table under a did-you-mean line) whose own relative indentation
 * must survive being nested one level deeper under the error line. */
function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

export type EmitErrorOptions = {
  /** `--json`: stderr carries one `{"error":{...}}` document instead of the human grammar. */
  json: boolean;
  /** Always stderr in practice (§10) — a plain `{ write(text: string): void }` is enough. */
  stream: { write(text: string): void };
};

/**
 * Renders `err` to `opts.stream` per §10's grammar and returns the process exit code, so a
 * caller does one `process.exitCode = emitError(err, { json, stream: process.stderr })`.
 *
 * Human form: `error: <code>: <message>`, then each `detail` entry indented 2 spaces
 * (column-0 is reserved for `error:`/`usage:`/`hint:` — every other line is human detail
 * attached to the line above it, §8), then one `usage: …` line if present, then one
 * `hint: …` line per hint, in order.
 *
 * JSON form: one `{"error":{code,message,hint?,didYouMean?,expectedArguments?}}` document —
 * `hint` is the first of `hints` (the JSON reader gets the single actionable next step, not
 * the human-only elaboration `detail` carries); `didYouMean`/`expectedArguments` ride
 * straight from `extra` when present.
 */
export function emitError(err: unknown, opts: EmitErrorOptions): 1 | 2 {
  const cli = toCliError(err);
  if (opts.json) {
    const doc: Record<string, unknown> = { code: cli.code, message: cli.message };
    if (cli.hints[0] !== undefined) doc.hint = cli.hints[0];
    if (cli.extra?.didYouMean !== undefined) doc.didYouMean = cli.extra.didYouMean;
    if (cli.extra?.expectedArguments !== undefined) doc.expectedArguments = cli.extra.expectedArguments;
    opts.stream.write(`${JSON.stringify({ error: doc })}\n`);
    return cli.exitCode;
  }
  const lines = [`error: ${cli.code}: ${cli.message}`];
  for (const entry of cli.detail) lines.push(indentBlock(entry, 2));
  if (cli.usage !== undefined) lines.push(`usage: ${cli.usage}`);
  for (const hint of cli.hints) lines.push(`hint: ${hint}`);
  opts.stream.write(`${lines.join("\n")}\n`);
  return cli.exitCode;
}

/**
 * The did-you-mean behind every `not_found` / `invalid_arguments` enrichment (§10). Two
 * rules, prefix first: a candidate the input is a PREFIX of wins outright (shortest such
 * candidate), because prefix-shaped exploration is how a human or an agent probes a catalog
 * — `describe app/mcp-tools/paper` means `paper_fetch`, at edit distance 6, which no
 * distance rule would ever suggest. Otherwise the closest candidate within edit distance ≤2,
 * or `undefined`: a distance-3+ guess is worse than no suggestion. The prefix rule needs
 * three characters, so a two-letter typo like `ur` stays with the distance rule that turns
 * it into `url` rather than matching some unrelated `ur…`.
 */
export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  if (input.length >= 3) {
    const prefixed = candidates.filter((candidate) => candidate !== input && candidate.startsWith(input));
    if (prefixed.length > 0) return prefixed.reduce((a, b) => (b.length < a.length ? b : a));
  }
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(input, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= 2 ? best : undefined;
}

/** Classic single-row space-optimized edit distance — no dependency earns its keep for this. */
function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal : 1 + Math.min(diagonal, row[j - 1], above);
      diagonal = above;
    }
  }
  return row[b.length];
}
