# Chip Journal Atomicity, 2026-09-08

Production evidence: ca_ledger_write_failures id 871 records fn_ca_autoledger
bbj_pools.main_balance losing its journal on SQLSTATE 55P03 for 0.25 chips.
Id 867 records atomic_distribute_rake losing its journal for 0.68 chips.
The shared ledger functions catch posting failures and allow the enclosing
balance change to commit. This is a transaction-boundary defect.

Before: eight functions swallow failed ledger INSERTs. fn_ca_autoledger and
fn_club_members_ledger_writer also replace rejected accounting declarations
with suspense/adjustment entries. fn_ca_post_leg returns false on failures.
After: those exact posting exception handlers rethrow the original error.
The enclosing operation rolls back; existing operation-level retries retain
the original SQLSTATE and idempotency identity. No repair worker is added.

Scope: shared club, union, player, agent, promo, insurance, BBJ and spin
balance journals; direct rake and treasury-funded seat/reload journals.
Not global certification: satellite transfers, all top-level caller retry
contracts, transaction balancing, suspense defaults, historical incidents,
and every remaining writer still require separate evidence.

Sources: PostgreSQL 17 PL/pgSQL error trapping
https://www.postgresql.org/docs/17/plpgsql-control-structures.html#PLPGSQL-ERROR-TRAPPING
and TigerBeetle reliable submission
https://docs.tigerbeetle.com/coding/reliable-transaction-submission/

Validation: PostgreSQL 17.11, 45 original failure reproductions; 57 fixed checks passed (45 rollback/SQLSTATE checks, 9 success cases, 3 replay cases). No live balance changes.

Production: eight guarded replacements applied and re-read on 2026-09-08.
CI: executable PostgreSQL tests run inside the existing TypeScript Check.
