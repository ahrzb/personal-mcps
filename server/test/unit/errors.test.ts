/**
 * errors.notPermitted — §7's one -32001, and decision 37's recorded cause for it.
 *
 * The whole feature is a pair of claims that pull against each other, and this file is
 * where they are checked as one: the LEDGER learns why a call was refused, and the WIRE
 * learns nothing. A consumer must not be able to tell an ungranted tool from an app that
 * does not exist, or it can map its grants and enumerate a namespace one call at a time
 * (§7); the owner reading `/audit` must be able to, or the trail says "not permitted" nine
 * different times and explains none of them (§15, decision 37).
 *
 * So what is pinned here is that the CAUSE rides `auditDetail` — the field `toWire` does
 * not serialize, the field `gateway.dispatchTool` merges into the audit row — and that the
 * three fields a consumer does receive (`code`, `message`, `data`) are byte-identical
 * across every reason in the vocabulary. The gateway half (that a real refusal on a real
 * socket answers alike, and that the row really carries the cause) is
 * `server/test/worker/order.table.test.ts`'s; nothing here reaches a wire at all.
 *
 * The vocabulary is CLOSED and this file is the only place that lists it: a tenth reason
 * added to `RefusalReason` without a row here is caught by the exhaustiveness check below,
 * not by a reviewer noticing.
 *
 * Project: `unit` — errors.ts is the leaf that imports nothing, which is exactly why the
 * vocabulary lives there and why it can be tested with no runtime at all.
 *
 * deps: src/errors (notPermitted, RefusalReason, CODES)
 */

import { describe, expect, it } from "vitest";
import { CODES, notPermitted } from "../../src/errors";
import type { RefusalReason } from "../../src/errors";

/**
 * Every member of the vocabulary, spelled out rather than derived — a type cannot be
 * iterated, and a list built from the implementation would agree with it by construction.
 * The `satisfies` is what makes the pair total in the other direction: a reason added to
 * the type and not to this list is a compile error here.
 */
const REASONS = [
  "no_app",
  "app_changed",
  "no_grant",
  "not_in_catalog",
  "unsound_schema",
  "credential_lapsed",
  "op_withheld",
  "not_decidable",
  "wrong_endpoint",
] as const satisfies readonly RefusalReason[];

/** What `gateway.toWire` puts on the wire, and the whole of it (§7: -32001 carries no
 *  `data`). Built here rather than imported because toWire lives in a module that pulls
 *  `cloudflare:workers`; that it really sends these three and no more is the worker
 *  suite's own row. */
const onTheWire = (error: { code: number; message: string; data?: unknown }) => ({
  code: error.code,
  message: error.message,
  data: error.data,
});

describe("§7/§15 · notPermitted — the ledger learns the cause, the wire does not", () => {
  it("§15 · every reason lands on `auditDetail` as `{ reason }` and nothing else — the field dispatchTool merges into the audit row, one closed-vocabulary class per refusal", () => {
    for (const reason of REASONS) {
      expect(notPermitted(reason).auditDetail, reason).toEqual({ reason });
    }
  });

  it("§7 · the nine refusals are ONE answer on the wire: same code, same message, `data` unset — a consumer cannot tell an ungranted tool from an app that is not there, which is the property every grant-mapping probe would otherwise walk", () => {
    const answers = REASONS.map((reason) => onTheWire(notPermitted(reason)));
    const [first] = answers;
    for (const answer of answers) expect(answer).toEqual(first);
    expect(first.code).toBe(CODES.notPermitted);
    expect(first.message).toBe("tool not permitted");
    // `data` carries nothing on any of them (§7 pins it to -32003 alone). That it is ABSENT
    // rather than an undefined key is a fact about the serialized answer, which the row
    // below reads, and about the real wire objects order.table.test.ts compares whole.
    expect(first.data).toBeUndefined();
  });

  it("§7 · the cause is nowhere in what a consumer could serialize: neither the token nor the word \"reason\" survives into the three wire fields, whichever reason built the error", () => {
    for (const reason of REASONS) {
      const serialized = JSON.stringify(onTheWire(notPermitted(reason)));
      expect(serialized, reason).not.toContain("reason");
      expect(serialized, reason).not.toContain(reason);
    }
  });

  it("§15 · the factory takes the cause as a REQUIRED argument, so no call site can forget one — a refusal with no cause is a row that says \"not permitted\" and explains nothing, which is the state decision 37 exists to end", () => {
    // `notPermitted()` does not type-check, and the compiler is what actually enforces that
    // across ~25 call sites; the arity is the runtime shadow of it, so a signature loosened
    // back to an optional argument fails here too rather than quietly landing causeless rows.
    expect(notPermitted.length, "notPermitted takes exactly one argument").toBe(1);
  });
});
