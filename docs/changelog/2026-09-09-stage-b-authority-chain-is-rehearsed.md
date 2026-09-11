# 2026-09-09: Stage-B authority chain is rehearsed

## What was wrong

The tournament cutover existed as overlapping migration generations and a
second executable SQL mirror. The strict manager fence also inspected the
seat-exit wrapper as if it were still the receipt-aware stack implementation.
That made the real M6 then Stage-B chronology fail closed even though each
migration passed in an isolated fixture.

## What changed

- The final roster and seat authority keeps one database-selected chair for a
  first RUNNING satellite award, and a settled replay is read-only.
- Tournament movement has one mutation RPC, one immutable receipt, and one
  read-only resolver for a lost response after commit.
- The manager fence now proves the complete composed hand-settlement boundary:
  private receipt-aware writer, owner-only seat-exit wrapper, and 12-argument
  public settlement door.
- The abandoned direct-deploy SQL mirror was removed. The migration selected
  by stable suffix is the sole executable Stage-B source.
- Lease transaction fences move from `FOR SHARE` to `FOR KEY SHARE` only after
  exact owner-generation keys exist, allowing heartbeats to advance without
  allowing an owner, generation, or release to pass the live transaction.
- Legacy scheduler mutators, seat reconcilers, amount-trusting seat-exit doors,
  and the duplicate tournament-move writer are retired at their guarded
  database boundaries. No cron, watcher, retry repair, or reconciliation path
  replaces them.

## Verification before production

PostgreSQL 17 database `combined_stageb_final_20260909_02` applied all 13
active migrations in their required order while one session held the release
shared lock and one maintenance freeze remained continuously active. Every
migration committed. The final proof found zero thaw rows, zero fresh engine
authorities, one tournament-move mutation surface, no legacy 9- or 11-argument
hand door, no legacy lease claim door, no retired scheduler job, and no lease
row `FOR SHARE` survivor.

The full server suite passed 8,752 tests in 657 files with 145 documented
skips. The full client and database-law suite reached 18,348 passing tests and
found one missing deliberate seat-guard redeclaration entry; the migration
already documented and enforced that exact re-seat exception, the law registry
was corrected, and the six directly affected guard files then passed 63 of 63.
Client TypeScript and the server build both exited successfully.

## Release boundary

This record is not a production-completion claim. The production ledger must
assign each physical migration version in order during one stopped-engine
freeze. Those exact ledger bytes and database postimages must be proved before
the source files are sealed to their assigned versions, merged, deployed, and
verified on the public engine and static origin.
