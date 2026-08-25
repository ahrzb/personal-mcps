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

Durable vs incidental (§7): durable are the code->behavior mapping, its totality,
and that reconnects are invisible to the SDK session. Incidental — never asserted
as a literal — the delay values (they live in test_api.py's schedule rows) and
every message string.

The deps line below names ``conftest.recorded_sleep`` explicitly: a case in this
file that took no sleep recorder and still passed would have waited for real
time somewhere, which is the failure the seam exists to prevent.
"""

# deps: tests/fake_hub.py (the in-process `websockets` hub: chooses upgrade
#   status, accepts/rejects hub/register, closes with a code) ·
#   conftest.recorded_sleep + conftest.anyio_backend · pytest (parametrize) ·
#   anyio · pmcp_client (HubTransport, serve, CredentialsError,
#   RegistrationError) · contracts/close-codes.json (read-only — see
#   test_contracts.py)

from typing import NamedTuple

import pytest

from pmcp_client import CredentialsError, RegistrationError

# Outline stage: every case below is authored and none is implemented, so the whole
# module is skipped rather than failing on NotImplementedError. Nothing here may go
# green until the case it names is actually written.
pytestmark = pytest.mark.skip(reason="outline")

# ── handshake · §6 "Transport", "Framing", "Handshake" ────────────────────────


async def test_constructor_rejects_anything_but_a_bare_origin() -> None:
    """§6 · a URL carrying a path, or a wss:// URL, is a ValueError in __init__
    before any I/O; twin: a bare https origin constructs and dials
    wss://<host>/connect, derived internally and never passed in."""
    raise NotImplementedError


async def test_dial_carries_the_service_token_and_no_slug() -> None:
    """§6 · the handshake sends the service token as Authorization: Bearer and
    carries no service or slug anywhere — identity rides the token alone, so a
    token for one slug can never touch another service."""
    raise NotImplementedError


async def test_aenter_returns_streams_only_after_registration() -> None:
    """§6 · __aenter__ returns the (read, write) stream pair only once
    hub/register is accepted, and the declaration sent is the roles handed to the
    constructor — {} when omitted."""
    raise NotImplementedError


async def test_hub_control_frames_never_reach_the_read_stream() -> None:
    """§6 · hub/* frames are consumed internally; ordinary MCP traffic arrives on
    the read stream, one JSON-RPC message per text frame."""
    raise NotImplementedError


async def test_writes_while_the_socket_is_down_are_dropped() -> None:
    """§6 · a write with no live socket is dropped, never queued and never an
    error — the hub re-lists after every registration, so a dropped
    notifications/tools/list_changed heals itself."""
    raise NotImplementedError


# ── reconnection is invisible to the SDK session · §6, §11 ────────────────────


async def test_reconnect_reregisters_and_keeps_the_streams_open() -> None:
    """§6 · a mid-life drop reconnects and re-sends hub/register while the
    yielded streams stay open — one transport is one service lifetime, not one
    socket."""
    raise NotImplementedError


async def test_reconnect_delays_follow_the_shared_schedule() -> None:
    """§6 · the delays recorded by the recorded_sleep fixture are exactly
    backoff_delay's answers for successive attempts — the loop owns no schedule
    of its own, and no wall-clock time passes."""
    raise NotImplementedError


async def test_serve_mirrors_the_transports_terminal_outcomes() -> None:
    """§11 · serve() returns quietly after a replacement and raises the same
    error class otherwise, so the policy is decided in HubTransport and nowhere
    else."""
    raise NotImplementedError


# ── the policy itself · §6 upgrade matrix + close codes ───────────────────────
# The table below — one parametrized case per row, each refusal ending (401,
# 4001, a rejected registration) authored beside an ending that keeps the
# connection alive, so a transport that gives up on everything cannot pass
# (strategy §9 rule 2).


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
    which is what makes "reconnect" observably different from "stop"), and with
    what (``raises``, naming the real class so a rename breaks the table instead
    of silently matching nothing; None means it exits quietly).

    The fixture's three behavior words land on these columns one-to-one:
    ``stop_quiet`` -> terminal with no ``raises``, ``stop_fatal`` -> terminal
    with one, ``reconnect`` -> not terminal, and only then does ``schedule``
    mean anything. The mapping is total in both directions, which is what lets
    test_contracts.py check a row against a fixture entry without either side
    owning a fourth word.
    """

    spec: str  # printed in the case id, e.g. "§6 · close 4002 · archived reconnects on the max_only schedule"
    trigger: str  # the fixture's canonical key: "upgrade:401", "close:4001", "register-rejected", "network-drop"
    redials: bool  # `redials is True` IS the fixture's `reconnect` behavior
    schedule: str | None  # the fixture's schedule attribute: "exponential" | "max_only"; None when it does not reconnect
    terminal: bool
    raises: type[CredentialsError] | type[RegistrationError] | None


# Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
# rule 1) — agents never fill them. The oracle is §6's upgrade matrix and
# close-code list, and the contracts fixture derived from them; rows are written
# from the spec, never from the library.
RECONNECT_ROWS: list[ReconnectRow] = []


def run_reconnect_row(row: ReconnectRow) -> None:
    """The table runner — at implementation this becomes the parametrized async
    test (``@pytest.mark.parametrize("row", RECONNECT_ROWS, ids=...)`` over the
    row's ``spec``). It stands up a fake hub configured to produce the row's
    trigger, then observes the four consequences: further dials, the recorded
    delays, whether the context manager exits, and what it raises. All the
    assertion logic in this suite lives here, so adding a close code to the
    protocol costs one fixture entry plus one row."""
    # deps: tests/fake_hub.py · conftest.recorded_sleep · pmcp_client (HubTransport)
    raise NotImplementedError
