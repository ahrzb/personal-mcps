## 7. Durable contract vs incidental detail

**Rule: if the spec sentence would survive a full rewrite of the module, pin it
hard. If the assertion names a number, a prose string, or a database column, it
is incidental — put it behind a named constant or don't assert it.**

Durable: refusal codes/order; 401-vs-404 indistinguishability; persistence exclusions;
approval exactly-once; close-code behavior; canonical scoped identities; aggregate
hub-only routing; one explicit TypeScript map shared by declarations/runtime; sticky
collision behavior; fresh per-invocation QuickJS isolation; credential reauthorization;
`hub/*` strip-then-set; pattern language; six-code vocabulary; no invoking bearer in
untrusted state.

Incidental behind named producers/constants: timeout literals below the 300 s compiled
ceiling, diagnostics prose, SQL column layout, list/page ordering, HTML, and
cache/last-used cadence. First-underscore splitting is no longer a durable rule because
aggregate application dispatch no longer exists.

