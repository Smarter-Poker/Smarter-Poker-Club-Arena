# Automatic observation intake

> September 17 delivery status: see the [restored-provider release record](horse-restored-provider-release-2026-09-17.md). Dated verification below remains evidence of its named source, not a fresh release or whole-program completion claim.

The durable capture queue had no automatic producer. The existing isolated
journal worker now discovers actors from retained, atomically committed hand
rosters, persists their original source window, and admits their capture work.
The same worker then captures qualified public actions and journals them.
Discovery itself does not read action arrays or private cards and does not
modify a hand writer, financial outbox, wallet, profile or strategy policy.

`horseAdaptiveJournal/worker.ts` calls `discoverObservationRequests` through the
serial loop. Its service-only database step owns one pending epoch, freezes
each source segment before admission, and resumes that saved roster after a
restart or lost reply. Membership is deduplicated per actor and parent window.
The unchanged canonical admission RPC owns capacity and deterministic request
identity; a member-write failure rolls back all admissions in that step.

| Boundary         | Limit and behavior                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent window    | Six hours, five-hour cadence, one-minute lag, one-hour overlap                                                                                    |
| Source statement | 512 hands with a 513th-row overflow check; atomic UUID/table/number match required                                                                |
| Rosters          | 1 to 10 valid unique UUIDs per hand, at most 1 MiB per roster and 8 MiB per source step                                                           |
| Source evidence  | Ordered atomic-hand/actor digests, same-query snapshot and read timestamp; no private roster fields                                               |
| Admission        | At most 32 actors per step, one original parent-window request each; existing 256 unfinished-request cap                                          |
| Epoch            | At most 8,192 actors, 2,048 segments and 2 MiB logical segment evidence                                                                           |
| Retained roots   | At most 512 epochs and 128 unresolved gaps; new work refuses when these budgets fill                                                              |
| Expiry           | A parent older than one day becomes a retained gap with prior membership intact                                                                   |
| Retention        | Only discovered epochs older than 32 days; at most 512 members, 128 segments and one empty root per call                                          |
| Worker           | Dedicated serial step, five-second client deadline; progress scheduled at ten-second intervals with at least one intervening journal/capture turn |

The 2 MiB logical evidence limit counts snapshot bytes, frozen novel UUID bytes
and a conservative fixed allowance per segment. It is not a bound on physical
PostgreSQL storage, indexes, dead tuples or backups. Epoch/member limits and
bounded retention constrain those records separately. Retention never clears
pending epochs or unresolved gaps, and never cascades into capture receipts.
An idle discovery receipt still reports the retained gap count.

Discovery and its backoff have their own deadline; they do not add source I/O
to a capture or maintenance cycle. Maintenance rotates journal, capture and
discovery pruning. The existing eight-journal-turn acquisition fairness bound,
worker memory limit, watchdog and shutdown/restart ownership remain in force.
Validated discovery receipts cross worker IPC; actor arrays never do.

## Verification and limits

The native PostgreSQL fixture exercises 1,000 distinct actors through compiled
discovery, capture and journal adapters, fills the 256-request queue, and drains
it through canonical calls. Those synthetic rows deliberately have empty action
arrays: the throughput sample measures intake mechanics, not poker quality.
A separate real worker fixture discovers two actors from three completed
controller hands, terminates after freezing the roster, restarts, captures 24
public observations and completes both journal batches. Every fixture terminates
its workers and removes its private PostgreSQL cluster.

Failure checks cover rollback, lost committed replies, concurrent owners,
duplicate membership across slices, source removal, malformed or unmatched
rosters, source overflow, expiry, retention locks and resource ceilings.
Browser roles cannot invoke the two entrypoints. All application roles,
including service role, lack direct access to the three private RLS tables and
the internal receipt formatter.

A read-only production plan on September 14 used the existing history timestamp
and atomic hand-ID indexes, read exactly 513 source candidates and finished in
984.909 ms. The earlier 30-second sample had 77 atomic hands and 127 distinct
actors. These bounded samples do not certify sustainable production throughput.

Every scoped receipt explicitly says `sourceCoverage: not_established`.
Periodic overlap cannot prove the absence of late/backdated commits or retention
loss. A discovered epoch does not mean all its capture requests or journal jobs
finished, and none of these statuses creates a complete observation-time model
window. Source completeness, measured natural capacity, scoped model consumption,
counterfactual utility, holdout/shadow controls, qualified activation/rollback and
Phase 15 remain separate unfinished program requirements.

Migration reservation: `20260914053355`. Application, protected merge and served
worker provenance are recorded separately in the release evidence; local fixture
success does not establish those facts.
