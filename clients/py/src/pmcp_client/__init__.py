"""pmcp-client — the service-author library (spec §6, §11). A plain MCP server
object written with the official ``mcp`` SDK goes in; this module keeps it
reachable through the hub's reverse tunnel.

OWNS the client side of the reverse-connection protocol: deriving
``wss://<host>/connect`` from the hub's https origin, the ``hub/register``
handshake (re-sent on every (re)connect), the split between ``hub/*`` control
frames and MCP traffic, WebSocket protocol pings (~25 s, no application
heartbeat), and the entire disconnect policy below. HIDES the wire completely —
the author never sees a socket, a JSON-RPC frame, or a reconnect. One deliberate
absence: the library never buffers traffic for an offline hub — while
disconnected the hub is already failing consumer calls with -32000, and outbound
notifications are dropped (the hub re-lists tools after every registration, so a
dropped ``list_changed`` heals itself).

The reconnect contract, stated once — everything below refers back here. Every
case is one of three behaviors — ``stop_fatal``, ``stop_quiet``, ``reconnect``
— and a reconnecting case additionally carries a schedule, ``exponential`` or
``max_only``:

- 401 at upgrade, or close code 4001 after establishment — the credential is
  dead (revoked/expired token, wrong token kind, deleted service):
  ``stop_fatal``, raising :class:`CredentialsError`. Never retry a dead
  credential.
- 403 at upgrade, or close code 4002 — the service is archived: ``reconnect``
  on the ``max_only`` schedule, so unarchiving heals within a minute without
  touching the bot.
- close code 4000 (after ``hub/replaced``) — a newer connection took the slot:
  ``stop_quiet``, never reconnect (two copies of a bot fighting for the slot
  is an operator error worth surfacing).
- a rejected ``hub/register`` declaration (bad role name, non-compiling
  pattern, over caps) — ``stop_fatal``, raising :class:`RegistrationError`:
  identical input cannot start succeeding, so it is surfaced, not retried.
- everything else — network drop, hub deploy, close 4003/4004 — ``reconnect``
  on the ``exponential`` schedule (jittered, 1 s → 60 s cap); a truly deleted
  service becomes a 401 at the next upgrade, which is the fatal path above.
"""

from collections.abc import Callable
from typing import Annotated, Any

# The author's MCP server — mcp.server.MCPServer (or the low-level
# mcp.server.Server) from the ``mcp`` package v2; external, never imported here.
McpServer = Any

# Role declaration sent in ``hub/register``: role name -> anchored patterns over
# tool names (§2's one pattern language — a bare tool name matches itself, ``*``
# aliases ``.*``). Validation is the hub's job, not this library's: names must
# match [a-z0-9_-]{1,64}, ``all`` is reserved, pattern length (<=128) and
# per-role count (<=64) are capped — a violating declaration is rejected at
# registration, which serve() surfaces as RegistrationError.
Roles = dict[str, list[str]]

__all__ = [
    "CallerIdentity",
    "CredentialsError",
    "HubTransport",
    "McpServer",
    "RegistrationError",
    "Roles",
    "Secret",
    "backoff_delay",
    "caller",
    "sensitive",
    "serve",
]

# Secret[T] — the pydantic-style spelling of §7's sensitive-field declaration:
# annotate a tool input or output model field as ``Secret[str]`` and the emitted
# JSON Schema carries ``writeOnly: true`` at that path, in both directions — the
# hub reads the marker and strips it from outputSchemas served to consumers.
# Schema-only, deliberately NOT pydantic's SecretStr: runtime values validate,
# repr, and serialize normally — real values cross the wire, and the HUB masks
# before anything is persisted or shown (§15). At implementation the marker is a
# json_schema_extra annotation the schema generator honors; the string here is a
# skeleton placeholder.
type Secret[T] = Annotated[T, "pmcp:secret"]


def backoff_delay(attempt: int, rng: Callable[[], float]) -> float:
    """The reconnect schedule as pure arithmetic — ``attempt`` (consecutive
    failures, 0-based) -> delay in seconds. Doubling from 1 s to the 60 s cap,
    jitter drawn from ``rng`` (a [0,1) source; the loop passes random.random,
    tests a seeded stub). Attempt 0 is jittered from zero, so a hub deploy's
    reconnect storm spreads out instead of every bot re-registering in the same
    second. Exported so doubling, cap, and jitter bounds are a table test, not a
    property of a live loop; the transport's reconnect loop is its only
    production caller — the same schedule as the JS library's ``backoffDelay``."""
    # deps: none
    raise NotImplementedError


class CredentialsError(Exception):
    """The credential is dead: 401 at upgrade or close 4001 after establishment —
    revoked/expired token, wrong token kind, or deleted service. Terminal; the
    library never retries a dead credential (module docstring)."""


class RegistrationError(Exception):
    """The hub rejected the ``hub/register`` role declaration (bad role name,
    non-compiling pattern, over caps — spec §6). Terminal: identical input cannot
    start succeeding, so it is raised immediately instead of retried."""


def serve(
    mcp: McpServer,
    *,
    url: str | None = None,
    token: str | None = None,
    roles: Roles | None = None,
) -> None:
    """Run ``mcp`` as a tunneled hub service: dial, register the role
    declaration, and stay reachable until the hub says otherwise. Blocks the
    calling thread for the life of the service — hours to months; treat it as
    the bot's main loop (it runs its own event loop internally).

    ``url`` is the hub's https origin, e.g. ``"https://mcp.example.com"`` — a
    bare origin, no path (PMCP_URL, §10); default the ``PMCP_URL`` env var, and
    neither set is a ValueError before any I/O. The ``wss://<host>/connect``
    address is derived internally, never passed in. ``token`` is the service
    token (``pmcp_svc_…``); default the ``PMCP_SERVICE_TOKEN`` env var. The
    service identity comes entirely from the token — there is deliberately no
    service/slug parameter (§6: a token for one slug can never touch another).
    ``roles`` omitted or ``{}`` declares none — the service is then reachable
    only by owner tokens or grants of the built-in ``all`` role.

    Terminal outcomes are the whole return contract: returns quietly when the
    hub replaces this connection with a newer one for the same service (close
    4000 — this copy steps aside and never reconnects); raises
    :class:`CredentialsError` / :class:`RegistrationError`; every other failure
    reconnects forever per the module docstring and never returns.
    """
    # deps: HubTransport · anyio · mcp (Server.run)
    raise NotImplementedError


class HubTransport:
    """The transport bridge: an async context manager that dials the hub over an
    outbound WebSocket and yields the anyio memory-stream pair the ``mcp`` SDK's
    ``Server.run(read_stream, write_stream)`` consumes — the custom transport
    the SDK spec sanctions (§4). :func:`serve` is sugar over this; use it
    directly only to run the SDK session yourself (e.g. inside an existing
    anyio application).

    One transport is one service lifetime, not one socket: reconnects and
    re-registration happen inside per the module-docstring contract, invisible
    to the SDK session — the yielded streams stay open across them and close
    only at a terminal state. ``hub/*`` control frames are consumed internally
    and never appear on the read stream; everything else is MCP traffic, one
    JSON-RPC message per WS text frame.
    """

    def __init__(self, url: str, token: str, roles: Roles | None = None) -> None:
        """``url`` is the hub's https origin — a bare origin, no path; anything
        else is a ValueError here, before any I/O. ``token`` is the
        ``pmcp_svc_`` credential the whole connection authenticates as. No
        network happens until ``__aenter__``."""
        # deps: none
        raise NotImplementedError

    async def __aenter__(self) -> tuple[Any, Any]:
        """Connect and register, then return ``(read_stream, write_stream)`` —
        anyio memory object streams carrying SDK session messages, ready for
        ``Server.run``. Returns after the first successful registration; raises
        only on a terminal state reached before then. Writes while the socket
        is down are dropped, never queued (module docstring)."""
        # deps: anyio · websockets
        raise NotImplementedError

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool | None:
        """Tear down the connection machinery. Exited normally (the SDK session
        finished because the streams closed), it raises
        :class:`CredentialsError` / :class:`RegistrationError` when that was
        the terminal cause and returns quietly after a replacement (close 4000)
        or local cancellation. Never suppresses the body's own exception."""
        # deps: anyio
        raise NotImplementedError


class CallerIdentity:
    """The hub-asserted caller of the current tool call (§7, "Caller identity
    forwarding"). ``principal`` is ``"user:<name>"`` or ``"sa:<slug>"``.
    ``roles`` is the caller's granted role names on this service exactly as
    granted — the built-in wildcard arrives literally as ``"all"`` (owners get
    ``("all",)``), never expanded into declared names. Informational for the
    service's own branching: the hub's grant check has already run, and these
    are not secrets. Constructed by :func:`caller`, never directly."""

    principal: str
    roles: tuple[str, ...]

    def has_role(self, role: str) -> bool:
        """True when ``roles`` contains ``role`` or ``"all"`` — so owner and
        all-granted callers behave identically, and ``all`` can never collide
        with a declared role name (the hub rejects declaring it)."""
        # deps: none
        raise NotImplementedError


def caller(meta: dict[str, Any] | None) -> CallerIdentity:
    """Read the caller identity off a forwarded request's ``_meta``
    (``hub/principal``, ``hub/roles``). Trustworthy for fine-grained
    service-side checks: the hub strips consumer-supplied ``hub/*`` keys before
    injecting its own, so a consumer cannot forge these (§7). On a request that
    never passed through the hub (e.g. local testing) the fields are simply
    absent: ``principal`` is ``""``, ``roles`` is empty, and ``has_role`` is
    uniformly false — no error to handle."""
    # deps: none
    raise NotImplementedError


def sensitive(schema: dict[str, Any], paths: list[str]) -> dict[str, Any]:
    """Mark schema properties sensitive by path — the hand-written-schema
    spelling of §7's sensitive-field declaration (:data:`Secret` is the
    model-field spelling). Works on an input schema or an output schema alike:
    returns a copy of ``schema`` — the original
    is not mutated — with ``writeOnly: true`` (the standard JSON Schema
    keyword; no invented syntax) set at each dot-path in ``paths``, e.g.
    ``"password"`` or ``"credentials.token"``. A path naming no property in the
    schema is a ValueError: a silent typo here would quietly persist a secret.
    Marking is all this does — redaction itself happens in the hub, before
    anything is stored or shown."""
    # deps: none
    raise NotImplementedError
