# A Refunded Earlier Entry Is Not A Second Entry

**Frozen in production, 2026-10-24.** Happy Hour Bounty (NLH), Table 20 (`c30f589c`), was parked before it ever dealt (break `97c2401a`, 22:53:35 UTC). One player, `5ba8dd2b`, was seated with 5,000 chips. Every re-admission was refused with `F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN`, so the player could not play, move or bust. Twenty other tables kept dealing. `fn_f06_withdraw_unplaceable_park` needs a roster of 2 to 10, so nothing else could release a roster of 1.

## Cause, read from rows

`f06_movement_never_dealt_prior` counted the player's funding receipts in the event, by registration OR by user, and required exactly 1. It found 2:

- `18f34c67`: an entry from 2026-10-23 10:46 for registration `1235d849`. That registration no longer exists, and its 10.00 buy-in came back as posted refund `e9b668b9` at 13:20.
- `5e669178`: the late re-registration at 22:51:47, which is the entry actually seated on this table.

In the last 2 days, 917 user/event pairs carried 2 entry receipts. Any never-dealt park of such a late entrant would freeze the same way.

## Fix

Migration `20261024232734` makes an anchored edit to the installed proof (pre-image def `1952ea35`, post-image def `63184403`, body `e0677c7a`):

- It still requires exactly one receipt, now counted for **this** registration.
- Another receipt of the player is admitted only when every such receipt is a whole earlier chip entry for a registration that no longer exists, and the posted refund legs from the event to the player before this entry sum to exactly those entries.
- Anything else still refuses: a rebuy, an add-on, a diamond receipt, a later receipt, a surviving registration, or a refund that does not match.

## Proof and release

The fix was proved first on production, in one rolled-back, read-only call with pg_temp helpers:

| Image | Result on Table 20 |
| --- | --- |
| Pre-image | `F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN` |
| Post-image | Roster 1, first hand, no permits; entry `5e669178` (registration `d4c788b7`, 5,000 chips) |

The migration's own block was also run up to its `EXECUTE` (pg_temp target) and reproduced the asserted body md5.

No row is touched. The engine's existing park re-admission takes the proof on its next pass, and the break moves the player through the normal move receipts.

Pinned by `tests/a-refunded-earlier-entry-is-not-a-second-entry.law.test.ts`. The successor list in `tests/a-table-that-never-dealt-is-moved-from-its-seated-entries.law.test.ts` names it.
