"""test_transport.py — HubTransport against an in-process fake hub: the Python
client's half of §6's reverse-connection protocol. What it pins is the
DISCONNECT POLICY — the upgrade statuses (401 fatal vs 403 archived: the split
the whole fatal-vs-retry decision turns on) and the close-code vocabulary
4000-4004, each mapping onto exactly one of three behaviors — ``stop_fatal``,
``stop_quiet``, ``reconnect`` — plus, on the ones that reconnect, a ``schedule``
attribute of ``exponential`` or ``max_only``. Behavior and schedule are separate
axes (contracts/README.md, pinned 2026-08-25): "retry at max backoff" is a
SCHEDULE of reconnect, never a fourth behavior, which is why ReconnectRow below
carries the two in separate columns. Plus the handshake around it: the derived
``wss://<host>/connect`` address, ``hub/register`` re-sent on every (re)connect,
and ``hub/*`` control frames never reaching the SDK's read stream.

Runner: pytest, ``scripts`` + clients lane (§2), ``anyio_mode = "auto"`` on the
asyncio backend (conftest). Every case owns its own fake hub on its own ephemeral
port — no shared listener, no ordering between cases.

Time: no case sleeps. The ``recorded_sleep`` fixture (conftest) replaces the
transport's sleep seam with a recorder, so "retries at max backoff" is a list of
floats compared against ``backoff_delay``'s table (test_api.py), never a literal
and never a wait. The JS side reaches the same place with vitest fake timers;
neither is available to the other, which is why the seam is a production concern
and its absence would be a finding (conftest states the design check).

What the fake hub must NOT fake (strategy §9): the WebSocket upgrade itself —
401 and 403 are real HTTP statuses on a real handshake, and stubbing that erases
the exact distinction under test — JSON-RPC framing (one message per text frame,
real ids), and close codes (a real close with a code, not a synthesized event).
It fakes only the hub's decisions: which status to answer, whether to accept the
registration, when to send ``hub/replaced``.

Durable vs incidental (§7): durable are the code->behavior mapping, its
totality, and that reconnects are invisible to the SDK session. Incidental — never
asserted as a literal — the delay values (they live in test_api.py's schedule
rows) and every message string.

The deps line below names ``conftest.recorded_sleep`` explicitly: a case in this
file that took no sleep recorder and still passed would have waited for real
time somewhere, which is the failure the seam exists to prevent.

Python-specific observation notes (not in the outline docstrings, kept here so
they sit next to what they explain): the Python transport is stream-based, not
callback-based — there is no ``onclose`` callback to count. The terminal state
is nonetheless INTERFACE, not private state this file reaches into (finding,
resolved 2026-08-26 — the JS twin exposed the same decision as ``closed`` while
this one had three privates and two suites reading them): ``transport.terminal``
is an ``anyio.Event`` set exactly once at ANY terminal ending, and
``await transport.closed()`` reports which one it was — returning quietly or
raising, exactly as ``__aexit__`` does. ``__aenter__`` is the twin of JS's
``start()``: it raises only for a terminal ending reached on the very first
attempt; a terminal ending reached AFTER ``__aenter__`` already returned is
observed through ``terminal``/``closed()`` instead, which is why the row runner
below watches both.
"""

# deps: tests/fake_hub.py (the in-process `websockets` hub: chooses upgrade
#   status, accepts/rejects hub/register, closes with a code) ·
#   conftest.recorded_sleep + conftest.anyio_backend · pytest (parametrize) ·
#   anyio · json (one message per text frame) · pmcp_client (HubTransport, serve,
#   CredentialsError, RegistrationError, backoff_delay, and the private
#   _connect_address / _rng / _PING_INTERVAL_S seams) · mcp.server.Server +
#   mcp_types.RequestParams (the REAL SDK, for the §20 rows' capability half only
#   — never faked, strategy §9) · contracts/close-codes.json (read-only — see
#   test_contracts.py)

import json
from typing import Any, NamedTuple

import anyio
import pytest
from mcp.server import Server
from mcp.shared.message import SessionMessage
from mcp_types import RequestParams, jsonrpc_message_adapter

import pmcp_client
from fake_hub import FakeHub, RegisterOutcome, start_fake_hub
from pmcp_client import CredentialsError, HubTransport, RegistrationError, backoff_delay

# An obviously fake service credential — the value every dial is checked to carry.
TOKEN = "pmcp_svc_FAKE0000000000000000000000000000"

# The declaration handed to the constructor, echoed verbatim in hub/register.
ROLES: dict[str, list[str]] = {"reader": ["get_news", "search_.*"]}

# The fixed jitter draw the schedule column is only observable at (ReconnectRow's
# docstring states why): max_only and exponential overlap under a live draw.
DRAW = 0.999

# An attempt whose ceiling is past the cap — how max_only's window is named
# without depending on the library's own internal attempt number.
_PAST_THE_CAP = 40


class _Awaited:
    """Tracks the outcome of a coroutine run in the background — the stream-API
    stand-in for JS's ``watch(promise)``. ``status`` is "pending" until the
    coroutine finishes, then "resolved" or "rejected"."""

    def __init__(self) -> None:
        self.status = "pending"
        self.value: Any = None
        self.error: BaseException | None = None


async def _watch(coro: Any, tracker: _Awaited) -> None:
    try:
        tracker.value = await coro
        tracker.status = "resolved"
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any failure is a "rejected" outcome
        tracker.status = "rejected"
        tracker.error = exc


async def _settle(turns: int = 20) -> None:
    """A few turns of the event loop — enough for a client that MEANT to redial
    (or otherwise react) to have done so."""
    for _ in range(turns):
        await anyio.sleep(0)


class _Session:
    """The session :func:`pmcp_client.serve` takes — the SDK's own entry, spelled
    as the one method the library's ``McpServer`` protocol requires. A real
    ``Server.run`` reads these streams unmodified; draining them is the smallest
    body that behaves the same at the endings these cases are about, and it lives
    in the SUITE rather than as a library fallback so a wrong object passed by a
    service author fails at the call site instead of registering with the hub and
    then discarding every forwarded call."""

    async def run(self, read_stream: Any, write_stream: Any, initialization_options: Any) -> None:
        async for _ in read_stream:
            pass


SESSION = _Session()


def _to_session_message(frame: dict[str, Any]) -> SessionMessage:
    """A raw dict, as a real ``SessionMessage`` ready for ``write_stream.send`` —
    the test-side counterpart of what the library validates on the read side."""
    return SessionMessage(jsonrpc_message_adapter.validate_python(frame))


async def _connected(
    registry: list[tuple[FakeHub | None, HubTransport | None]],
    *,
    upgrades: list[int] | None = None,
    registrations: list[RegisterOutcome] | None = None,
    roles: dict[str, list[str]] | None = ROLES,
) -> tuple[FakeHub, HubTransport]:
    """One fresh hub plus one constructed (not yet entered) transport, torn down
    by the shared ``registry`` fixture."""
    hub = await start_fake_hub(upgrades=upgrades, registrations=registrations)
    transport = HubTransport(hub.origin, TOKEN, roles)
    registry.append((hub, transport))
    return hub, transport


# ── handshake · §6 "Transport", "Framing", "Handshake" ────────────────────────


async def test_constructor_rejects_anything_but_a_bare_origin(registry) -> None:
    """§6 · a URL carrying a path, a query string, or a wss:// URL, is a
    ValueError in __init__ before any I/O; twin: a bare origin constructs and
    dials <host>/connect, derived internally and never passed in."""
    for url in ("https://hub.example.com/mcp", "https://hub.example.com/?token=x", "wss://hub.example.com"):
        with pytest.raises(ValueError):
            HubTransport(url, TOKEN)
    hub, transport = await _connected(registry)
    await transport.__aenter__()
    dial = await hub.next_dial(1)
    assert dial.path == "/connect"


def test_derived_scheme_follows_the_origin_and_is_never_downgraded() -> None:
    """§6/§10 · https:// derives wss://, http:// (the local `wrangler dev` case,
    and what fake_hub hands every case in this file) derives ws:// — a
    pmcp_svc_ credential rides this dial, so the https half is a rule and not a
    convenience."""
    assert pmcp_client._connect_address("https://mcp.example.com") == "wss://mcp.example.com/connect"
    assert pmcp_client._connect_address("http://127.0.0.1:8787") == "ws://127.0.0.1:8787/connect"


async def test_dial_carries_the_service_token_and_no_slug(registry) -> None:
    """§6 · the handshake sends the service token as Authorization: Bearer and
    carries no service or slug anywhere — identity rides the token alone, so a
    token for one slug can never touch another service."""
    hub, transport = await _connected(registry)
    await transport.__aenter__()
    dial = await hub.next_dial(1)
    assert dial.authorization == f"Bearer {TOKEN}"
    register = await hub.next_frame(1)
    params = register.message["params"]
    assert sorted(params.keys()) == ["clientVersion", "protocolVersion", "roles"]


async def test_dial_never_carries_the_token_in_the_address(registry) -> None:
    """§6/§18 d13 · the derived address carries the token NOWHERE: no `?token=`
    query string and no Sec-WebSocket-Protocol fallback — the hub never accepts
    a query-string token, and Dial.path is recorded verbatim precisely to
    witness that the client never sends one."""
    hub, transport = await _connected(registry)
    await transport.__aenter__()
    dial = await hub.next_dial(1)
    assert dial.path == "/connect"
    assert TOKEN not in dial.path
    assert "token" not in pmcp_client._connect_address("https://mcp.example.com")


async def test_no_surfaced_failure_echoes_the_credential(registry) -> None:
    """§15 · nothing the library raises echoes the credential: CredentialsError's
    message never contains the pmcp_svc_ value, so a crashed bot's log cannot
    leak the service's sole secret."""
    hub = await start_fake_hub(upgrades=[401])
    transport = HubTransport(hub.origin, TOKEN)
    registry.append((hub, transport))
    with pytest.raises(CredentialsError) as excinfo:
        await transport.__aenter__()
    message = str(excinfo.value)
    assert TOKEN not in message
    assert "pmcp_svc_" not in message


async def test_idle_connections_are_kept_alive_by_protocol_pings(registry, monkeypatch) -> None:
    """§6 · liveness is WebSocket PROTOCOL ping frames and nothing else (~25 s,
    no application-level heartbeat): an idle connection produces pings, and the
    transport never disables the keepalive it gets from `websockets`. A bot
    behind NAT silently going dark after an idle hour is the failure this is the
    only witness for. The cadence is shortened for the test — the production
    seam is `pmcp_client._PING_INTERVAL_S`, not a fake clock (Python has none)."""
    monkeypatch.setattr(pmcp_client, "_PING_INTERVAL_S", 0.05)
    hub, transport = await _connected(registry)
    await transport.__aenter__()
    await hub.next_frame(1)
    # Observed on the HUB's side of the wire, like every other observation here: the
    # client's own `latency` would only prove that `websockets`' keepalive ran.
    await hub.next_ping(1)
    assert len(hub.pings) > 0
    # The only frame on the wire is still the registration: no application heartbeat.
    assert [frame.message.get("method") for frame in hub.frames] == ["hub/register"]


async def test_aenter_returns_streams_only_after_registration(registry) -> None:
    """§6 · __aenter__ returns the (read, write) stream pair only once
    hub/register is accepted, and the declaration sent is the roles handed to
    the constructor — {} when omitted."""
    hub, transport = await _connected(registry)
    await transport.__aenter__()
    register = await hub.next_frame(1)
    assert register.message["method"] == "hub/register"
    assert register.message["params"]["roles"] == ROLES

    hub2, transport2 = await _connected(registry, roles={})
    await transport2.__aenter__()
    declaration = await hub2.next_frame(1)
    assert declaration.message["params"]["roles"] == {}


async def test_hub_control_frames_never_reach_the_read_stream(registry) -> None:
    """§6 · hub/* frames are consumed internally; ordinary MCP traffic arrives on
    the read stream, one JSON-RPC message per text frame."""
    hub, transport = await _connected(registry)
    read_stream, _write_stream = await transport.__aenter__()
    await hub.next_frame(1)
    await hub.send({"jsonrpc": "2.0", "method": "hub/replaced"})
    await hub.send({"jsonrpc": "2.0", "id": 7, "method": "tools/list"})
    item = await read_stream.receive()
    assert isinstance(item, SessionMessage)
    assert item.message.model_dump(by_alias=True, exclude_unset=True) == {
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/list",
    }


async def test_mrtr_exchange_rides_the_transport_unmodified(registry) -> None:
    """§7 · an MRTR exchange crosses verbatim in both directions: a result
    carrying `resultType: "input_required"` reaches the hub unchanged and a
    retry carrying `inputResponses` + `requestState` reaches the read stream
    unchanged. The transport relays; it never normalizes or strips a field it
    does not understand, which is the whole of §7's relay-verbatim path — and a
    transport that dropped `requestState` would break every approval-spanning
    exchange while still passing the generic MCP-traffic case above."""
    hub, transport = await _connected(registry)
    read_stream, write_stream = await transport.__aenter__()
    await hub.next_frame(1)

    input_required = {
        "jsonrpc": "2.0",
        "id": 11,
        "result": {
            "resultType": "input_required",
            "requestState": "opaque-state",
            "inputRequests": [{"name": "otp"}],
        },
    }
    await write_stream.send(_to_session_message(input_required))
    relayed = await hub.next_frame(2)
    assert relayed.message == input_required

    retry = {
        "jsonrpc": "2.0",
        "id": 12,
        "method": "tools/call",
        "params": {
            "name": "pay",
            "arguments": {},
            "inputResponses": [{"name": "otp", "value": "123456"}],
            "requestState": "opaque-state",
        },
    }
    await hub.send(retry)
    item = await read_stream.receive()
    assert item.message.model_dump(by_alias=True, exclude_unset=True) == retry


async def test_writes_while_the_socket_is_down_are_dropped(registry, recorded_sleep) -> None:
    """§6 · a write with no live socket is dropped, never queued and never an
    error — the hub re-lists after every registration, so a dropped
    notifications/tools/list_changed heals itself."""
    hub, transport = await _connected(registry)
    _read_stream, write_stream = await transport.__aenter__()
    await hub.next_frame(1)
    await hub.drop_connection()
    # Sent while nothing is connected yet (the reconnect is still in flight):
    # dropped, never queued, never raised.
    await write_stream.send(_to_session_message({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}))
    await hub.next_frame(2)  # the second connection's re-registration
    assert [frame.message.get("method") for frame in hub.frames] == ["hub/register", "hub/register"]


async def test_aexit_is_idempotent_and_re_entrant_under_cancellation(registry) -> None:
    """§11 · tearing down twice — including __aexit__ reached by cancellation
    and then again by the caller — changes nothing and raises nothing new: the
    asyncio twin of the JS suite's idempotent close(), and where a double
    teardown would otherwise raise."""
    hub, transport = await _connected(registry)
    await transport.__aenter__()
    await hub.next_frame(1)
    assert await transport.__aexit__(None, None, None) is None
    assert await transport.__aexit__(None, None, None) is None
    assert len(hub.dials) == 1

    hub2, transport2 = await _connected(registry)
    await transport2.__aenter__()
    await hub2.next_frame(1)
    # __aexit__ reached by cancellation: the guard that makes idempotency work
    # (self._exited) is set before the first checkpoint inside it, so a partial
    # teardown here still leaves the second, uncancelled call a pure no-op.
    with anyio.CancelScope() as scope:
        scope.cancel()
        await transport2.__aexit__(None, None, None)
    assert await transport2.__aexit__(None, None, None) is None


# ── reconnection is invisible to the SDK session · §6, §11 ────────────────────


async def test_reconnect_reregisters_and_keeps_the_streams_open(registry, recorded_sleep) -> None:
    """§6 · a mid-life drop reconnects and re-sends hub/register while the
    yielded streams stay open — one transport is one service lifetime, not one
    socket."""
    hub, transport = await _connected(registry)
    await transport.__aenter__()
    await hub.next_frame(1)
    await hub.drop_connection()
    redial = await hub.next_dial(2)
    reregistration = await hub.next_frame(2)
    assert redial.seq == 2
    assert reregistration.message["method"] == "hub/register"
    # The observation that makes it a RE-registration rather than a repeat: a second socket.
    assert reregistration.connection == 2
    assert not transport.terminal.is_set()


async def test_reconnect_delays_follow_the_shared_schedule(registry, recorded_sleep, monkeypatch) -> None:
    """§6 · the delays the reconnect loop asks for are exactly backoff_delay's
    answers for successive attempts 0, 1, 2, ... — the loop owns no schedule of
    its own, and no wall-clock time passes. Scoped to that schedule
    deliberately: the max_only rows are backoff_delay at the capped ceiling
    rather than at a rising attempt, and ReconnectRow.schedule states how the
    two are told apart."""
    monkeypatch.setattr(pmcp_client, "_rng", lambda: DRAW)
    # 500 at upgrade: an ending that reconnects on the ordinary exponential
    # schedule, so the attempts run 0, 1, 2 with nothing resetting them.
    hub, transport = await _connected(registry, upgrades=[500])
    async with anyio.create_task_group() as tg:
        tg.start_soon(_watch, transport.__aenter__(), _Awaited())
        await hub.next_dial(4)
        tg.cancel_scope.cancel()
    expected = [backoff_delay(attempt, lambda: DRAW) for attempt in (0, 1, 2)]
    assert recorded_sleep[:3] == expected


async def test_unarchiving_heals_without_touching_the_bot(registry, monkeypatch, recorded_sleep) -> None:
    """§6 · the hub refuses 403 until the client is provably retrying, then
    accepts — and the very next dial connects and re-registers. The upgrade:403
    row pins that the client keeps dialing; this pins what the dialing is FOR,
    and it is the one §6 sentence about an archived service that a retry count
    alone cannot witness. The JS twin is the same row against the same seam
    (``FakeHub.setUpgrades``)."""
    monkeypatch.setattr(pmcp_client, "_rng", lambda: DRAW)
    hub = await start_fake_hub(upgrades=[403])
    transport = HubTransport(hub.origin, TOKEN, ROLES)
    registry.append((hub, transport))
    async with anyio.create_task_group() as tg:
        tg.start_soon(_watch, transport.__aenter__(), _Awaited())
        # Provably retrying: two refused dials, and nothing connected.
        await hub.next_dial(2)
        assert hub.connection_count() == 0
        # The world changes — the service is unarchived — and nothing about the bot does.
        hub.set_upgrades([101])
        registration = await hub.next_frame(1)
        assert registration.message["method"] == "hub/register"
        assert not transport.terminal.is_set()
        tg.cancel_scope.cancel()


async def test_terminal_endings_close_the_yielded_streams(registry) -> None:
    """§6/§11 · at a terminal ending the transport CLOSES the yielded streams,
    which is what lets the SDK session body return and __aexit__ run at all.
    Without this, `terminal` below is an absence rather than an observation: a
    transport that went fatal on a revoked credential without closing the
    streams would leave the bot blocked forever on a dead credential while
    every terminal row waited for an exit that never comes. The alive twin is
    test_reconnect_reregisters_and_keeps_the_streams_open above."""
    hub, transport = await _connected(registry)
    read_stream, _write_stream = await transport.__aenter__()
    await hub.next_frame(1)
    await hub.close_connection(4001)
    with pytest.raises(anyio.EndOfStream):
        await read_stream.receive()
    with pytest.raises(CredentialsError):
        await transport.__aexit__(None, None, None)


async def test_serve_mirrors_the_transports_terminal_outcomes(registry) -> None:
    """§11 · serve() returns quietly after a replacement and raises the same
    error class otherwise, so the policy is decided in HubTransport and nowhere
    else."""
    quiet = await start_fake_hub()
    registry.append((quiet, None))
    async with anyio.create_task_group() as tg:
        served = _Awaited()
        tg.start_soon(_watch, pmcp_client.serve(SESSION, url=quiet.origin, token=TOKEN, roles=ROLES), served)
        await quiet.next_frame(1)
        await quiet.replace()
        with anyio.fail_after(5):
            while served.status == "pending":
                await anyio.sleep(0)
        assert served.status == "resolved"

    dead = await start_fake_hub(upgrades=[401])
    registry.append((dead, None))
    with pytest.raises(CredentialsError):
        await pmcp_client.serve(SESSION, url=dead.origin, token=TOKEN)

    refused = await start_fake_hub(registrations=[RegisterOutcome(error={"code": -32602, "message": "bad role name"})])
    registry.append((refused, None))
    with pytest.raises(RegistrationError):
        await pmcp_client.serve(SESSION, url=refused.origin, token=TOKEN, roles={"All": []})


async def test_serve_resolves_url_and_token_before_any_io(registry, monkeypatch) -> None:
    """§10/§11 · serve() resolves its options before a socket exists: url and
    token default to PMCP_URL and PMCP_SERVICE_TOKEN, an explicit argument wins
    over the env var, and neither being set is a ValueError with no dial
    attempted. An empty token dialed anyway comes back as upgrade 401 and is
    then classified as a dead credential, turning a local config mistake into a
    revoked-token diagnosis. The env path is the one real services use, so it
    is the untested path in production until this case exists."""
    from_env = await start_fake_hub()
    explicit = await start_fake_hub()
    registry.append((from_env, None))
    registry.append((explicit, None))

    monkeypatch.delenv("PMCP_URL", raising=False)
    monkeypatch.delenv("PMCP_SERVICE_TOKEN", raising=False)

    with pytest.raises(ValueError):
        await pmcp_client.serve(SESSION)
    with pytest.raises(ValueError):
        await pmcp_client.serve(SESSION, url=from_env.origin)
    assert len(from_env.dials) == 0

    monkeypatch.setenv("PMCP_URL", from_env.origin)
    monkeypatch.setenv("PMCP_SERVICE_TOKEN", TOKEN)

    async with anyio.create_task_group() as tg:
        defaulted = _Awaited()
        tg.start_soon(_watch, pmcp_client.serve(SESSION), defaulted)
        await from_env.next_frame(1)
        await from_env.replace()
        with anyio.fail_after(5):
            while defaulted.status == "pending":
                await anyio.sleep(0)
        assert defaulted.status == "resolved"

    async with anyio.create_task_group() as tg:
        overridden = _Awaited()
        tg.start_soon(_watch, pmcp_client.serve(SESSION, url=explicit.origin), overridden)
        # Wait for the FRAME, not just the dial: `replace()` only affects
        # connections already accepted into the hub's open set, and the
        # upgrade (dial) is recorded slightly before that.
        await explicit.next_frame(1)
        assert len(from_env.dials) == 1
        await explicit.replace()
        with anyio.fail_after(5):
            while overridden.status == "pending":
                await anyio.sleep(0)
        assert overridden.status == "resolved"


# ── the data model beyond tools · §20, §11 ────────────────────────────────────
# §20.6 pins "no new API beyond the widened `roles` shape", so what this library
# gains is exactly three things: the widened declaration going out untouched, the
# one MCP-namespace method the LIBRARY answers instead of bridging
# (`server/discover`, §11/§6), and the prompt/resource traffic the bridge already
# carries. The last is a regression pin rather than new behaviour — §20 opens by
# saying a tunneled service that declares prompts answers them over the socket
# TODAY and the hub was the only thing saying -32601 — and pinning it is what
# keeps a future frame-inspecting transport from quietly becoming a tools-only
# one. Every row drives `serve()` rather than HubTransport, because the surface
# these rows may touch is exactly the surface a service author has.

#: The capability families §20 knows. ``completions`` is here so a library that
#: declared it unasked is visible, not because any row expects it.
_FAMILIES = ("tools", "prompts", "resources", "completions")

#: The correlation id the hub puts on its own ``server/discover`` — the HUB's id,
#: never one the library minted (it originates exactly one request, hub/register).
_DISCOVER_ID = "hub-discover-1"

#: §20.3's two spellings in ONE declaration — the example the spec itself writes.
#: Annotated against the library's own :data:`pmcp_client.Roles`, the way the JS
#: twin types its ``MIXED_ROLES`` against the exported ``Roles``. Python does not
#: enforce an annotation at runtime and this package has no type checker in the
#: exit criteria, so the annotation alone would let an un-widened alias ride
#: through invisibly while every type-checked service author was told the
#: per-family declaration is invalid — §11 pins the two libraries as "identical
#: shape … the same two spellings", so the alias is asserted as a value in the row
#: that uses it.
_MIXED_ROLES: pmcp_client.Roles = {
    "reader": ["get_news", "search_.*"],
    "curator": {"tools": ["publish"], "prompts": ["digest_.*"], "resources": ["news://feed/*"]},
}

#: A declaration the HUB rejects — §20.3 makes an unknown family key a violation
#: like any other. Nothing about it is this library's to notice.
_REJECTED_ROLES: dict[str, Any] = {"curator": {"toolz": ["publish"]}}

#: What the author's server answers a ``prompts/get`` with: §20.1's message list.
#: Content blocks, which is why §15 stubs them in the ledger rather than storing
#: the text.
_PROMPT_RESULT = {
    "description": "a digest",
    "messages": [{"role": "user", "content": {"type": "text", "text": "headlines"}}],
}

#: …and §21.4's per-URI methods: the one result the author's SDK answers with.
#: Shaped like MCP's own definition (a subscription that took, an unsubscription
#: that took) and distinctive enough that the round-trip rows can tell the
#: response from a nil.
_SUBSCRIBE_RESULT = {"resultType": "complete"}
#: …and a ``resources/read``: contents keyed by the URI the service itself knows.
_RESOURCE_URI = "news://feed/tech"
_RESOURCE_RESULT = {"contents": [{"uri": _RESOURCE_URI, "mimeType": "text/plain", "text": "headline"}]}


class _AuthorService:
    """The author's service as :func:`pmcp_client.serve` receives it — §11's
    "plain MCP server written with the official SDK".

    The CAPABILITY half is a real ``mcp.server.Server``: ``get_capabilities()``
    derives the families from the request handlers actually registered on it, so
    "the families the author's SDK actually registered" is the SDK's answer here
    and not this suite's paraphrase of one. That is what §11 means by "the library
    is what knows which families the author registered", and it is the half the JS
    twin cannot have (that package has no SDK dependency, so its fake hands the
    capabilities in).

    The RUN half is the suite's, like :class:`_Session` above and for the same
    reason: a real ``Server.run`` waits for the MCP ``initialize`` §6 keeps off
    this wire — the library synthesizes whatever bootstrap its local SDK needs —
    and driving that bootstrap end to end is ``scripts/e2e.ts``'s job. What these
    rows need from a session is that it RECORD what reached it and answer what it
    was scripted to, and ``reached`` records at arrival, before any scripted answer
    runs, which is what makes "the request never reaches the SDK" an observation
    rather than an absence.
    """

    def __init__(self, *registers: str, answers: dict[str, Any] | None = None) -> None:
        self.sdk = Server("author")
        for method in registers:
            # Registration is the whole declaration: the handler is never invoked
            # here, because what a family costs the SDK is a handler EXISTING.
            self.sdk.add_request_handler(method, RequestParams, self._never_called)
        self.reached: list[dict[str, Any]] = []
        self._answers = answers or {}
        self._write: Any = None
        self._running = anyio.Event()

    async def _never_called(self, ctx: Any, params: Any) -> None:
        raise AssertionError("the suite's run() answers; the SDK's handlers are the declaration")

    def get_capabilities(self) -> Any:
        """What the author's SDK registered — never what this library can carry."""
        return self.sdk.get_capabilities()

    def create_initialization_options(self) -> Any:
        """The same answer by the route ``serve()`` already takes today."""
        return self.sdk.create_initialization_options()

    async def run(self, read_stream: Any, write_stream: Any, initialization_options: Any) -> None:
        self._write = write_stream
        self._running.set()
        async for item in read_stream:
            if isinstance(item, Exception):
                continue
            frame = item.message.model_dump(by_alias=True, exclude_unset=True)
            self.reached.append(frame)
            answer = self._answers.get(frame.get("method", ""))
            if answer is not None and "id" in frame:
                await write_stream.send(
                    _to_session_message({"jsonrpc": "2.0", "id": frame["id"], "result": answer})
                )

    async def emit(self, frame: dict[str, Any]) -> None:
        """One notification the author's SDK emits on its own — the outbound half
        of the bridge, and a pass-through rather than a library feature (§11)."""
        with anyio.fail_after(5):
            await self._running.wait()
        await self._write.send(_to_session_message(frame))


def _families_in(frame: dict[str, Any]) -> list[str]:
    """The families one ``server/discover`` answer names, sorted.

    Read off ``result.capabilities`` and intersected with §20.3's vocabulary,
    because an SDK's capability object also carries keys that are not families
    (``experimental``, ``extensions``) — what the hub reads from this answer is
    which catalogs to warm, and that is a question about families alone."""
    capabilities = (frame.get("result") or {}).get("capabilities") or {}
    return sorted(key for key in capabilities if key in _FAMILIES)


def _declared_roles(hub: FakeHub) -> dict[str, Any]:
    """The declaration the hub really received on the first frame."""
    return hub.frames[0].message["params"]["roles"]


async def _serving_author(
    registry: list[tuple[FakeHub | None, HubTransport | None]],
    tg: Any,
    service: _AuthorService,
    roles: dict[str, Any] | None = None,
) -> FakeHub:
    """One author's service running against one fresh hub, registered — the shape
    every §20 row starts from. serve() owns the transport, so only the hub goes on
    the teardown registry; cancelling the task group is what ends the run."""
    hub = await start_fake_hub()
    registry.append((hub, None))
    tg.start_soon(
        _watch,
        pmcp_client.serve(service, url=hub.origin, token=TOKEN, roles=ROLES if roles is None else roles),
        _Awaited(),
    )
    await hub.next_frame(1)
    return hub


async def test_serve_passes_a_bare_pattern_list_through_unchanged(registry, recorded_sleep) -> None:
    """§11/§20.3 · serve({roles}) passes a bare pattern list through to
    hub/register unchanged.

    Unchanged means UNNORMALIZED: ``["get_news"]`` becoming ``{"tools":
    ["get_news"]}`` is the hub's business (§20.3 — normalization happens once, in
    registry.validate_roles and the filter builder), and a library that did it here
    would be a second rule that could disagree with the first."""
    async with anyio.create_task_group() as tg:
        hub = await _serving_author(registry, tg, _AuthorService("tools/list"), roles=ROLES)
        declared = _declared_roles(hub)
        assert declared == ROLES
        assert isinstance(declared["reader"], list)
        tg.cancel_scope.cancel()


async def test_serve_passes_a_per_family_object_through_unchanged(registry, recorded_sleep) -> None:
    """§11/§20.3 · serve({roles}) passes a per-family object through unchanged —
    the library normalizes nothing.

    The two spellings survive SIDE BY SIDE in one declaration (§20.3's own
    example): the object is not flattened to its tools, and the bare list beside it
    is not lifted into an object. Either repair would make the wire a function of
    which library sent it."""
    # The PUBLIC alias, as a value. `Roles` is in `__all__`, so §11's "identical
    # shape … the same two spellings" is a claim about it — and the JS twin makes
    # that claim fail at `tsc` by typing its declaration against the exported
    # `Roles`. Nothing type-checks this package (no mypy, no pyright, and the exit
    # criteria run `uv run pytest` alone), so an un-widened alias would leave the
    # rest of this row green while every annotated service author was told the
    # per-family declaration is invalid. GenericAlias and UnionType both compare by
    # value, so the pin is a plain equality.
    assert pmcp_client.Roles == dict[str, list[str] | dict[str, list[str]]]
    async with anyio.create_task_group() as tg:
        service = _AuthorService("tools/list", "prompts/list", "resources/list")
        hub = await _serving_author(registry, tg, service, roles=_MIXED_ROLES)
        declared = _declared_roles(hub)
        assert declared == _MIXED_ROLES
        assert declared["curator"] == _MIXED_ROLES["curator"]
        assert isinstance(declared["reader"], list)
        tg.cancel_scope.cancel()


async def test_a_roles_value_the_hub_rejects_is_still_sent_as_written(registry, recorded_sleep) -> None:
    """§11/§20.3 · a roles value the hub will reject is still sent as written; the
    library surfaces the hub's rejection rather than pre-validating.

    AS WRITTEN: not repaired into ``{"tools": [...]}``, not dropped, not refused
    locally. §20.3 gives the family vocabulary exactly one validator and it is the
    hub's — a library that pre-validated would be a second one, and the day they
    disagreed the author would get a local error for a declaration the hub was
    perfectly happy with. What the author sees instead is the HUB's refusal,
    surfaced rather than retried: identical input cannot start succeeding (§6)."""
    refusing = await start_fake_hub(
        registrations=[RegisterOutcome(error={"code": -32602, "message": "unknown role family"})]
    )
    registry.append((refusing, None))
    with pytest.raises(RegistrationError):
        await pmcp_client.serve(
            _AuthorService("tools/list"), url=refusing.origin, token=TOKEN, roles=_REJECTED_ROLES
        )
    assert _declared_roles(refusing) == {"curator": {"toolz": ["publish"]}}
    assert len(refusing.dials) == 1


async def test_the_library_answers_server_discover_itself(registry, recorded_sleep) -> None:
    """§11/§6 · the library answers the hub's server/discover itself with the
    families the author's SDK actually registered — the author writes nothing, and
    the request never reaches the SDK.

    §11 makes this the one MCP-namespace method the library handles instead of
    bridging: it is a hub↔library control question, and the library is what knows
    which families were registered. The author wrote no handler for it."""
    async with anyio.create_task_group() as tg:
        service = _AuthorService("tools/list", "prompts/list", "resources/list")
        hub = await _serving_author(registry, tg, service)
        await hub.send({"jsonrpc": "2.0", "id": _DISCOVER_ID, "method": "server/discover"})
        answer = await hub.next_frame(2)
        assert answer.message["id"] == _DISCOVER_ID
        assert _families_in(answer.message) == ["prompts", "resources", "tools"]
        assert "server/discover" not in [frame.get("method") for frame in service.reached]
        tg.cancel_scope.cancel()


async def test_a_tools_only_sdk_answers_server_discover_with_tools_alone(registry, recorded_sleep) -> None:
    """§11/§6 · a service whose SDK registers only tools answers server/discover
    with tools alone — the declaration is observed, not assumed from the library's
    own capabilities.

    The library CAN carry all three — the bridge is transparent, and the two
    round-trip rows below prove it — so answering with what the LIBRARY can do
    rather than with what the AUTHOR registered would make every tools-only service
    in the field log three spurious catalog-warm failures at the hub (§6/§20.5).
    That is the whole reason the discover leg exists."""
    async with anyio.create_task_group() as tg:
        service = _AuthorService("tools/list")
        hub = await _serving_author(registry, tg, service)
        await hub.send({"jsonrpc": "2.0", "id": _DISCOVER_ID, "method": "server/discover"})
        answer = await hub.next_frame(2)
        assert _families_in(answer.message) == ["tools"]
        assert "server/discover" not in [frame.get("method") for frame in service.reached]
        tg.cancel_scope.cancel()


async def test_a_service_the_library_cannot_introspect_answers_discover_32601(registry, recorded_sleep) -> None:
    """§11/§6 · a service object the library cannot introspect for capabilities
    answers server/discover with -32601 — the "capabilities unknown" signal — and
    never a successful empty capability set, because a successful answer that omits
    a family is an UNDECLARE and §20.5 makes an undeclare clear that family's
    catalog.

    §11 pins the answer for a server with no capability seam: the -32601 reaches
    the hub, which warms tools only, "which is what keeps every service already in
    the field working unchanged". §20.5 is why the plausible repair is worse than
    the fallback — a discover leg that ERRORS changes no catalog, while a
    successful ``{}`` tells the hub this service no longer serves prompts or
    resources and clears both catalogs for a service that is serving them right
    now. Failure never empties one; success does, so the absence of a seam must
    stay a failure. Observed on the frame the HUB sees, never on a library
    internal."""
    async with anyio.create_task_group() as tg:
        # SESSION is the bare protocol — `run` and nothing else, which is exactly
        # what an author's server that predates §20 looks like to this library.
        hub = await start_fake_hub()
        registry.append((hub, None))
        tg.start_soon(
            _watch,
            pmcp_client.serve(SESSION, url=hub.origin, token=TOKEN, roles=ROLES),
            _Awaited(),
        )
        await hub.next_frame(1)
        await hub.send({"jsonrpc": "2.0", "id": _DISCOVER_ID, "method": "server/discover"})
        answer = await hub.next_frame(2)
        assert answer.message["id"] == _DISCOVER_ID
        assert answer.message["error"]["code"] == -32601
        assert "result" not in answer.message
        tg.cancel_scope.cancel()


async def test_a_prompts_get_reaches_the_authors_server_and_answers_over_the_socket(
    registry, recorded_sleep
) -> None:
    """§11/§20.1 · a prompts/get request from the hub reaches the author's SDK
    server and its response returns over the socket.

    Both directions verbatim: the request arrives exactly as the hub sent it —
    ``arguments`` included, which is what the hub's redact map keys on (§20.3) —
    and the answer goes back on the socket the hub asked over."""
    async with anyio.create_task_group() as tg:
        service = _AuthorService("tools/list", "prompts/list", answers={"prompts/get": _PROMPT_RESULT})
        hub = await _serving_author(registry, tg, service)
        request = {
            "jsonrpc": "2.0",
            "id": 21,
            "method": "prompts/get",
            "params": {"name": "digest", "arguments": {"topic": "ai"}},
        }
        await hub.send(request)
        relayed = await hub.next_frame(2)
        assert service.reached == [request]
        assert relayed.message == {"jsonrpc": "2.0", "id": 21, "result": _PROMPT_RESULT}
        tg.cancel_scope.cancel()


async def test_a_resources_read_round_trips_the_same_way(registry, recorded_sleep) -> None:
    """§11/§20.1 · a resources/read request round-trips the same way.

    The URI the service knows is the URI it is asked for and the URI it answers
    with: §20.2 refuses to rewrite one anywhere, which is why resources are
    scoped-only."""
    async with anyio.create_task_group() as tg:
        service = _AuthorService("tools/list", "resources/list", answers={"resources/read": _RESOURCE_RESULT})
        hub = await _serving_author(registry, tg, service)
        request = {"jsonrpc": "2.0", "id": 22, "method": "resources/read", "params": {"uri": _RESOURCE_URI}}
        await hub.send(request)
        relayed = await hub.next_frame(2)
        assert service.reached == [request]
        assert relayed.message == {"jsonrpc": "2.0", "id": 22, "result": _RESOURCE_RESULT}
        assert _RESOURCE_URI in json.dumps(relayed.message)
        tg.cancel_scope.cancel()


async def test_a_prompts_list_changed_notification_reaches_the_hub_unchanged(registry, recorded_sleep) -> None:
    """§11/§20.5 · a prompts/list_changed notification emitted by the author's SDK
    reaches the hub unchanged.

    A pass-through, not a feature (§11): the DO routes this frame to invalidate its
    ``catalog:prompts`` key (§20.5), so a library that swallowed or renamed it would
    leave the hub serving a stale prompt list until the next registration."""
    async with anyio.create_task_group() as tg:
        service = _AuthorService("tools/list", "prompts/list")
        hub = await _serving_author(registry, tg, service)
        notification = {"jsonrpc": "2.0", "method": "notifications/prompts/list_changed"}
        await service.emit(notification)
        relayed = await hub.next_frame(2)
        assert relayed.message == notification
        tg.cancel_scope.cancel()


# ── §21.4's per-URI push, from the author's side ─────────────────────────────
# Subscribe, unsubscribe and ``resources/updated`` are to the bridge what reads
# and the list_changed notifications are: ordinary framed MCP traffic the library
# neither recognizes nor stashes. A library that kept its own subscription set
# would contradict the "session-scoped, lives on the socket" lifetime §21.4 pins,
# no matter how useful the shortcut looked.


async def test_a_resources_subscribe_and_unsubscribe_round_trip(registry, recorded_sleep) -> None:
    """§11/§21.4 · a resources/subscribe from the hub reaches the author's SDK
    and its response returns over the socket — the library keeps no subscription
    set · resources/unsubscribe round-trips identically.

    Both directions verbatim: the request arrives at the author's SDK exactly as
    the hub sent it — URI included, which §21.4 keys on — and the answer goes
    back on the socket the hub asked over. The no-set half of the row: the SAME
    URI subscribed TWICE reaches the SDK twice — a library that retained
    subscriptions would dedupe, cache, or prefetch here and the second ask would
    vanish, but the set lives on the hub's socket (§21.4), never in the library,
    so there is nothing to remember."""
    async with anyio.create_task_group() as tg:
        service = _AuthorService(
            "tools/list",
            "resources/list",
            answers={"resources/subscribe": _SUBSCRIBE_RESULT, "resources/unsubscribe": _SUBSCRIBE_RESULT},
        )
        hub = await _serving_author(registry, tg, service)
        subscribe = {
            "jsonrpc": "2.0",
            "id": 23,
            "method": "resources/subscribe",
            "params": {"uri": _RESOURCE_URI},
        }
        await hub.send(subscribe)
        relayed = await hub.next_frame(2)
        assert service.reached == [subscribe]
        assert relayed.message == {"jsonrpc": "2.0", "id": 23, "result": _SUBSCRIBE_RESULT}
        await hub.send(subscribe)
        again = await hub.next_frame(3)
        assert service.reached == [subscribe, subscribe]
        assert again.message == {"jsonrpc": "2.0", "id": 23, "result": _SUBSCRIBE_RESULT}
        unsubscribe = {
            "jsonrpc": "2.0",
            "id": 24,
            "method": "resources/unsubscribe",
            "params": {"uri": _RESOURCE_URI},
        }
        await hub.send(unsubscribe)
        unrelayed = await hub.next_frame(4)
        assert service.reached == [subscribe, subscribe, unsubscribe]
        assert unrelayed.message == {"jsonrpc": "2.0", "id": 24, "result": _SUBSCRIBE_RESULT}
        tg.cancel_scope.cancel()


async def test_a_resources_updated_crosses_verbatim_without_any_subscribe(registry, recorded_sleep) -> None:
    """§11/§21.4 · a notifications/resources/updated the SDK emits crosses the
    socket verbatim, its uri untouched — for a URI no subscribe ever crossed this
    socket, so a library that secretly kept a set would fail it.

    The DO routes this frame by EXACT uri match against the subscriber socket's
    set (§21.4) — nothing for the SDK session to do, and nothing for a transparent
    bridge to decide. A library that kept a set would have nothing to match
    against and (in the eager spelling of that bug) silence the relay; a library
    that filters would send a frame that is NOT this one. The observed wire is
    both frames, in order."""
    async with anyio.create_task_group() as tg:
        service = _AuthorService("tools/list", "resources/list")
        hub = await _serving_author(registry, tg, service)
        updated = {
            "jsonrpc": "2.0",
            "method": "notifications/resources/updated",
            "params": {"uri": f"{_RESOURCE_URI}/late"},
        }
        await service.emit(updated)
        relayed = await hub.next_frame(2)
        assert relayed.message == updated
        assert [frame.message["method"] for frame in hub.frames] == [
            "hub/register",
            "notifications/resources/updated",
        ]
        tg.cancel_scope.cancel()


# ── the policy itself · §6 upgrade matrix + close codes ───────────────────────
# The table below — one parametrized case per row, each refusal ending (401,
# 4001, a rejected registration) authored beside an ending that keeps the
# connection alive, so a transport that gives up on everything cannot pass
# (strategy §9 rule 2).


class Trigger(NamedTuple):
    """How a connection ended — the row's INPUT, driven by the fake hub. §6 gives
    the policy four kinds of input and the client must not conflate them: a
    refused upgrade (an HTTP status, before any frame), a close code (after
    establishment), a rejected registration (a JSON-RPC error reply), and an
    ordinary transport failure. ``code`` carries the status or close code and is
    None for the two that have neither.

    A shape rather than the fixture's ``"upgrade:401"`` string (finding, resolved
    2026-08-26): the runner used to re-parse that string three times — two
    prefix tests and two ``split(":")`` calls — reconstructing structure the row
    could simply carry, which is what the JS ``PolicyTrigger`` union does. The
    fixture's canonical KEY is still a string, and joining on it is
    test_contracts's ``_trigger_key`` — which now actually joins instead of
    being an admitted identity function."""

    kind: str  # "upgrade" | "close" | "register-rejected" | "network-drop"
    code: int | None = None


class ReconnectRow(NamedTuple):
    """One row of §6's reconnect policy, transcribed from the shared close-code
    contract fixture (§4) — the deliberate cross-language duplication: the JS
    table in ``clients/js/test/transport.test.ts`` transcribes the same fixture,
    and test_contracts.py pins that this transcription is total in both
    directions.

    The columns are the observable consequences, chosen so no two behaviors share
    a signature: does the fake hub see another dial (``redials``), on which
    schedule (``schedule`` — named, never a seconds literal), does the context
    manager exit at all (``terminal`` — a reconnecting ending must NEVER exit,
    which is what makes "reconnect" observably different from "stop") — as
    observed via ``HubTransport.terminal``, since a close-code row
    reaches its ending well after ``__aenter__`` already returned — and with
    what (``raises``, naming the real class so a rename breaks the table
    instead of silently matching nothing; None means it exits quietly).

    The fixture's three behavior words land on these columns one-to-one:
    ``stop_quiet`` -> terminal with no ``raises``, ``stop_fatal`` -> terminal
    with one, ``reconnect`` -> not terminal, and only then does ``schedule``
    mean anything. The mapping is total in both directions, which is what lets
    test_contracts.py check a row against a fixture entry without either side
    owning a fourth word.

    OBSERVING ``schedule``, resolved 2026-08-26: the schedule is full jitter from
    zero, so ``max_only`` draws over [0, 60 s] and ``exponential`` over
    [0, 1 s]·2**n and the two windows OVERLAP at every attempt — no recorded
    delay under a live ``random.random`` distinguishes them, and a client that
    ran BOTH archived endings as ordinary exponential backoff (hammering an
    archived service every ~1 s instead of ~30 s) would pass a table that only
    read delays. The runner therefore fixes the draw — the same seeded stub
    test_api.py's schedule table uses — and reads the resulting CEILING. That
    also settles the reading: ``max_only`` means the ceiling stops doubling and
    stays at the cap; "keep retrying at max backoff" bounds the WINDOW and is
    never a floor under the wait (test_api.py's attempt-40-with-a-draw-of-0 row
    is the same sentence from the other side).

    DESIGN CHECK (strategy §6), the same shape as conftest's sleep seam: the
    draw must be injectable to be fixed. RESOLVED — ``pmcp_client._rng`` is a
    bare module-level function precisely so this table can pin it with
    ``monkeypatch.setattr``, the same shape as the sleep seam in conftest.
    """

    spec: str  # printed in the case id, e.g. "§6 · close 4002 · archived reconnects on the max_only schedule"
    trigger: Trigger  # how the connection ended — a shape, not a string the runner re-parses
    redials: bool  # `redials is True` IS the fixture's `reconnect` behavior
    schedule: str | None  # the fixture's schedule attribute: "exponential" | "max_only"; None when it does not reconnect
    terminal: bool
    raises: type[CredentialsError] | type[RegistrationError] | None


# Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
# rule 1) — agents never fill them. The oracle is §6's upgrade matrix and
# close-code list, and the contracts fixture derived from them; rows are written
# from the spec, never from the library.
RECONNECT_ROWS: list[ReconnectRow] = [
    ReconnectRow(
        spec="§6 · upgrade:401 · the credential is dead — absent, invalid, expired, revoked, of the wrong kind, or naming a service row that is gone or proxied. The handshake never completes, the context manager exits with CredentialsError, and the hub records no second dial.",
        trigger=Trigger("upgrade", 401),
        redials=False,
        schedule=None,
        terminal=True,
        raises=CredentialsError,
    ),
    ReconnectRow(
        spec="§6 · upgrade:403 · archived, and nothing else — the client keeps dialing at max backoff so that unarchiving heals the service without anyone touching the bot. The alive twin of the 401 row above.",
        trigger=Trigger("upgrade", 403),
        redials=True,
        schedule="max_only",
        terminal=False,
        raises=None,
    ),
    ReconnectRow(
        spec="§6 · close:4000 · a newer connection took this service's slot (hub/replaced, then the close). The context manager exits WITHOUT an error and does not dial again — two copies of one bot competing for the slot is an operator problem to surface, not to retry.",
        trigger=Trigger("close", 4000),
        redials=False,
        schedule=None,
        terminal=True,
        raises=None,
    ),
    ReconnectRow(
        spec="§6 · close:4001 · the token was revoked or the service deleted after the socket was already up. Same ending as 401: exit with CredentialsError, and no retry loop on a credential that cannot come back.",
        trigger=Trigger("close", 4001),
        redials=False,
        schedule=None,
        terminal=True,
        raises=CredentialsError,
    ),
    ReconnectRow(
        spec="§6 · close:4002 · the service was archived while connected, so the hub severs the socket and the client resumes dialing at max backoff — the archived policy again, this time reached after establishment.",
        trigger=Trigger("close", 4002),
        redials=True,
        schedule="max_only",
        terminal=False,
        raises=None,
    ),
    ReconnectRow(
        spec="§6 · close:4003 · the service row vanished between the upgrade and hub/register. The client backs off exponentially rather than giving up: if the row is genuinely gone the next upgrade answers 401, which is where the fatal ending lives.",
        trigger=Trigger("close", 4003),
        redials=True,
        schedule="exponential",
        terminal=False,
        raises=None,
    ),
    ReconnectRow(
        spec="§6 · close:4004 · a protocol violation or a registration that missed the 10 s deadline is an ordinary disconnect — back off exponentially and try the handshake again.",
        trigger=Trigger("close", 4004),
        redials=True,
        schedule="exponential",
        terminal=False,
        raises=None,
    ),
]


# The endings the fixture does NOT key, and why they need their own table
# (finding, resolved 2026-08-26). contracts/close-codes.json keys seven entries,
# all ``close:NNNN`` or ``upgrade:NNN``. Three endings §6 nonetheless gives the
# client have no key there, so a row for one of them in RECONNECT_ROWS would fail
# test_contracts.test_every_policy_row_names_a_fixture_ending — which is why the
# register-rejected row was missing from BOTH languages even though
# ReconnectRow.trigger's docstring enumerates it, the section comment above
# promises it, and ``raises: type[RegistrationError]`` exists for nothing else.
#
# They are pinned here instead and run by the same runner. What each costs if
# unpinned: a bot that retried a REJECTED DECLARATION would hammer the hub's
# registration path forever holding a perfectly valid service token; a transport
# that treated a bare TCP drop or a close code outside 4000-4004 as fatal would go
# dark on every hub deploy. "Unknown means reconnect" is the safe default D7's
# verified slice already had to decide privately (``CLOSE_POLICY[code] ?? "reconnect"``
# in scripts/thin-serve.ts, deleted at D8 — the table now lives in
# clients/js/src/index.ts) and nothing asserted. The refusal here
# carries its alive twin in the same table (strategy §9 rule 2).
UNLISTED_ROWS: list[ReconnectRow] = [
    ReconnectRow(
        spec="§6 · register-rejected · a refused hub/register (bad role name, non-compiling pattern, over caps) is a JSON-RPC ERROR REPLY, not a close code, and it is terminal: RegistrationError, and the hub records no further dial. Identical input cannot start succeeding, so retrying a refused declaration is an infinite loop against the hub.",
        trigger=Trigger("register-rejected"),
        redials=False,
        schedule=None,
        terminal=True,
        raises=RegistrationError,
    ),
    ReconnectRow(
        spec="§6 · network-drop · a bare TCP sever with no close frame at all — what a hub deploy and a network failure actually look like — backs off exponentially and never exits: the alive twin of the rejected declaration above, and the ending most likely to be mishandled.",
        trigger=Trigger("network-drop"),
        redials=True,
        schedule="exponential",
        terminal=False,
        raises=None,
    ),
    ReconnectRow(
        spec="§6 · close:1001 · a close code the vocabulary does not name (a hub going away) reconnects on the exponential schedule — unknown means reconnect, so adding a code to the protocol can never silently strand a fleet of bots.",
        trigger=Trigger("close", 1001),
        redials=True,
        schedule="exponential",
        terminal=False,
        raises=None,
    ),
    ReconnectRow(
        spec="§6 · upgrade:500 · an upgrade status §6 never mentions (an edge failure) reconnects on the exponential schedule — only 401 is fatal, so a client that lumped the refusals together would stay down through a transient outage.",
        trigger=Trigger("upgrade", 500),
        redials=True,
        schedule="exponential",
        terminal=False,
        raises=None,
    ),
]


async def run_reconnect_row(
    row: ReconnectRow,
    registry: list[tuple[FakeHub | None, HubTransport | None]],
    monkeypatch: pytest.MonkeyPatch,
    recorded_sleep: list[float],
) -> None:
    """The table runner — at implementation this becomes the parametrized async
    test (``@pytest.mark.parametrize("row", RECONNECT_ROWS + UNLISTED_ROWS,
    ids=...)`` over the row's ``spec``). It stands up a fake hub configured to
    produce the row's trigger, then observes the four consequences: further
    dials, the recorded delays at a fixed jitter draw (ReconnectRow's docstring
    states why a live draw cannot tell the two schedules apart), whether the
    context manager exits, and what it raises. All the assertion logic in this
    suite lives here, so adding a close code to the protocol costs one fixture
    entry plus one row, and an ending the fixture does not key costs one row in
    UNLISTED_ROWS."""
    monkeypatch.setattr(pmcp_client, "_rng", lambda: DRAW)

    upgrades: list[int] | None = None
    registrations: list[RegisterOutcome] | None = None
    if row.trigger.kind == "upgrade":
        assert row.trigger.code is not None
        upgrades = [row.trigger.code]
    elif row.trigger.kind == "register-rejected":
        registrations = [RegisterOutcome(error={"code": -32602, "message": "role `all` is the built-in"})]

    hub = await start_fake_hub(upgrades=upgrades, registrations=registrations)
    transport = HubTransport(hub.origin, TOKEN, ROLES)
    registry.append((hub, transport))

    async with anyio.create_task_group() as tg:
        tg.start_soon(_watch, transport.__aenter__(), _Awaited())
        await hub.next_dial(1)
        # The two endings that happen to a LIVE connection need one first.
        if row.trigger.kind in ("close", "network-drop"):
            await hub.next_frame(1)
            if row.trigger.kind == "network-drop":
                await hub.drop_connection()
            else:
                assert row.trigger.code is not None
                await hub.close_connection(row.trigger.code)

        if row.redials:
            redial = await hub.next_dial(2)
            assert redial.seq == 2, "the hub saw no second dial"
            # The schedule is only observable as the CEILING the delay was
            # drawn from, at a fixed draw: max_only stays at the cap,
            # exponential starts at the base.
            attempt = _PAST_THE_CAP if row.schedule == "max_only" else 0
            expected = backoff_delay(attempt, lambda: DRAW)
            assert recorded_sleep[0] == expected, f"{row.schedule} schedule"
        else:
            await _settle()
            assert len(hub.dials) == 1, "the client dialed again after a stopping ending"
            assert recorded_sleep == [], "the client scheduled a retry it must not make"
            assert row.schedule is None

        if row.terminal:
            with anyio.fail_after(5):
                await transport.terminal.wait()
            if row.raises is None:
                await transport.closed()  # returns quietly, and that IS stop_quiet
            else:
                with pytest.raises(row.raises):
                    await transport.closed()
        else:
            await _settle()
            assert not transport.terminal.is_set()

        # A stopping ending leaves nothing connected.
        if not row.redials:
            assert hub.connection_count() == 0

        tg.cancel_scope.cancel()


@pytest.mark.parametrize("row", RECONNECT_ROWS, ids=[row.spec for row in RECONNECT_ROWS])
async def test_reconnect_policy(row: ReconnectRow, registry, monkeypatch, recorded_sleep) -> None:
    await run_reconnect_row(row, registry, monkeypatch, recorded_sleep)


@pytest.mark.parametrize("row", UNLISTED_ROWS, ids=[row.spec for row in UNLISTED_ROWS])
async def test_unlisted_ending_policy(row: ReconnectRow, registry, monkeypatch, recorded_sleep) -> None:
    await run_reconnect_row(row, registry, monkeypatch, recorded_sleep)
