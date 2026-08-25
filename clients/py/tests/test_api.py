"""test_api.py — the Python client library's PURE halves: ``caller`` /
``CallerIdentity.has_role`` (§7's caller-identity affordance), ``sensitive`` and
the ``Secret[T]`` annotation (§7's sensitive-field declaration, §11), and
``backoff_delay`` — §6's reconnect schedule, exported pure precisely so its
doubling, cap, and jitter bounds are a table instead of a property of a live loop
(strategy §11, nudge N2).

Runner: pytest, ``scripts`` + clients lane (§2). Nothing here dials, sleeps, or
reads a clock — ``rng`` is injected, so the schedule is deterministic arithmetic
and every case is synchronous. No fixtures, no ordering, nothing shared.

Scope discipline: whether the reconnect loop actually waits the number
``backoff_delay`` returns belongs to test_transport.py and its recorded-sleep
fixture. This file pins only the number.

Cross-language duplication, deliberate (strategy §3): ``clients/js/test/
api.test.ts`` holds the same schedule table against ``backoffDelay``. Both
transcribe one oracle — §6's schedule sentence plus §11's jitter-from-zero
decision — and differ in units: this table is in SECONDS, the JS one in
MILLISECONDS. Nothing is shared at runtime; that is the point.

Durable vs incidental (§7): durable are the marking semantics (``writeOnly`` at
the named path, both schema directions, the original never mutated, values
untouched on the wire), the wildcard rule in ``has_role``, and the schedule's
shape. The 1 s base and 60 s cap are incidental literals that live in the rows
and nowhere else.

The deps line below is the whole admission argument for this file being in the
pure lane: no fake hub, no fixture file, no clock, no network.
"""

# deps: pytest (parametrize) · pmcp_client (caller, sensitive, Secret,
#   backoff_delay) · pydantic (only where the Secret[T] cases build a model) —
#   no fake hub, no contracts fixture, no clock

from typing import NamedTuple

import pytest

# Outline stage: every case below is authored and none is implemented, so the whole
# module is skipped rather than failing on NotImplementedError. Nothing here may go
# green until the case it names is actually written.
pytestmark = pytest.mark.skip(reason="outline")

# ── caller() · §7 "Caller identity forwarding" ────────────────────────────────


def test_caller_reads_principal_and_roles_off_meta() -> None:
    """§7 · hub/principal and hub/roles are read into principal and roles, with
    roles kept exactly as granted — never expanded into declared names."""
    raise NotImplementedError


def test_has_role_answers_both_directions() -> None:
    """§7 · has_role is true for a granted role and false for an ungranted one —
    both directions in one case, so a uniformly-true implementation fails."""
    raise NotImplementedError


def test_has_role_is_true_for_everything_when_all_is_granted() -> None:
    """§7 · roles containing "all" makes has_role uniformly true, so an owner
    (("all",)) and an all-granted account behave identically in service code."""
    raise NotImplementedError


def test_caller_on_a_request_that_never_passed_the_hub() -> None:
    """§7 · _meta absent, or present without hub/* keys: principal "", empty
    roles, has_role uniformly false — no error for the author to handle."""
    raise NotImplementedError


# ── sensitive() and Secret[T] · §7 "Sensitive-field redaction", §11 ───────────


def test_sensitive_marks_top_level_and_dotted_paths() -> None:
    """§7 · sensitive(schema, ["password", "credentials.token"]) sets
    writeOnly: true at a top-level property and at a dot-path — on an input
    schema and an output schema alike."""
    raise NotImplementedError


def test_sensitive_copies_and_never_mutates_the_original() -> None:
    """§7 · the schema passed in is unchanged at every depth; the returned copy
    carries the marks."""
    raise NotImplementedError


def test_sensitive_rejects_a_path_naming_no_property() -> None:
    """§7 · an unknown path is a ValueError — a silent typo would quietly persist
    a secret; twin: the correctly spelled path in the same schema marks it."""
    raise NotImplementedError


def test_secret_annotation_emits_writeonly_in_both_directions() -> None:
    """§7 · a field annotated Secret[str] emits writeOnly: true at that path in
    the generated JSON Schema — in a tool's input model and its output model
    alike, since the hub reads the marker in both directions."""
    raise NotImplementedError


def test_secret_is_schema_only_and_values_serialize_normally() -> None:
    """§7/§11 · Secret is not SecretStr: a marked value validates, reprs, and
    serializes exactly as the bare type, so real values still cross the wire and
    the HUB does the masking (§15)."""
    raise NotImplementedError


# ── backoff_delay() · §6 "Reconnect" ──────────────────────────────────────────
# The schedule is the table below — one parametrized case per row, no bespoke
# assertions anywhere in this section.


class BackoffRow(NamedTuple):
    """One row of §6's reconnect schedule, as data.

    The columns are the whole design: ``attempt`` plus a FIXED ``rng`` draw make
    the answer exact, so the runner is one equality and never re-implements the
    arithmetic (a runner that recomputed the delay would be a second
    implementation of the schedule — strategy §5's rejected "model of the same
    rules"). Jitter bounds are expressed as pairs of rows at the same attempt
    (draw 0.0 and a draw just under 1.0), never as an inequality in code; the cap
    is a row at a large attempt; the deploy-storm mitigation is the attempt-0 row
    whose draw of 0.0 yields 0.0.

    ``expected_s`` is SECONDS — the Python library's unit; the JS mirror of this
    table is in milliseconds.
    """

    spec: str  # printed in the case id, e.g. "§6 · attempt 0 jitters from zero"
    attempt: int  # consecutive failures, 0-based
    rng: float  # the fixed [0,1) value the seeded stub returns
    expected_s: float  # the exact delay for that draw, in seconds


# Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
# rule 1) — agents never fill them. The oracle is §6's schedule sentence
# ("exponential backoff with jitter, 1 s -> 60 s cap, forever") plus §11's
# jitter-from-zero decision, read from the spec and never from the library.
BACKOFF_ROWS: list[BackoffRow] = []


def run_backoff_row(row: BackoffRow) -> None:
    """The table runner — at implementation this becomes the parametrized test
    (``@pytest.mark.parametrize("row", BACKOFF_ROWS, ids=...)`` over the row's
    ``spec``, so a failure names the sentence to re-read, strategy §8). It calls
    backoff_delay with a stub rng returning the row's draw and compares to
    ``expected_s``: the entire assertion logic for the schedule, so a retune is a
    row edit with zero test churn."""
    # deps: pmcp_client.backoff_delay
    raise NotImplementedError
