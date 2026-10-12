# 2026-10-05 - Mystery bounty at the table: no false top-bounty toast, chests announced, badges honest

Client only (`src/**`, `tests/**`). Four defects found by the mystery bounty audit at 455ec7ee.

1. **False "Top Mystery Bounty" on every pre-phase knockout.** `isMysteryPull`
   accepted `bounty_collected` with mode `mystery_pre`. Every pre-phase head is the
   same flat figure, so it ranked 1 every time and every routine bust announced
   "X Just Pulled The Top Mystery Bounty Worth 8". Only a chest reveal
   (`mystery_bounty_revealed`) is a pull now. The engine half (no rank on a head)
   ships on `claude/mystery-engine-20261005`.
2. **No announcement when the chests go live.** `mystery_bounty_activated` was heard
   only by the lobby hook. TablePage now flips its mystery phase and raises
   "Mystery Bounties Are Now Live" through the Toast layer, once per event per table.
3. **Seat badge kept the flat head through the chest phase.** The phase is read from
   `tournaments.mystery_bounty_stage` on load and from the activation event; while
   live, each remaining player's badge reads as a mystery prize ("?", aria-label
   "Mystery Bounty") on the same badge art.
4. **Dead realtime listener.** The `postgres_changes` UPDATE listener on
   `tournament_players` never fired (the table is not in the realtime publication).
   Removed. The heads are now re-read when the engine's seat list changes (a player
   balanced in), so a moved-in PKO head no longer waits up to 30 s. No new timer.

Rules kept pure in `src/utils/mysteryBountyTable.ts`. Tests:
`tests/unit/mysteryBountyTable.test.ts`, `tests/unit/mysteryBountyCelebrationContract.test.ts`.
