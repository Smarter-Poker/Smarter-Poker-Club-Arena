# Hand Settlement Roster And Replay Identity

Applied migration `20260908042156_hand_settlement_roster_and_replay_identity.sql` to production on 2026-09-08.

A real PostgreSQL reproduction of the inspected function started two seats at 100 each and submitted A:95, A:95, B:110, each with stack_before 100. The function summed A's -5 twice, so its conservation check passed, but the target map wrote A only once. The result reported success with 205 chips on a table that started with 200. This is a demonstrated function defect, not evidence that a specific live hand used that malformed roster.

The function now rejects duplicate UUIDs, malformed participant fields and mixed absolute/delta input before creating settlement state. It canonicalizes participant order for row locking. New successful receipts store the normalized economic payload and reject a replay that changes stacks or fee/inflow values; an equivalent reordered request remains a replay. Historical receipts without a stored request retain their existing replay behavior. Existing additive-credit rebasing remains intact.

Validation: original 200-to-205 defect reproduced in an isolated fixture. Seventeen fixed cases cover cash and tournament rosters, malformed/mixed input, reordered replay, changed player balances, fee reclassification and preserved mid-hand credits. All pass on PostgreSQL 17.11. The existing 34 felt/tournament source guard tests also pass. The combined isolated accounting suite now has 155 passing cases (57 shared writers, 17 satellites, 64 cashouts, 17 hand rosters). The production DDL compile probe rolled itself back; migration hash preconditions then passed. Service-only grants remain unchanged.

No historical seat balances were edited. Combining cash-hand stacks, rake, BBJ and insurance into one complete transaction remains open; this migration closes the independently reproduced roster defect and does not claim to solve that larger boundary.
