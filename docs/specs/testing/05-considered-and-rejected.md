## 5. What was considered and rejected

- **Regression-only floor**: dies to the cost asymmetry — auth/redaction/approval
  bugs are silent; a suite encoding only noticed bugs can't cover failures
  invisible by construction.
- **Characterization-after**: anchors on the implementation's interpretation — a
  wrong 401-where-404-belongs gets frozen as "expected". Backwards for a
  refusal-heavy system.
- **Classic per-function unit TDD everywhere**: green units, broken pipeline; and
  the home of one-spec-line-changes-forty-tests.
- **Full ceremony** (deployed e2e in CI, Playwright, Stryker, model-based state
  machines): the solo-owner project-killer. A fast-check model of the approval
  machine is a second implementation of the same rules under the same churn, for
  a state space ~14 explicit rows already exhaust. Three server-rendered forms do
  not justify a browser dependency. Coverage tooling: V8 coverage is unsupported
  here anyway, and a percentage target breeds tests that assert nothing.

