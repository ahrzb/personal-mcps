## 1. Overview

A personal MCP hub. Apps come in two kinds: **tunneled** — small programs (written
like telegram bots) that dial **out** to the hub with a persistent WebSocket and expose
an MCP server through it — and **proxied** — existing remote MCP endpoints (e.g.
Notion's) that the hub forwards to directly. The hub proxies inbound MCP clients
(Claude, other agents, the CLI) to scoped apps, enforcing per-agent role grants. Its
aggregate endpoint is a hub-owned TypeScript orchestration surface that can compose those
authorized scoped operations without exposing an aggregate application catalog (§23).
Each user owns a namespace of apps, agents, grants, execution settings, and durable
TypeScript aliases, managed through the web UI, CLI, or OpenTofu and served under
`/<user>/mcp…` URLs.

Components:

| Component | What it is |
|---|---|
| **server** | Cloudflare Worker + Durable Objects. Terminates auth, owns the registry, proxies MCP traffic. |
| **clients** (py + js) | Libraries an app author uses: write a normal MCP server, hand it to the lib, it maintains the reverse connection. |
| **cli** (`pmcp`) | Login via device flow, inspect the namespace, invoke MCP and admin tools. |
| **admin MCP** | The hub's management app named `pmcp`, reached directly at scoped `/mcp/pmcp` or from an authorized §23 program; it is no longer published as prefixed aggregate tools. |
| **web pages** | Two renderings, one design language (§13): `/apps/*` and `/agents/*` are a React SPA (TanStack Query + Router, shadcn on Base UI) over the cookie-authenticated JSON surface at `/api/hub`; login/device, seven-pane Settings including Execution, approvals, audit and the OAuth consent screen stay server-rendered (Hono JSX). Both front shared operations except the pinned browser/auth/export exceptions. |

Non-goals (v1): cross-namespace sharing, persistent execution
workspaces, package installation, saved programs, and asynchronous execution jobs.
OAuth, prompts/resources, and push are specified in §§19–21. The §23 orchestration
surface is synchronous, dependency-free TypeScript with explicit limits; it does not
imply a future job/resume protocol.

