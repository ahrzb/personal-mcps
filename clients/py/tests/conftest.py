"""conftest.py — the three pieces of shared machinery the pmcp-client suite
needs, and nothing else: the anyio backend pin, the recorded-sleep seam, and the
teardown registry both async suites hand their hubs and transports to.

Runner: pytest, not vitest — this package is the ``scripts`` + clients lane of
the strategy's project table (§2), parallel with the JS client and sharing
nothing with it but the contract fixtures (§4).

**anyio mode.** The suite runs with ``anyio_mode = "auto"`` (set once in
``pyproject.toml``'s pytest section, not here), so every ``async def test_*`` is
collected as an anyio test without a per-test marker — the transport is an async
context manager, so nearly every case here is async and the markers would be
pure noise. The backend is pinned to **asyncio** by the fixture below: the
``mcp`` SDK, ``websockets``, and the library's own loop all run on asyncio in
production, and testing on trio would test a configuration no bot will ever run.

**Why a recorded sleep and not a fake clock.** anyio offers no injectable clock
on the asyncio backend, and the JS trick — vitest fake timers — has no
equivalent here. So the reconnect loop's *schedule* is made observable instead
of made fast: the sleep seam is replaced by one that records the requested delay
and returns immediately. Every "retries at max backoff" and "attempt 0 spreads
the deploy storm" assertion then reads a list of floats, and no test ever waits.
This is deliberately ~10 lines: a real fake clock would be a second
implementation of anyio's scheduler, which strategy §5 rejects on sight.

**Design check (strategy §6).** The seam must exist to be replaced. The
production seam is ``pmcp_client._sleep`` — a bare module-level function, not a
constructor argument, precisely so this fixture can replace it with
``monkeypatch.setattr`` without needing a transport instance in hand. If the
transport awaited ``anyio.sleep`` inline with no such module-level indirection,
this fixture could not be written — and that would be a finding about the
production seam, not a reason to make the tests sleep. The JS side records the
same question in transport.test.ts; ``pmcp_client._rng`` is the sister seam for
the jitter draw, monkeypatched directly in test_transport.py (its row runner,
not this file, is what needs a *fixed* draw — see ReconnectRow's docstring).
"""

# deps: pytest (fixture decorators, MonkeyPatch) · pmcp_client (the
#   transport's sleep seam, monkeypatched — never called directly; HubTransport
#   and fake_hub.FakeHub as the registry's teardown types) — deliberately NOT
#   anyio

import pytest

import pmcp_client
from fake_hub import FakeHub
from pmcp_client import HubTransport

# Every delay the reconnect loop asked for, in seconds, oldest first — the whole
# observable surface of the schedule. Compared against backoff_delay's own table
# (tests/test_api.py), never against literals: retuning the schedule must edit
# rows and nothing else (strategy §7 — timing numbers are incidental).
RecordedSleeps = list[float]


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    """Pin the anyio backend to asyncio for the whole suite. The parametrized
    trio variant is deliberately not offered — production is asyncio only."""
    return "asyncio"


@pytest.fixture
def recorded_sleep(monkeypatch: pytest.MonkeyPatch) -> RecordedSleeps:
    """Replace the transport's sleep seam with one that records and returns
    immediately, and yield the recording list.

    The contract for every case that takes this fixture: no test wall-clock time
    passes, and the reconnect schedule is asserted from the recorded list. The
    fixture records only — it never decides how long a delay should be, so the
    schedule keeps exactly one definition (``pmcp_client.backoff_delay``)."""
    delays: RecordedSleeps = []

    async def fake_sleep(seconds: float) -> None:
        delays.append(seconds)

    monkeypatch.setattr(pmcp_client, "_sleep", fake_sleep)
    yield delays


@pytest.fixture
async def registry():
    """Every hub and transport a case opened, torn down whatever the case did —
    the Python counterpart of the JS suite's ``opened`` + ``afterEach``, and here
    rather than in one suite because both async suites need it: a case that
    hand-rolled its own try/finally and forgot the finally would leak a listener
    and a live reconnect loop into whichever case runs next."""
    opened: list[tuple[FakeHub | None, HubTransport | None]] = []
    yield opened
    for hub, transport in reversed(opened):
        if transport is not None:
            try:
                await transport.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001 - teardown must not mask the test's own outcome
                pass
        if hub is not None:
            await hub.aclose()
