// wiring.ts — how an `Approvals` is built from the environment, written down ONCE.
//
// It exists because approvals.ts cannot hold this. That module is deliberately pure —
// the D1 binding, the clock, the audit recorder, the origin and the retention window all
// arrive as `ApprovalsConfig`, and nothing in it reads a binding — which is what lets the
// `unit` project load `canonicalJson` in plain Node, where `cloudflare:workers` does not
// resolve at all. Every other module wires its own env (audit.config, admin's db()); this
// one seam is the exception, so its filling needs a home of its own.
//
// Not index.ts either, though the composition root is where "no sibling names a binding"
// is written: all four callers — admin's ops table, the gateway, the web surface, the
// daily sweep — are modules index.ts imports, so a factory there would put an import cycle
// under each of them. Nothing imports THIS module except those four, and it imports
// nothing that imports it back.
//
// What it buys, and the reason it is worth a module: the four construction sites used to
// be four copies of the same ten lines, and the ONE difference that matters — which site
// wires `push`, i.e. which one can actually notify the owner — was invisible without
// diffing them. Now a call site spells only its difference.

import { env } from "cloudflare:workers";
import { Approvals } from "./approvals";
import type { ApprovalsConfig } from "./approvals";
import { config as auditConfig, record } from "./audit";
import type { VapidKeys } from "./push";

/**
 * The approval gate, wired from the ambient env and built per call (D1 bindings are
 * request-scoped). `overrides` is how a site says what is different about it, and today
 * exactly two things are: the gateway wires a `push` transport, because `check` is where a
 * pending row is opened and so the gateway is the only construction that can notify the
 * owner; and the daily sweep passes the retention window THAT run resolved, which is what
 * makes AUDIT_RETENTION_DAYS observable through the cron. Everything else is the same
 * everywhere, and is therefore said nowhere but here.
 */
export function approvalsFromEnv(overrides: Partial<ApprovalsConfig> = {}): Approvals {
  // deps: cloudflare:workers env (DB, PUBLIC_ORIGIN) · audit.record · audit.config
  return new Approvals({
    db: env.DB,
    publicOrigin: env.PUBLIC_ORIGIN,
    audit: { record: (entry) => record(env.DB, entry) },
    retentionDays: auditConfig().retentionDays,
    now: Date.now,
    ...overrides,
  });
}

/**
 * The VAPID identity a hub pushes under (§13), from the secrets that hold it. The ONE read
 * of VAPID_PRIVATE_KEY in the worker, which is what makes "where does the signing key
 * flow" answerable by listing this function's one caller: the transport the gateway closes
 * over (push.pushSender). The shape is push.ts's, because that module is what signs with it.
 */
export function vapidFromEnv(): VapidKeys {
  // deps: cloudflare:workers env (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUBLIC_ORIGIN)
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.PUBLIC_ORIGIN,
  };
}
