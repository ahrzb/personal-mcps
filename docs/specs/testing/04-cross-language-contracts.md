## 4. Cross-language contracts: `contracts/*.json`

The spec deliberately COPIES wire shapes across boundaries with no shared package.
The pin mechanism: checked-in JSON fixtures — whoami, the error codes + `-32003`
data, tunnel frames, **close codes → required client behavior**, bootstrap
request/response, admin op names + schemas, the `app_list`/`agent_list` rows
the diff planner reads, and the audit body-stub wire shape (`blob`/`oversize` —
spec §15 defers its exact spelling to these fixtures).
`server/test/worker/contracts.test.ts` is the **only
writer**, asserting the server's real emissions deep-equal each fixture;
CLI/clients/scripts consume them read-only. Plain JSON means neither side can
import a type from it, so the copied shapes stay copied while both answer to one
oracle. `pnpm contracts:update` regenerates; a commit touching a fixture plus an
implementation file is the tell that someone made a test pass. Parity directions
C and D live here too: every planner-emitted step maps to an ops key with the
schema's required fields present, and every non-auth CLI subcommand maps to an
ops key, total in both directions.

