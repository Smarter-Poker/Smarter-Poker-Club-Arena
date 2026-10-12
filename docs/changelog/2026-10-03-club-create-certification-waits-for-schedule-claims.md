# Club Create Certification Waits For A Fresh Schedule Claim

The production Club Create certificate can race the recurring-tournament
scheduler immediately after a new club receives its opening package. The
scheduler first records a spawn claim, then creates the tournament, then links
the claim. The guarded certification-retirement function correctly refuses to
remove a claim that is still unlinked and less than five minutes old.

Run `37101917154` reached that exact guard after its first retirement attempt
waited on a lock. The cleanup script treated the protected transition as a
final refusal, so the isolated certification club and reserved test account
remained for guarded stale-fixture recovery.

The certificate now recognizes only the exact PostgreSQL `55000` refusal
`WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED`. It then performs two
read-only checks: the club must own exactly one active welcome-package
tournament schedule, and that schedule must have a fresh unmaterialized spawn
claim. Only that proved state receives bounded backoff before the same
idempotent guarded retirement door is attempted again. Every other lineage
refusal remains final.

PostgreSQL client errors and PostgREST errors now share one diagnostic-message
reader, so a direct database refusal retains the same reserved-fixture graph
evidence as the HTTP path.

Regression coverage proves the retry requires the exact SQLSTATE, exact guard
message, and a fresh null tournament claim; proves the evidence reads are GET
only; proves unrelated refusals and stale or absent claims do not retry; and
proves direct PostgreSQL errors still emit the fixture-graph diagnostic.

This correction changes certification tooling and its tests only. It does not
weaken the database retirement guard and does not change any real club, player,
wallet, chip, horse, game, or setting.
