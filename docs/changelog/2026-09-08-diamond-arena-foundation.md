# 2026-09-08 - The Diamond Arena's accounting foundation

Ruling 16 of `docs/DIAMOND-RULINGS.md`, with ruling 14. Migration `20260908034530`, applied and registered. **No club is created here, no table opens, and no diamond moves.** What this builds is the part that is expensive to retrofit once the arena is live.

## 1. What was built

- **A club says which asset it is denominated in.** `clubs.asset` (`chips` by default, `diamonds` for the arena) and `clubs.is_platform`, with a unique index so only one club can ever be the platform's. All four existing clubs are chips, which is what they have always been.
- **`ca_arena_settings`**: the arena in one row - which club it is (NULL until the club exists) and the settlement window from ruling 14 (14 days). Dan owns the window.
- **Two doors, `fn_arena_deposit` and `fn_arena_withdraw`**, exact mirrors of each other. A deposit moves the diamonds out of the player's wallet, journals the movement with class `arena`, and credits the arena club wallet; a withdrawal reverses it. Both are idempotent on their op id.
- **`fn_ca_arena_diamonds()`**: what the arena holds, so a deposit reads as a move rather than a disappearance.
- **A cross-asset seat guard and the settlement window, both LOG-ONLY** (`DR15`, `DR16` in `ca_diamond_rule_modes`, `flip_after` 2026-09-22). A guard that can refuse a seat can strand a player mid-hand, and there is no arena traffic yet to justify that risk; they flip the same way every other rule does.

## 2. The two things the probe taught

**The Mint is admin-only, and that is the point.** The first draft had both doors call `fn_ca_burn` and `fn_ca_mint`. The probe returned `the_mint_is_admin_only`: a player's own action can never be the Mint's caller. Giving these doors a way around that check would have put a hole in the one door the whole standard rests on. They now do what every other player-facing money path does - move the balance, write the journal row - and `trg_ca_diamond_register_follows_journal` turns that row into the register entry. A deposit registers as a burn, a withdrawal as a mint, and the register still always says how many diamonds are inside the arena.

**A membership is a join.** `fn_require_explicit_club_membership_source` refuses any `club_members` INSERT that is not a Join A Club. The deposit therefore funds an existing membership and tells a player who has not joined to join (`ARENA_JOIN_REQUIRED`), rather than creating a membership as a side effect of paying.

Both doors write `profiles.diamonds`, so both are added to `fn_guard_profile_privileged_columns` - the same omission that had made `send_stream_gift` unreachable for a player until this morning.

## 3. The probe (one transaction, rolled back by its final RAISE)

```
PROBE OK (rolled back):
1 no arena yet: both doors refuse politely.
3 deposit: wallet 500 -> 300, arena 200.00, burned and journaled as arena.
4 replay: the wallet did not move again.
5 withdraw: wallet 450, arena 50.00, registered as a mint, register = wallet.
6 over-withdraw: refused, nothing moved.
7 settlement window: filed and allowed while log-only.
```

## 4. A lock-order note, since this is the third migration this week to pay for it

Altering `clubs` and then creating a trigger on `table_seats` deadlocked against a live seat, which holds `table_seats` and reads `clubs`. Both locks are now taken first, in one statement, before any DDL.

## 5. Not this branch's, fixed anyway

`check-phantom-tables` reported `fn_consume_rabbit_hunt_v2` as a phantom rpc on every branch: the function is live and is declared by `20260907234436`, but no manifest fragment named it, and `server/src/engine/ServerTableEngineSettlement.ts:206` calls it. Declared in a fragment of its own so the tree is green for everyone (CLAUDE.md section 4, fix-first).

## 6. Verified after apply

Four clubs, all `chips`; no platform club; `fn_ca_arena_diamonds()` 0; `DR15` and `DR16` both `log`; `fn_ca_mint_supply('diamonds')` 1,023,527 = `SUM(profiles.diamonds)` 1,023,527.

## 7. What Phase 5 still needs before a table opens

The arena club row itself (a `join_club`-shaped creation, with `asset = 'diamonds'`, `is_platform true`, `union_id NULL`), its `bbj_pools` row, rake and fees routed to `ca_diamond_house`, horse funding from the house, and the reporting surfaces learning `asset`. None of that is money that exists yet; all of it now has a place to go.
