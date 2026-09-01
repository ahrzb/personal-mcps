## 9. Keeping agent-written tests honest

1. **The oracle is owner-authored and commit-separated.** Rows, law statements,
   and `contracts/*.json` land in their own commits before implementation. Agents
   write runners, harnesses, and implementations — never rows, never fixtures. A
   pre-commit/CI check fails any commit touching both oracle files and
   implementation files.
2. **Every refusal row carries its allow-twin.** A deny-only oracle is satisfied
   by `throw` everywhere — the reward-hacking attractor in a security-heavy
   codebase. 401-for-revoked sits beside 200-for-live.
3. **Spot mutation, not coverage, once green.** ~6 hand-picked wrong
   implementations must go red naming the right row: swap two check-order stages;
   SELECT-then-dispatch; hash before redaction; naive `'^'+p+'$'`; drop the
   `hub/*` strip; 401 where 404 belongs. Thirty minutes, no tooling. Corollary:
   an agent never resolves a red test by editing it — only `fix:`, `spec:`, or
   `test:`.
4. **No rendered control goes unwalked; exclusions intersect to zero.** *(added
   2026-08-26, from a shipped bug: the login form 415'd against better-auth in
   production while the whole suite was green.)* The CSRF walk excluded `/login`
   (no session to derive a token from) and the §8 parity walk excluded
   better-auth forms (the pinned credentials exception) — each exclusion
   individually principled, and their intersection left the front door covered
   by neither: the form pointed at better-auth, better-auth worked, and the
   handshake between them (the content type) was tested by nobody. Two duties
   follow. (a) *Exclusions are enumerated, then spent:* any walk that excludes a
   control must name it, and a totality case asserts every rendered control is
   claimed by at least one walk or one named journey case — an exclusion is a
   debt owed to another case, never a hole. (b) *Every form is submitted as the
   actor submits it:* at least one case per rendered form posts it exactly as a
   browser would — method, action, encoding, field names read from the RENDERED
   page, never respelled — and the case still runs when the action crosses into
   a third-party mount, because it is our form that encodes the assumption
   about their contract.

Never faked, anywhere: a sibling module, D1, the `AppConnection` DO,
WebCrypto, or the MCP SDK on either side. The fakes that do exist (fake upstream,
fake AS, fake push endpoint, fake tunneled app, fake hubs for the clients) do
*real* protocol work — real JSON-RPC, real S256 PKCE checks, real decryptable
push crypto — and each documents what it must NOT fake. The fake AS should be
**adversarial**, not spec-shaped: no RFC 9728 document, CIMD rejected so DCR is
forced, no `expires_in`, single-use rotated refresh tokens — ~20 lines that
convert four production-only OAuth failures into in-process ones.

