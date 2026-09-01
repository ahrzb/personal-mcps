## 1. Overview

A personal MCP hub. Apps come in two kinds: **tunneled** — small programs (written
like telegram bots) that dial **out** to the hub with a persistent WebSocket and expose
an MCP server through it — and **proxied** — existing remote MCP endpoints (e.g.
Notion's) that the hub forwards to directly. The hub proxies inbound MCP clients
(Claude, other agents, the CLI) to those apps, enforcing per-agent role
grants. Each user owns their own namespace — apps, agents, grants, YAML
file — managed via a CLI and served under `/<user>/mcp…` URLs.

Components:

| Component | What it is |
|---|---|
| **server** | Cloudflare Worker + Durable Objects. Terminates auth, owns the registry, proxies MCP traffic. |
| **clients** (py + js) | Libraries an app author uses: write a normal MCP server, hand it to the lib, it maintains the reverse connection. |
| **cli** (`pmcp`) | Login via device flow, invoke MCP tools, diff/apply the YAML config. |
| **admin MCP** | The hub's own management (apps, agents, grants, tokens) exposed as a built-in MCP app named `pmcp` — its tools are ordinary tools (`pmcp_app_list` on the aggregated endpoint). |
| **web pages** | Server-rendered pages (Hono JSX, §13): `/login`, `/device`, `/settings`, plus `/apps`, `/approvals`, `/audit` — fronts over the same handlers as the `pmcp` tools, no web-only capability (except `/settings`, and `/audit`'s streaming JSONL export — a serialization of `audit_query`, §13). |

Non-goals (v1): cross-namespace sharing between users, MCP push streams
(`subscriptions/listen` and every server→consumer notification with it, §20), any web UI
beyond the server-rendered pages of §13 (no SPA — the pages do ship as an installable PWA
with Web Push for approvals, §13). *(Amended 2026-08-26: two former non-goals became
sections of their own — MCP-native OAuth for third-party clients is **§19**, and
prompts/resources proxying is **§20**. The push-stream non-goal is the one that stayed,
and §20 records why.)* *(Amended 2026-09-01: it did not stay either — push is **§21**
now, decision 28 — leaving cross-namespace sharing and the no-SPA rule as the v1
non-goals.)*

