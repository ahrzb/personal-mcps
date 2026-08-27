"""pmcp-client — the service-author library (spec §6, §11). A plain MCP server
object goes in; this module keeps it reachable through the hub's reverse tunnel.

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

Implementation notes not in the outline docstrings, kept here so they sit next
to what they explain:

- The two production seams the reconnect policy is otherwise unobservable
  through — the jitter draw and the wait itself — are the module-level
  functions :func:`_rng` and :func:`_sleep`, not constructor parameters.
  ``HubTransport.__init__`` takes exactly ``(url, token, roles)`` per its own
  docstring; tests reach the seams with ``monkeypatch.setattr(pmcp_client,
  "_rng", ...)`` / ``"_sleep"``, the same shape as ``conftest.recorded_sleep``.
  A bare-name call inside this module re-resolves the module's globals on
  every call, so a monkeypatch of the module attribute is visible to code
  already defined here — that indirection is the whole reason this file
  never binds either name to a local at import time.
- The streams :meth:`HubTransport.__aenter__` yields carry
  ``mcp.shared.message.SessionMessage`` (wrapping a real
  ``mcp_types.JSONRPCMessage``) on success and a bare ``Exception`` for a
  frame that failed that validation — the same two-shape contract
  ``mcp.server.stdio.stdio_server`` uses, so a real ``Server.run`` reads
  these streams unmodified. ``result``/``params`` are plain
  ``dict[str, Any]`` fields on every JSON-RPC message class in ``mcp_types``,
  so an MRTR field this library has never heard of (``resultType``,
  ``requestState``, ``inputResponses``, …) round-trips byte-for-byte through
  that validation — verified once, empirically, rather than assumed; that is
  what makes real validation safe to do here instead of passing raw dicts.
- ``pydantic`` is imported directly (for :data:`Secret`) though it is not
  listed in ``pyproject.toml``'s own ``[project.dependencies]``: it is
  ``mcp``'s own dependency, already resolved in ``uv.lock``, and the
  JSON-Schema-marking behaviour :data:`Secret` needs does not exist without
  it. Nothing here upgrades it to a direct declared dependency — that is a
  separate, owner-made packaging decision.
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, Protocol
from urllib.parse import urlsplit

import anyio
import websockets
from anyio.streams.memory import MemoryObjectReceiveStream, MemoryObjectSendStream
from mcp.shared.message import SessionMessage
from mcp_types import jsonrpc_message_adapter
from pydantic import Field


class McpServer(Protocol):
    """The author's MCP server — ``mcp.server.MCPServer`` (or the low-level
    ``mcp.server.Server``) from the ``mcp`` package v2; external, never imported
    here, and therefore named by the one method :func:`serve` uses rather than by
    a type this module cannot see.

    Stated structurally on purpose. ``Any`` plus a runtime probe for ``run`` would
    let a wrong object through to a fallback that drains the read stream and
    discards every inbound MCP message for the life of the bot — the hub believes
    the service is healthy while every forwarded call times out. Failing at the
    call site instead is the whole difference between a typo and an
    unknown-unknown. A hand-rolled session is served by using
    :class:`HubTransport` directly, which is what that class documents.
    """

    async def run(self, read_stream: Any, write_stream: Any, initialization_options: Any, /) -> None: ...


# Role declaration sent in ``hub/register``: role name -> either a bare pattern
# list — tools, forever, so every service written before §20 keeps registering
# unchanged — or a per-family object (§20.3). Validation is the hub's job, not
# this library's: names must match [a-z0-9_-]{1,64}, ``all`` is reserved, an
# unknown family key is a violation, and pattern length (<=128) and per-family
# pattern count (<=64) are capped — a violating declaration is rejected at
# registration, which serve() surfaces as RegistrationError. The two spellings
# may be mixed across roles in one declaration; this library sends whichever an
# author wrote, unchanged — no normalization here (§20.6). Pinned as a VALUE
# (not just an annotation) by test_transport.py's own equality check, so this
# exact spelling is load-bearing.
Roles = dict[str, list[str] | dict[str, list[str]]]

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
# before anything is persisted or shown (§15). ``Field`` used purely as
# ``Annotated`` metadata (no assigned default) is pydantic's own documented way
# to attach ``json_schema_extra`` to a type alias rather than to one field.
type Secret[T] = Annotated[T, Field(json_schema_extra={"writeOnly": True})]

# ── the tunnel wire (contracts/tunnel-frames.json) ────────────────────────────

#: The hub/* control-frame method names this transport consumes internally. A
#: hub/ method outside this set is ordinary traffic and reaches the SDK session
#: untouched, so a new control frame can never be swallowed silently.
HUB_METHOD_REGISTER = "hub/register"
HUB_METHOD_REPLACED = "hub/replaced"
HUB_METHODS = {"register": HUB_METHOD_REGISTER, "replaced": HUB_METHOD_REPLACED}

#: The pinned MCP revision of the tunnel wire (contracts/tunnel-frames.json).
PROTOCOL_VERSION = "2026-07-28"

#: The registration-time capability question (§6/§11, added §20) — plain MCP
#: namespace, not ``hub/``-prefixed, but answered by this library rather than
#: bridged to the SDK session: no MCP SDK implements it, and this library is
#: what knows which families the author actually registered.
_DISCOVER_METHOD = "server/discover"

#: What ``clientVersion`` reports on the register frame — a free string in the fixture.
_CLIENT_VERSION = "pmcp-client/0"

#: The wire id of the one request this library ever originates.
_REGISTER_ID = "hub-register-1"

# ── the reconnect schedule (§6) ────────────────────────────────────────────────

_BACKOFF_BASE_S = 1.0
_BACKOFF_CAP_S = 60.0

#: The first attempt whose ceiling is clamped to the cap — the ``max_only``
#: schedule's whole content: the window stops doubling and stays at the cap
#: (never a floor under the wait).
_MAX_ONLY_ATTEMPT = 6

#: §6 — liveness is WebSocket PROTOCOL pings at this cadence; there is no
#: application heartbeat. A module attribute (not a constructor argument) so a
#: test can monkeypatch a short cadence without waiting ~25 real seconds.
_PING_INTERVAL_S = 25.0


def backoff_delay(attempt: int, rng: Callable[[], float]) -> float:
    """The reconnect schedule as pure arithmetic — ``attempt`` (consecutive
    failures, 0-based) -> delay in seconds. Doubling from 1 s to the 60 s cap,
    jitter drawn from ``rng`` (a [0,1) source; the loop passes random.random,
    tests a seeded stub). Attempt 0 is jittered from zero, so a hub deploy's
    reconnect storm spreads out instead of every bot re-registering in the same
    second. Exported so doubling, cap, and jitter bounds are a table test, not a
    property of a live loop; the transport's reconnect loop is its only
    production caller — the same schedule as the JS library's ``backoffDelay``."""
    # The cap applies to the CEILING, before the draw — so no delay can exceed
    # it, and the window still starts at zero at every attempt.
    return rng() * min(_BACKOFF_CAP_S, _BACKOFF_BASE_S * 2**attempt)


async def _sleep(seconds: float) -> None:
    """The reconnect loop's only wait. A bare module function (not a method, not
    a constructor argument) so ``tests/conftest.py``'s ``recorded_sleep`` fixture
    can replace it wholesale with ``monkeypatch.setattr``."""
    await anyio.sleep(seconds)


def _rng() -> float:
    """The reconnect loop's only jitter draw — the seam ``test_transport.py``'s
    row runner fixes so the ``max_only`` vs ``exponential`` schedules, which
    overlap under a live draw, are told apart by ceiling instead."""
    return random.random()


class CredentialsError(Exception):
    """The credential is dead: 401 at upgrade or close 4001 after establishment —
    revoked/expired token, wrong token kind, or deleted service. Terminal; the
    library never retries a dead credential (module docstring)."""


class RegistrationError(Exception):
    """The hub rejected the ``hub/register`` role declaration (bad role name,
    non-compiling pattern, over caps — spec §6). Terminal: identical input cannot
    start succeeding, so it is raised immediately instead of retried."""


def _connect_address(url: str) -> str:
    """``wss://<host>/connect``, DERIVED from the hub's origin — never passed in
    (§6). The scheme follows the origin's and is never downgraded: https ->
    wss, and the http a local ``wrangler dev`` serves -> ws. Anything but a
    bare origin is a ValueError before any I/O."""
    parts = urlsplit(url)
    if parts.path not in ("", "/") or parts.query != "" or parts.fragment != "":
        raise ValueError(f"expected a bare hub origin, got {url!r}")
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError(f"expected an http(s) hub origin, got {url!r}")
    scheme = "wss" if parts.scheme == "https" else "ws"
    return f"{scheme}://{parts.netloc}/connect"


def _resolve(explicit: str | None, env_name: str, what: str) -> str:
    """§10/§11 · an explicit argument wins over the env var; neither set is a
    ValueError raised before any I/O — resolution happens before a socket
    exists, in both :func:`serve` and (indirectly) ``HubTransport.__init__``."""
    resolved = explicit if explicit is not None else os.environ.get(env_name)
    if not resolved:
        raise ValueError(f"no {what}: pass it explicitly or set {env_name}")
    return resolved


async def serve(
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
    resolved_url = _resolve(url, "PMCP_URL", "hub url")
    resolved_token = _resolve(token, "PMCP_SERVICE_TOKEN", "service token")
    async with HubTransport(
        resolved_url, resolved_token, roles, discover=lambda: _probe_capabilities(mcp)
    ) as (read_stream, write_stream):
        # The SDK session owns the handshake from here. ``create_initialization_options``
        # stays a getattr because the SDK itself makes it optional; ``run`` does not.
        make_options = getattr(mcp, "create_initialization_options", None)
        init_options = make_options() if callable(make_options) else None
        await mcp.run(read_stream, write_stream, init_options)


@dataclass(frozen=True)
class _Ending:
    """How one connection ended, in the fixture's vocabulary
    (contracts/close-codes.json): ``kind`` is one of ``stop_quiet`` /
    ``stop_fatal`` / ``reconnect``; ``schedule`` is set only for ``reconnect``;
    ``error`` is set only for ``stop_fatal``."""

    kind: str
    schedule: str | None = None
    error: BaseException | None = None


def _ending_for_upgrade(status: int) -> _Ending:
    """A refused upgrade -> its behavior. Only 401 is fatal; 403 is archived and
    heals by retrying; every other status (500 from an edge failure, and
    anything §6 never mentions) reconnects, so a transient outage never strands
    a fleet of bots."""
    if status == 401:
        # The message names the status, never the credential (§15).
        return _Ending("stop_fatal", error=CredentialsError("the hub refused the service credential (401)"))
    if status == 403:
        return _Ending("reconnect", schedule="max_only")
    return _Ending("reconnect", schedule="exponential")


def _ending_for_close(code: int) -> _Ending:
    """A close code -> its behavior. Unknown means reconnect — the safe default (§6)."""
    if code == 4000:
        return _Ending("stop_quiet")
    if code == 4001:
        return _Ending("stop_fatal", error=CredentialsError("the hub severed the connection (close 4001)"))
    if code == 4002:
        return _Ending("reconnect", schedule="max_only")
    return _Ending("reconnect", schedule="exponential")


def _probe_capabilities(mcp: McpServer) -> dict[str, Any] | None:
    """The author's declared capabilities, read the one way §11 sanctions: the
    SDK's own optional ``get_capabilities()`` (``mcp.server.Server``'s — the
    no-argument call is its own default), never guessed from what this library
    can carry. Absent — every service already in the field — is ``None``, which
    :meth:`HubTransport._answer_discover` turns into a ``-32601``: "capabilities
    unknown", the hub's documented fallback (§6), not a fabricated empty set
    (§20.5: an empty ANSWER is an undeclare and clears a catalog; a missing
    answer is not)."""
    probe = getattr(mcp, "get_capabilities", None)
    if not callable(probe):
        return None
    capabilities = probe()
    if isinstance(capabilities, dict):
        return capabilities
    dump = getattr(capabilities, "model_dump", None)
    if not callable(dump):
        return None
    # by_alias: the wire's camelCase (listChanged, …); exclude_none: only the
    # families actually registered, which is the whole question this answers.
    return dump(by_alias=True, mode="json", exclude_none=True)


def _message_of(error: Any) -> str:
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str):
            return message
    return json.dumps(error)


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

    The terminal state is observable without exiting: :attr:`terminal` is set
    once at any ending and :meth:`closed` reports which one it was — the twins
    of the JS library's ``closed`` promise.
    """

    def __init__(
        self,
        url: str,
        token: str,
        roles: Roles | None = None,
        *,
        discover: Callable[[], dict[str, Any] | None] | None = None,
    ) -> None:
        """``url`` is the hub's https origin — a bare origin, no path; anything
        else is a ValueError here, before any I/O. ``token`` is the
        ``pmcp_svc_`` credential the whole connection authenticates as. No
        network happens until ``__aenter__``.

        ``discover`` answers the hub's registration-time ``server/discover``
        (§6/§11, §20) — internal wiring :func:`serve` supplies from the SDK
        server's own capabilities, not one of the three public options a
        service author sets. Omitted (a hand-rolled session that does not pass
        one) means every ``server/discover`` gets the ``-32601`` fallback."""
        self._address = _connect_address(url)
        self._token = token
        self._roles: Roles = roles if roles is not None else {}
        self._discover = discover

        self._read_send: MemoryObjectSendStream[SessionMessage | Exception]
        self._read_recv: MemoryObjectReceiveStream[SessionMessage | Exception]
        self._read_send, self._read_recv = anyio.create_memory_object_stream(max_buffer_size=float("inf"))
        self._write_send: MemoryObjectSendStream[SessionMessage]
        self._write_recv: MemoryObjectReceiveStream[SessionMessage]
        self._write_send, self._write_recv = anyio.create_memory_object_stream(max_buffer_size=float("inf"))

        self._ready_event = anyio.Event()
        #: PUBLIC. Set exactly once, at ANY terminal ending — whether reached on
        #: the very first attempt (before ``__aenter__`` returns) or long after,
        #: following a reconnect close-code row. Together with :meth:`closed` it
        #: is this library's whole terminal-state surface, the twin of the JS
        #: library's ``closed`` promise: a caller can observe the ending, and
        #: which ending it was, without exiting the context manager.
        self.terminal = anyio.Event()
        self._first_registered = False
        #: The ending itself: None after a quiet stop, the raised error after a
        #: fatal one. Read through :meth:`closed` and ``__aexit__``.
        self._terminal_error: BaseException | None = None
        self._attempt = 0
        self._current_ws: Any | None = None
        # Plain asyncio tasks, deliberately NOT an anyio task group: a task
        # group's cancel scope is tied to the task that entered it, so a
        # group entered inside __aenter__ cannot be exited from __aexit__
        # when the two are awaited from different tasks (a normal thing to
        # do with an async context manager — the SDK session that owns
        # __aexit__ is not obliged to be the same task as whoever built the
        # transport). Bare Tasks carry no such affinity: any task may cancel
        # or await them.
        self._run_task: Any | None = None
        self._drain_task: Any | None = None
        self._exited = False

    async def __aenter__(self) -> tuple[MemoryObjectReceiveStream[Any], MemoryObjectSendStream[Any]]:
        """Connect and register, then return ``(read_stream, write_stream)`` —
        anyio memory object streams carrying SDK session messages, ready for
        ``Server.run``. Returns after the first successful registration; raises
        only on a terminal state reached before then. Writes while the socket
        is down are dropped, never queued (module docstring)."""
        self._drain_task = asyncio.ensure_future(self._drain_writes())
        self._run_task = asyncio.ensure_future(self._run())
        try:
            await self._ready_event.wait()
        except BaseException:
            # Cancelled while still connecting: tear down our own background
            # tasks rather than leaking them — a caller cancelled mid-__aenter__
            # will never reach __aexit__ to do it for us.
            await self._teardown()
            self._exited = True
            raise
        if self._terminal_error is not None and not self._first_registered:
            # Never succeeded even once: nothing to hand back.
            await self._teardown()
            self._exited = True
            raise self._terminal_error
        return self._read_recv, self._write_send

    async def closed(self) -> None:
        """Wait for the terminal ending and report it: returns after a
        replacement (close 4000) or a local teardown, raises
        :class:`CredentialsError` / :class:`RegistrationError` otherwise. The
        twin of the JS library's ``await transport.closed``, and the reason
        neither the ending nor its cause needs a private attribute to observe.
        Never returns on an ordinary disconnect — those reconnect."""
        await self.terminal.wait()
        if self._terminal_error is not None:
            raise self._terminal_error

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool | None:
        """Tear down the connection machinery. Exited normally (the SDK session
        finished because the streams closed), it raises
        :class:`CredentialsError` / :class:`RegistrationError` when that was
        the terminal cause and returns quietly after a replacement (close 4000)
        or local cancellation. Never suppresses the body's own exception."""
        if self._exited:
            return None
        self._exited = True
        await self._teardown()
        if exc is not None:
            return None
        if self._terminal_error is not None:
            raise self._terminal_error
        return None

    async def _teardown(self) -> None:
        tasks = [task for task in (self._run_task, self._drain_task) if task is not None]
        self._run_task = None
        self._drain_task = None
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except BaseException:  # noqa: BLE001 - a cancelled background task's own exception is ours to absorb
                pass
        self._read_send.close()
        self._write_recv.close()
        # A local teardown IS an ending, and a quiet one: `closed()` must not wait
        # forever for a loop that no longer exists (the JS twin's close() resolves
        # `closed` for the same reason).
        if not self.terminal.is_set():
            self.terminal.set()

    # ── the connection lifetime ───────────────────────────────────────────────

    async def _run(self) -> None:
        """One transport is one service lifetime: this loop outlives every
        socket it opens."""
        while True:
            ending = await self._connect_once()
            if ending.kind == "stop_quiet":
                self._finish()
                return
            if ending.kind == "stop_fatal":
                self._finish(error=ending.error)
                return
            # A reconnecting ending never closes the streams — the SDK session
            # must not learn that the socket flapped.
            if ending.schedule == "max_only":
                attempt = _MAX_ONLY_ATTEMPT
            else:
                attempt = self._attempt
                self._attempt += 1
            await _sleep(backoff_delay(attempt, _rng))

    async def _connect_once(self) -> _Ending:
        """One dial, from the upgrade to the ending — the only place the wire
        is touched."""
        try:
            async with websockets.connect(
                self._address,
                additional_headers={"Authorization": f"Bearer {self._token}"},
                ping_interval=_PING_INTERVAL_S,
                ping_timeout=_PING_INTERVAL_S,
            ) as ws:
                self._attempt = 0
                self._current_ws = ws
                try:
                    await ws.send(
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": _REGISTER_ID,
                                "method": HUB_METHOD_REGISTER,
                                "params": {
                                    "clientVersion": _CLIENT_VERSION,
                                    "protocolVersion": PROTOCOL_VERSION,
                                    "roles": self._roles,
                                },
                            }
                        )
                    )
                    return await self._pump(ws)
                finally:
                    self._current_ws = None
        except websockets.InvalidStatus as exc:
            # A refused upgrade is an HTTP STATUS, and it is the whole
            # 401-vs-403 split.
            return _ending_for_upgrade(exc.response.status_code)
        except Exception:
            # DNS failure, connection refused, a protocol-level handshake
            # error — none of these are the credential's fault.
            return _Ending("reconnect", schedule="exponential")

    async def _pump(self, ws: Any) -> _Ending:
        """Read inbound frames until the connection ends. ``hub/register``'s
        reply and ``hub/replaced`` are consumed here; everything else is MCP
        traffic, relayed to the read stream."""
        while True:
            try:
                raw = await ws.recv()
            except websockets.ConnectionClosed:
                code = ws.close_code if ws.close_code is not None else 1006
                return _ending_for_close(code)
            try:
                frame = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if not isinstance(frame, dict):
                continue
            if frame.get("id") == _REGISTER_ID and ("result" in frame or "error" in frame):
                if "error" in frame:
                    return _Ending(
                        "stop_fatal",
                        error=RegistrationError(f"hub/register rejected: {_message_of(frame['error'])}"),
                    )
                self._first_registered = True
                if not self._ready_event.is_set():
                    self._ready_event.set()
                continue
            if frame.get("method") == HUB_METHOD_REPLACED:
                continue
            # §11/§6: the one MCP-namespace method this library answers itself. The
            # author's SDK never sees it — no SDK implements it, and this library is
            # what knows which families were actually registered.
            if frame.get("method") == _DISCOVER_METHOD:
                await self._answer_discover(ws, frame.get("id"))
                continue
            await self._deliver(frame)

    async def _answer_discover(self, ws: Any, msg_id: Any) -> None:
        """Answer ``server/discover`` directly on the wire — never delivered to
        the SDK session. ``None`` capabilities means "unknown", the fallback
        that keeps every service predating this method warming tools only
        (§6); a real capability set is relayed exactly as the author's SDK
        reports it, in the same DiscoverResult shape the reverse direction
        (hub→consumer) uses."""
        capabilities = self._discover() if self._discover is not None else None
        if capabilities is None:
            payload: dict[str, Any] = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": "server/discover not implemented"},
            }
        else:
            payload = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "supportedVersions": [PROTOCOL_VERSION],
                    "capabilities": capabilities,
                    "resultType": "complete",
                },
            }
        try:
            await ws.send(json.dumps(payload))
        except Exception:
            pass  # the hub closed the socket under us; the close-code path handles it

    async def _deliver(self, frame: dict[str, Any]) -> None:
        try:
            message = jsonrpc_message_adapter.validate_python(frame)
        except Exception as exc:  # a malformed MCP frame — hand the SDK the failure, don't just drop it
            try:
                await self._read_send.send(exc)
            except anyio.BrokenResourceError:
                pass
            return
        try:
            await self._read_send.send(SessionMessage(message))
        except anyio.BrokenResourceError:
            pass

    async def _drain_writes(self) -> None:
        """Send() while the socket is down drops the message and does not
        throw or queue it — the hub re-lists after every registration, so a
        dropped ``notifications/tools/list_changed`` heals itself. Runs for
        the whole transport lifetime, decoupled from any one connection."""
        async for item in self._write_recv:
            ws = self._current_ws
            if ws is None:
                continue
            try:
                payload = item.message.model_dump_json(by_alias=True, exclude_unset=True)
            except Exception:
                continue
            try:
                await ws.send(payload)
            except Exception:
                pass  # a send onto a dying socket is not a failure of whatever was being answered

    def _finish(self, *, error: BaseException | None = None) -> None:
        self._terminal_error = error
        self._read_send.close()
        self._write_recv.close()
        if not self._ready_event.is_set():
            self._ready_event.set()
        self.terminal.set()


@dataclass(frozen=True)
class CallerIdentity:
    """The hub-asserted caller of the current tool call (§7, "Caller identity
    forwarding"). ``principal`` is ``"user:<name>"`` or ``"sa:<slug>"``.
    ``roles`` is the caller's granted role names on this service exactly as
    granted — the built-in wildcard arrives literally as ``"all"`` (owners get
    ``("all",)``), never expanded into declared names. Informational for the
    service's own branching: the hub's grant check has already run, and these
    are not secrets. Constructed by :func:`caller`, never directly."""

    principal: str
    roles: tuple[str, ...] = field(default_factory=tuple)

    def has_role(self, role: str) -> bool:
        """True when ``roles`` contains ``role`` or ``"all"`` — so owner and
        all-granted callers behave identically, and ``all`` can never collide
        with a declared role name (the hub rejects declaring it)."""
        return role in self.roles or "all" in self.roles


def caller(meta: dict[str, Any] | None) -> CallerIdentity:
    """Read the caller identity off a forwarded request's ``_meta``
    (``hub/principal``, ``hub/roles``). Trustworthy for fine-grained
    service-side checks: the hub strips consumer-supplied ``hub/*`` keys before
    injecting its own, so a consumer cannot forge these (§7). On a request that
    never passed through the hub (e.g. local testing) the fields are simply
    absent: ``principal`` is ``""``, ``roles`` is empty, and ``has_role`` is
    uniformly false — no error to handle."""
    principal = (meta or {}).get("hub/principal")
    granted = (meta or {}).get("hub/roles")
    roles = tuple(role for role in granted if isinstance(role, str)) if isinstance(granted, list) else ()
    return CallerIdentity(principal=principal if isinstance(principal, str) else "", roles=roles)


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
    copied = copy.deepcopy(schema)
    for path in paths:
        _mark(copied, path.split("."), path)
    return copied


def _mark(node: dict[str, Any], segments: list[str], path: str) -> None:
    """Sets ``writeOnly`` at one dot-path of a JSON Schema object, refusing an
    absent property."""
    properties = node.get("properties")
    if not isinstance(properties, dict):
        raise ValueError(f'sensitive(): "{path}" names no property in this schema')
    head, *rest = segments
    child = properties.get(head)
    if not isinstance(child, dict):
        raise ValueError(f'sensitive(): "{path}" names no property in this schema')
    if rest:
        _mark(child, rest, path)
    else:
        child["writeOnly"] = True
