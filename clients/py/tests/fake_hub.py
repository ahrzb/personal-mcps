"""fake_hub.py — a real hub, in-test: a genuine ``websockets`` server on an
ephemeral port that ``HubTransport`` dials over a genuine WebSocket upgrade,
answers ``hub/register`` with a genuine JSON-RPC reply, and closes with genuine
close codes. It is the other end of §6's wire seen from the client side, not a
stand-in for it. The JS suite's ``clients/js/test/fake-hub.ts`` is the same
harness in the other language — deliberately duplicated, never shared (strategy
§3), so neither client's table can quietly start answering to the other's.

WHAT THIS PINS: the disconnect policy's inputs, as things that actually
happened. §6 gives the client four kinds of ending and the whole
fatal-vs-retry decision turns on telling them apart — a refused upgrade (an
HTTP status, before any frame exists), a close code (after establishment), a
rejected registration (a JSON-RPC error reply), and an ordinary drop. A stub
that hands the transport a synthesized "401" erases exactly the distinction
under test. ``dials``, ``frames`` and ``pings`` record at ARRIVAL, before any
scripted decision runs, so "it re-registered after reconnecting", "it never
redialed" and "it kept the connection alive" are things this harness observed
rather than things the transport reported about itself.

WHAT IT MUST NOT FAKE (strategy §9): the WebSocket upgrade (401 and 403 are
real HTTP statuses on a real handshake), the JSON-RPC framing (one message per
text frame, ids echoed as received), or the close-code vocabulary (a real close
with a code, never a synthesized event). It fakes only the hub's DECISIONS:
which status to answer, whether to accept a declaration, when to send
``hub/replaced``, when to close and with what. It equally must not fake the
``mcp`` SDK — it speaks the wire directly and proves nothing about SDK
conformance, which is ``scripts/e2e.ts``'s job (§10). Nor does it implement any
hub BEHAVIOR: no catalog, no grants, no approval gate. A fake hub that started
answering ``tools/list`` would be a second implementation of the server, and the
server's own suites already own every one of those sentences.

Runner: pytest, ``scripts`` + clients lane (§2), ``anyio_mode = "auto"`` on the
asyncio backend (conftest). Every case owns its own hub on its own ephemeral
port — the port is assigned by the OS, never chosen, so parallel cases and the
JS suite beside them never collide. Every hub is closed in a teardown; a leaked
listener outlives the case that made it.

Time: nothing here sleeps, and nothing here is driven by a clock. Python has no
fake-timer equivalent to the JS side's, so the schedule is observed through
conftest's ``recorded_sleep`` seam instead — this harness's only obligation is
to record dials as they arrive so "it kept retrying" has a witness. Every wait a
fixture performs is on an observation (:meth:`FakeHub.next_dial`,
:meth:`FakeHub.next_frame`), never on a duration.

At implementation this module imports ``websockets`` (the real
``websockets.asyncio.server`` — real upgrade handling, real close codes) and
``anyio`` (the event waits behind next_dial/next_frame) and ``json`` (one
message per text frame) — no ``mcp`` SDK, no server module, and nothing from
``contracts/`` (the fixture is the TEST's oracle, not this harness's input).
``pmcp_client`` is deliberately NOT imported: this harness is the other end of
the wire and must stay ignorant of the library it is testing, so the
declaration shape below is restated rather than borrowed.
"""

# deps: websockets (real serve/upgrade/close) · anyio (observation waits) · json
#   (framing) — no pmcp_client, no mcp SDK, no server module, no contracts fixture

import json
import time
from typing import Any, NamedTuple

import anyio
import websockets
from websockets.frames import Frame, Opcode
from websockets.asyncio.server import Server as _WsServer
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.server import serve as _ws_serve

# What the hub answers to the NEXT upgrade attempt (§6's three outcomes). Scripted
# rather than derived: this harness holds no credentials to derive 401-vs-403
# from, and re-deciding it here would make the client's table answer to a second
# implementation of the server's rule instead of to the contract fixture (§4).
# 101 accepts — the allow-twin of every refusal row; 401 is fatal-credential and
# 403 archived-keep-retrying; any other status is expressible so a row can pin
# what the client does with a status §6 never mentions.
UpgradeStatus = int

# The declaration a fixture expects to find in a recorded hub/register frame —
# role name -> anchored patterns. Restated rather than imported from
# pmcp_client (see the module docstring), and never VALIDATED here: pattern and
# name validation is the hub's job (§6), pinned once in
# server/test/worker/registry.test.ts. Duplicating it would give the client's
# table a second oracle.
Roles = dict[str, list[str]]

_ACCEPT_STATUS = 101


class RegisterOutcome(NamedTuple):
    """What the hub does with ``hub/register``. ``error`` set means a JSON-RPC
    ERROR REPLY — the rejected-declaration ending, which §6 makes terminal
    (RegistrationError) precisely because identical input cannot start
    succeeding. It is deliberately a distinct shape from a close code: a client
    that conflated the two would retry a declaration forever.

    ``frame`` answers with that exact frame instead, with the OBSERVED request id
    filled in — the seam test_contracts.py needs to REPLAY
    ``contracts/tunnel-frames.json``'s own ack rather than assert a property of
    it while the harness synthesizes a paraphrase (the JS harness's ``replay``
    arm). The id is the one thing a fixture cannot pin (contracts/README:
    "nothing that varies per run"), and a reply that correlates to nothing would
    leave registration unanswered until the 10 s deadline."""

    error: dict[str, Any] | None = None
    frame: dict[str, Any] | None = None


class Dial(NamedTuple):
    """One observed upgrade attempt, recorded when the REQUEST arrives — before
    the scripted status is applied, so a refused dial counts exactly like an
    accepted one. That is the whole point of the record: "the client kept
    retrying at max backoff" is a claim about attempts, and a hub that only
    counted successes could never witness it.

    ``path`` and ``authorization`` are captured verbatim because §6 pins both on
    the client side: the address is DERIVED (``wss://<host>/connect``) rather
    than passed in, and the app token rides ``Authorization: Bearer`` and
    nowhere else. ``at`` is a real clock reading, so a table asserts the ORDER of
    arrivals and never a seconds literal (§7) — the delays themselves are read
    from conftest's recorded_sleep list, which is the schedule's only oracle."""

    seq: int
    path: str
    authorization: str | None
    at: float


class ReceivedFrame(NamedTuple):
    """One observed inbound frame, captured verbatim before interpretation.
    Registration re-sends are why this is a list rather than a flag: §6 requires
    ``hub/register`` on every (re)connect, so "it registered" is a count per
    connection, not a boolean per transport. ``connection`` is the ordinal of the
    socket the frame arrived on, so a fixture can say "the second connection
    re-registered" without inspecting the transport at all."""

    seq: int
    connection: int
    message: dict[str, Any]


#: How long an observation wait may go unanswered before the case fails instead
#: of hanging (mirrors the JS harness's OBSERVATION_DEADLINE_MS).
_OBSERVATION_DEADLINE_S = 5.0


def _next(script: list[Any], index: int) -> Any:
    """The scripted answer for the nth event; the last entry repeats forever."""
    return script[min(index, len(script) - 1)]


def _ping_recording_connection(hub: "FakeHub") -> type[ServerConnection]:
    """The connection class this hub's listener builds: a plain
    ``ServerConnection`` that also records incoming PING frames.

    ``websockets`` answers pings inside the protocol and surfaces only data
    frames to ``recv()``, so a keepalive is otherwise invisible to a server
    handler — and reading it off the CLIENT's ``latency`` would prove the
    vendored library's ping loop ran, not that §6's cadence is the transport's
    behavior. ``serve(create_connection=…)`` is the documented seam for exactly
    this, and it keeps the observation on the harness's side of the wire like
    every other one here."""

    class PingRecordingConnection(ServerConnection):
        def process_event(self, event: Any) -> None:
            if isinstance(event, Frame) and event.opcode is Opcode.PING:
                hub._record_ping()
            super().process_event(event)

    return PingRecordingConnection


class FakeHub:
    """A live fake hub — one LISTENER, many connections. Unlike the fake app
    on the server side, this one deliberately survives the sockets it accepts:
    the entire subject of test_transport.py is what the client does after a
    connection ends, so the hub must outlive the ending to witness the redial (or
    its absence)."""

    #: The https origin a fixture hands the transport, ``http://127.0.0.1:<port>``.
    #: The wss address is the client's to derive (§6); asserting that derivation
    #: is what ``Dial.path`` is for.
    origin: str

    #: Every upgrade attempt this listener saw, in arrival order — the redial
    #: oracle. A refusal row asserts this stops growing; a retry row asserts it
    #: keeps growing, and the recorded sleeps say on which schedule.
    dials: list[Dial]

    #: Every frame received across every connection, in arrival order.
    #: ``hub/register`` re-sends appear here once per connection, which is how
    #: §6's "re-sent on every (re)connect" is observed from outside the transport.
    frames: list[ReceivedFrame]

    #: Every protocol PING this listener observed, by arrival time — §6's liveness
    #: sentence, witnessed on the wire like every other observation here rather
    #: than read back off the transport's own keepalive bookkeeping. The JS
    #: harness records the same thing on the same side (``FakeHub.pings``).
    pings: list[float]

    def __init__(
        self,
        upgrades: list[UpgradeStatus] | None = None,
        registrations: list[RegisterOutcome] | None = None,
    ) -> None:
        self.origin = ""
        self.dials = []
        self.frames = []
        self.pings = []
        self._server: _WsServer | None = None
        self._upgrades: list[UpgradeStatus] = list(upgrades) if upgrades else [_ACCEPT_STATUS]
        self._registrations: list[RegisterOutcome] = list(registrations) if registrations else [RegisterOutcome()]
        self._open: list[ServerConnection] = []
        self._connections = 0
        self._watchers: list[anyio.Event] = []

    def connection_count(self) -> int:
        """How many sockets are open right now — the invariant behind "a refused
        upgrade leaves nothing connected"."""
        return len(self._open)

    async def next_dial(self, n: int) -> Dial:
        """Wait until the number of recorded dials reaches ``n``, and return it.

        The ONLY way a fixture waits in this harness. Waiting on an observation
        rather than on a duration is what keeps "the client redialed" from
        decaying into "the client redialed within 50 ms" — and it is what makes
        the recorded-sleep seam sufficient: no test needs wall-clock time to pass
        for a redial to be observed. Raises on a bounded deadline, so a transport
        that never redials fails the case instead of hanging it."""
        await self._until(lambda: len(self.dials) >= n, f"dial {n}")
        return self.dials[n - 1]

    async def next_frame(self, n: int) -> ReceivedFrame:
        """The frame counterpart of :meth:`next_dial`, with the same rationale
        and the same bounded failure."""
        await self._until(lambda: len(self.frames) >= n, f"frame {n}")
        return self.frames[n - 1]

    async def next_ping(self, n: int) -> float:
        """The ping counterpart — §6's liveness cadence, waited on as an
        observation like the rest."""
        await self._until(lambda: len(self.pings) >= n, f"ping {n}")
        return self.pings[n - 1]

    def _record_ping(self) -> None:
        self.pings.append(time.monotonic())
        self._notify()

    def set_upgrades(self, statuses: list[UpgradeStatus]) -> None:
        """Rewrite the remaining upgrade script mid-test — the seam the healing
        rows need. The fixture refuses 403 until the client is provably retrying,
        then flips to 101 and asserts the very next dial connects: §6's unarchive
        path, expressed as a change in the world rather than as a second hub.
        The list is consumed in order and its last entry repeats forever."""
        # Padded up to the dials already resolved, so the NEXT dial (whose
        # ordinal is len(self.dials)) is the first to read the new script.
        self._upgrades = [statuses[0]] * len(self.dials) + list(statuses)

    async def send(self, frame: dict[str, Any]) -> None:
        """Send one raw frame on the current connection, bypassing every
        convenience above — the escape hatch for frames that are ill-formed BY
        CONSTRUCTION: an unknown ``hub/`` method, a reply to no request, two
        messages in one text frame. A harness that could only send well-formed
        frames could not test that ordinary MCP traffic reaches the read stream
        while unknown control frames do not."""
        for connection in list(self._open):
            await connection.send(json.dumps(frame))

    async def replace(self) -> None:
        """End the current connection §6's replacement way: the ``hub/replaced``
        notification, THEN close 4000, in that order — a client is entitled to
        act on the notification. One method rather than two so a fixture cannot
        accidentally test the close without the notification that gives it
        meaning. A no-op when nothing is connected."""
        for connection in list(self._open):
            await connection.send(json.dumps({"jsonrpc": "2.0", "method": "hub/replaced"}))
            await connection.close(4000, "replaced")

    async def close_connection(self, code: int, reason: str = "") -> None:
        """Close the current connection with a real close code — the trigger
        every 4001/4002/4003/4004 row fires. The listener stays up, because what
        the row pins is whether the client comes back. A no-op when nothing is
        connected."""
        for connection in list(self._open):
            await connection.close(code, reason)

    async def drop_connection(self) -> None:
        """Sever the current connection with no close frame at all — what a hub
        deploy and a network failure actually look like, and the ending most
        likely to be mishandled. Distinct from :meth:`close_connection` because
        no code carries meaning back to the client, so the policy must fall
        through to plain reconnect-with-backoff."""
        for connection in list(self._open):
            connection.transport.abort()

    async def aclose(self) -> None:
        """Stop the listener and every socket on it. Idempotent; fixtures call it
        in teardown unconditionally, because a leaked listener holds a port and
        an open task past the end of the case that made it — and in a parallel
        lane that is a failure in some other test."""
        for connection in list(self._open):
            connection.transport.abort()
        self._open.clear()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    # ── the websockets.serve() hooks (bound methods, passed in directly) ──────

    async def _process_request(self, connection: ServerConnection, request: Any) -> Any:
        """Recorded at ARRIVAL, before the scripted status is applied — see the
        module docstring on why that ordering matters."""
        index = len(self.dials)
        self.dials.append(
            Dial(
                seq=index + 1,
                path=request.path,
                authorization=request.headers.get("Authorization"),
                at=time.monotonic(),
            )
        )
        self._notify()
        status = _next(self._upgrades, index)
        if status == _ACCEPT_STATUS:
            return None
        return connection.respond(status, "refused")

    async def _handle(self, connection: ServerConnection) -> None:
        """One accepted connection: record its frames, answer its registration,
        nothing else."""
        connection_id = self._connections + 1
        self._connections = connection_id
        self._open.append(connection)
        try:
            while True:
                try:
                    raw = await connection.recv()
                except websockets.ConnectionClosed:
                    return
                try:
                    parsed = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if not isinstance(parsed, dict):
                    continue
                self.frames.append(ReceivedFrame(seq=len(self.frames) + 1, connection=connection_id, message=parsed))
                self._notify()
                if parsed.get("method") != "hub/register":
                    continue
                outcome = _next(self._registrations, connection_id - 1)
                # The id is echoed AS RECEIVED: a reply that correlates to
                # nothing would leave registration unanswered until the deadline.
                if outcome.frame is not None:
                    reply: dict[str, Any] = {**outcome.frame, "id": parsed.get("id")}
                elif outcome.error is None:
                    reply = {"jsonrpc": "2.0", "id": parsed.get("id"), "result": {"ok": True}}
                else:
                    reply = {"jsonrpc": "2.0", "id": parsed.get("id"), "error": outcome.error}
                await connection.send(json.dumps(reply))
        except websockets.ConnectionClosed:
            pass
        finally:
            if connection in self._open:
                self._open.remove(connection)

    # ── observation plumbing ──────────────────────────────────────────────────

    async def _until(self, done: Any, what: str) -> None:
        with anyio.move_on_after(_OBSERVATION_DEADLINE_S) as scope:
            while not done():
                event = anyio.Event()
                self._watchers.append(event)
                await event.wait()
        if scope.cancelled_caught and not done():
            raise TimeoutError(f"the fake hub never observed {what} (within {_OBSERVATION_DEADLINE_S}s)")

    def _notify(self) -> None:
        watchers, self._watchers = self._watchers, []
        for event in watchers:
            event.set()


async def start_fake_hub(
    upgrades: list[UpgradeStatus] | None = None,
    registrations: list[RegisterOutcome] | None = None,
) -> FakeHub:
    """Start a hub on an OS-assigned port and return once it is accepting
    connections — so a fixture's first line establishes "the hub is listening" as
    a fact rather than a hope, and the transport's first dial cannot lose a race
    with the listener's own startup.

    ``upgrades`` is the status answered per attempt, consumed in order with the
    last entry repeating forever; a list rather than a single value because the
    interesting rows are TRANSITIONS — refused 403 while archived, then 101 once
    unarchived, which is §6's "unarchiving heals without touching the bot"
    observed rather than assumed. ``registrations`` scripts ``hub/register`` the
    same way. Both omitted means accept everything, which is the shape every
    handshake case starts from."""
    hub = FakeHub(upgrades, registrations)
    server = await _ws_serve(
        hub._handle,
        "127.0.0.1",
        0,
        process_request=hub._process_request,
        create_connection=_ping_recording_connection(hub),
    )
    hub._server = server
    sockets = server.sockets
    assert sockets is not None
    port = sockets[0].getsockname()[1]
    hub.origin = f"http://127.0.0.1:{port}"
    return hub
