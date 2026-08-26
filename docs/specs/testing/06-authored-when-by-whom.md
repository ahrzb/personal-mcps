## 6. Authored when, by whom

| Artifact | When | Author |
|---|---|---|
| Table rows + law statements | **before implementation**, from the spec alone | owner — or an agent whose only input is the spec section, never the implementation |
| `tunnel/smoke.test.ts` | **first file in that directory** — two platform assumptions gate three other files' shape | agent, run immediately |
| Harness (seed / fake-upstream / fake-service) | before implementation — building it against the skeletons is itself a design check: if seeding a namespace is awkward, a production seam is wrong | agent |
| Runners (~20 lines each) | with the harness | agent |
| The CAS/concurrency test | **before implementation** — the one test that constrains implementation *shape* (rules out SELECT-then-dispatch) | owner |
| Implementation | after; the tables are the acceptance criteria | agents |
| Law/property tests | after first green is fine — hardening, not design | either |

Vertical slices so the outer loop is never red for weeks: (1) identity + registry
+ gateway + `service_list` + fake tunnel → auth and order tables green; (2)
approvals + CAS; (3) upstream/OAuth; (4) the CLI planner (pure, independent, any
time); (5) client libraries.

Where fail-first genuinely pays: the CAS test, and anywhere the spec is ambiguous
— writing the assertion is the moment ambiguity must resolve. Watching red
against skeletons that all `throw "unimplemented"` is ceremony: red is guaranteed
and proves nothing.

