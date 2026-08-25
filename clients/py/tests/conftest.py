"""conftest.py — the two pieces of shared machinery the pmcp-client suite needs,
and nothing else: the anyio backend pin and the recorded-sleep seam.

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

**Design check (strategy §6).** The seam must exist to be replaced. If the
transport awaits ``anyio.sleep`` inline with no module-level indirection, this
fixture cannot be written — and that is a finding about the production seam, not
a reason to make the tests sleep. The JS side records the same question in
transport.test.ts.

Note what the deps line below does NOT name: anyio. The backend is named as a
string, so this file has no async machinery of its own — the one import a
conftest for an async suite would be expected to have is precisely the one it
must not need.
"""

# deps: pytest (fixture decorators, MonkeyPatch) · tests/fake_hub.py (the
#   in-process hub fixture, its own harness module) · pmcp_client (the
#   transport's sleep seam, monkeypatched — never called) — deliberately NOT anyio

from typing import Any

# Every delay the reconnect loop asked for, in seconds, oldest first — the whole
# observable surface of the schedule. Compared against backoff_delay's own table
# (tests/test_api.py), never against literals: retuning the schedule must edit
# rows and nothing else (strategy §7 — timing numbers are incidental).
RecordedSleeps = list[float]


def anyio_backend() -> str:
    """Pin the anyio backend to asyncio for the whole suite (a ``pytest.fixture``
    at implementation, session-scoped). Returns the backend name; the parametrized
    trio variant is deliberately not offered — production is asyncio only."""
    # deps: none
    raise NotImplementedError


def recorded_sleep(monkeypatch: Any) -> RecordedSleeps:
    """Replace the transport's sleep seam with one that records and returns
    immediately, and yield the recording list (a ``pytest.fixture`` at
    implementation).

    The contract for every case that takes this fixture: no test wall-clock time
    passes, and the reconnect schedule is asserted from the recorded list. The
    fixture records only — it never decides how long a delay should be, so the
    schedule keeps exactly one definition (``pmcp_client.backoff_delay``)."""
    # deps: pytest (MonkeyPatch) · pmcp_client (the transport's sleep seam)
    raise NotImplementedError
