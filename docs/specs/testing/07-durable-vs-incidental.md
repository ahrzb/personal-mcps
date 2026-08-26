## 7. Durable contract vs incidental detail

**Rule: if the spec sentence would survive a full rewrite of the module, pin it
hard. If the assertion names a number, a prose string, or a database column, it
is incidental — put it behind a named constant or don't assert it.**

Durable: refusal codes and their **order**; 401-vs-404 indistinguishability; what
is persisted and what is *never* persisted; approval exactly-once; close-code →
client-behavior; `<slug>_<tool>` splitting; `hub/*` strip-then-set; the pattern
language; `all` reserved-but-grantable; the whoami shape.

Incidental: every timeout literal (assert *that* a deadline is enforced, via the
constant and the injected clock); error prose (assert code + presence of
`approvalUrl`); audit `detail` layout; SQL/columns; list ordering; page/chunk
sizes; all HTML; `last_used_at` cadence.

