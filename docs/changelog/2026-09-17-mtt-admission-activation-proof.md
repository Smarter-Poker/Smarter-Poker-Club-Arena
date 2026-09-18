# MTT admission activation preserves accepted tournament contracts

The installed preparation keeps legacy capacity active until the compatible
application is published and the old writers are retired. The existing private
admission guard has an installed one-way activation rule, recorded by provider
migration `20260917234256` at 23:42:56 UTC on September 17. Readback at
23:43:06 UTC confirmed the exact qualified guard, unchanged trigger attachments
and `legacy-capacity-v1`. The guard source remains byte-identical (`45bfb0e6`).
It checks the prepared function bodies and permissions, trigger attachments,
constraints, columns, indexes, financial registry and active format records.
Unknown or changed prerequisites refuse the transition.

The separate row-only activation transaction (`bda46910`) remains **not installed**.
It acquires the maintenance boundary before
the private admission row. It changes only that row, with no schema change,
tournament rewrite or financial effect after admission exclusion. Existing
funded legacy contracts retain their recorded terms. Reversal, API-role writes,
missing proof and disabled guards are refused. Remote engine publication and
retirement remain prerequisites established by the existing release evidence;
the database does not pretend to prove remote process state.

The existing accounting job now runs actual activation in its owned PostgreSQL
17 fixture, alongside preparation. It retains both receipts and transcripts.
Input-only changes select that job and the routing regressions.

Validation: 14 stock isolation races passed, covering six satellite/restart
cases and eight creation/paid-entry commit/rollback orderings around the actual
activation. Sixteen refusal cases preserved full data and catalog snapshots.
A real legacy HU launch funded its 20-chip treasury overlay, then replayed its
exact receipt and money history after activation. Cleanup stopped and removed
the owned PostgreSQL cluster. The original direct CI regression failed 10 cases before
wiring and passed all 293 afterward; the strict activation transcript consumer
passed five tests. Synthetic historical opening inputs are explicit. These
checks do not claim production activation, remote writer retirement or complete
MTT live acceptance.

Final composed qualification retained 98 exact source bindings, all 14 actual
races, all 16 refusal cases, the funded legacy receipt replay and owned-cluster
cleanup. The current joined routing checks passed 373 assertions; the strict
transcript consumer passed five and the shared Cash manifest passed six. The
Git rename fixture uses real filesystem renames staged by its existing commit,
preserving every original path assertion and its existing test deadline.
