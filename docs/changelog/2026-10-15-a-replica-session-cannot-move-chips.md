# A replica session cannot move chips (2026-10-15)

Supply snapshot 942 (2026-10-06 16:05 UTC) recorded -14,081.45 unexplained and the nightly horse audit has reported it as critical ever since.

Cause, re-derived to the cent: every store in the supply meter matched its chip_ledger legs over 15:05-16:05 except the cash felt, which was exactly 14,081.45 short. The short is 43 cash seats whose left_at was stamped at 15:33:04-15:33:09 by a psql session running with `session_replication_role = replica` (the patterned-identity force drain). 42 of the seats belonged to retired house-horse identities; the owner of the 43rd is not in the retirement cohort and is reported to Dan. Every money guard on these tables is an ordinary trigger, which replica mode switches off, so no cashout or burn leg was written and nothing refused it. 12 seats (2,830.85) were later restored by labelled issuance; 11,250.60 were never re-issued.

Fix: migration `20261015105156_a_replica_session_cannot_move_chips` adds a statement-level `ENABLE ALWAYS` guard on all 18 chip-store tables that refuses INSERT, UPDATE, DELETE and TRUNCATE under replica mode on a protected cluster (production system identifier, or any hosted cluster named `main`). CI initdb clusters, which seed fixtures in replica mode, are unaffected. The migration proves the refusal inside its own transaction and acknowledges snapshot 942 in `ca_supply_breach_ack` with the evidence. No money moves.

Regression: `tests/a-replica-session-cannot-move-chips.law.test.ts`.

Open money decision (Dan): whether to re-issue the 11,250.60 and to whom.
