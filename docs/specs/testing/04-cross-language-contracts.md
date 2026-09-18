## 4. Cross-language contracts: `contracts/*.json`

The spec deliberately copies wire shapes across boundaries with no shared package.
Checked-in JSON fixtures include whoami, initialize, six error codes, hub schemas and
declaration templates, tunnel frames/aliases, close codes, bootstrap, admin operations,
audit stubs, and push frames.

`server/test/worker/contracts.test.ts` is the only writer. It emits fixtures from named
runtime source exports; CLI, three clients, provider, and scripts consume them read-only.
`contracts/hub.json` pins the two hub tools/resources/limits, initialize comes from the
capability producer, tunnel aliases from the registration producer, and the admin fixture
from its operation table. Re-generating errors must remain byte-identical. Run
`pnpm contracts:update`; no consumer may hand-mirror a producer.

