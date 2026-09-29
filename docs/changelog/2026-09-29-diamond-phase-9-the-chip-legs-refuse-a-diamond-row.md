# Diamond Phase 9, Step 0: The Chip Legs Refuse A Diamond Row

September 29, 2026. Phase 9 of the Diamond Arena build programme, line "Remove every inherited union/agent distribution and chip treasury dependency": step 0 of `docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md` section 4, the fences that need no decision. Dan's ruling 16 already says there are no unions, agents, commissions, chip wallets or chip ledgers in the Diamond Arena. Both arena switches stay closed. No real entry was written against a real wallet. Nothing is priced. **The line stays open**: steps 1 to 5 (where a Diamond guarantee, a satellite seat, rake and BBJ money go) wait for Dan's answers in section 6 of the design.

## The Database

Migration `the_chip_legs_refuse_a_diamond_row` (applied as `20260929160000`; the recorded text is the repo file without its seven `@live-proof` comment lines, which were added after the apply because a migration that creates no object must say how to see it live):

- The chip supply meter (`fn_ca_supply_snapshot`, a watched guard, redefinition declared) no longer counts a Diamond seat, a Diamond pending add-on or a Diamond event's pools as chips. No Diamond seat or event has ever existed, so every reading the meter has taken is unchanged and its basis stays `pending-addon-v4`. Without this fence, the first busy hour of Diamond play would have looked like unexplained chip supply and paged as a chip leak.
- The two chip guarantee triggers refuse a Diamond event by name instead of reading the arena's chip treasury: `diamond_guarantee_has_no_chip_bank` (the affordability check) and `diamond_overlay_has_no_chip_bank` (the overlay at start). The overlay refusal applies only when there is a shortfall to fund.
- The Diamond creation door refuses by name (`diamond_tournament_money_key_not_read: <keys>`) the six money keys the estate's builder sends and the door never reads: `guaranteedPrize`, `isRebuy`, `isReentry`, `addOnAvailable`, `addOnCost`, `addOnFromStart`. Before this, a value in one of them was dropped and the event was created without it. The builder's defaults (0, false, null) are admitted. The door's own keys (`guarantee`, `rebuy`, `reentry`, `addOn`, `addonCost`) are unchanged. The door's md5 is now `77c664dae1085cb1d222e17e12de8355`.
- The accepted-hand door (`fn_ca_commit_hand_settlement`) no longer refuses every Diamond cash hand that is not hold'em. It admits the games the arena deals by the rule the settler and the admission door already use (`fn_poker_diamond_cash_variant`: nlh, plo4, plo5, plo6, plo8, pineapple, short_deck, flh, flo8). A chip hand never reaches that clause. The admission door already admitted a non-hold'em Diamond table.
- Found by the rehearsal: no Diamond cash hand could commit, hold'em included. The chip provenance receipt added on September 17 (`fn_cash_accept_hand_provenance`) demands a chip settlement claim the Diamond settler never writes, so every Diamond hand was rolled back with "query returned no rows". A Diamond hand now writes no chip provenance receipt and no union P&L cash outcome (`fn_union_pnl_capture_accepted_cash` would have filed it as a blocked outcome in chips). Its own settler receipts it (`poker_diamond_hand_receipts`).

Every chip function changed by asserted substitution: live md5 pinned, old clause present exactly once, reverse substitution proved.

Migration `the_chip_money_tables_refuse_a_diamond_row` (applied as `20260929160100`; recorded text byte-identical to the repo file):

- New `fn_poker_reject_diamond_chip_money` (SECURITY DEFINER, service_role only, registered as a system entry that moves no money) refuses by name (`Diamond Arena Has No Chip Money`, 23514) any row whose club, table or event belongs to the Diamond Arena. For a ticket, the event is the one or the satellite that sourced it. It follows the `poker_arena_no_hierarchy` pattern.
- Trigger `aa_poker_arena_no_chip_money` fires first on INSERT, and on an UPDATE of the columns that name the arena, on ten tables: `chip_ledger`, `rake_records`, `rake_attributions`, `bbj_contributions`, `bbj_pools`, `club_wallets`, `tournament_tickets`, `tournament_guarantee_overlays`, and the two tables behind the view `accounting_payable_earning_sources` (`accounting_cash_rake_sources`, `accounting_tournament_fee_sources`). A view takes no row of its own, so its sources are fenced. Each trigger is declared in `ca_declared_money_triggers` in the same migration.
- Before the fence went up, the migration proved that no such row exists: by index in the migration, and by a full read of the unindexed columns beforehand.
- `tournament_rake_settlements` is left out, because the Diamond fee path writes it until step 3 moves that path.
- The ten locks are taken together without queueing (NOWAIT, retried for up to a minute), so no settlement waits behind the migration.

## The Rehearsal

Each migration was rehearsed with its own fixture as one rolled-back transaction on production, through the real doors, before it was applied.

- First migration (fixture 9.5 s). The creation door refused each of the six keys by name, admitted the builder's defaults and honoured `rebuy`, `addOn` and `addonCost`. A guarantee raise and an overlay at start on a Diamond event were refused by name. Three hands were committed through the real accepted-hand door. The two Diamond hands, one hold'em and one PLO4, were receipted by the Diamond settler and left no chip provenance receipt and no chip P&L outcome. A chip hand on an idle chip table kept all of its evidence. A Diamond cash-out went home. With Diamond seats, a pending Diamond add-on and a Diamond registration present, the meter left out 15,000,050 Diamonds of felt, 5,000,000 of pending add-on and 5,000,000 of event money. No chip money table gained an arena row, and the Diamond identity did not move.
- Second migration (fixture 0.4 s). Sixteen Diamond Arena rows were written across the ten tables: by club, by table, by event, by a ticket's source event, and by an update that would move a chip row into the arena. Each was refused by name. A chip row went through the fence and met only its own rule.
- Incident. An earlier combined rehearsal (16:25 UTC) held the trigger locks on the ten tables for roughly 40 to 90 seconds, because its fixture scanned two very large tables. Production raised critical alerts from 16:26:15 to 16:26:46 (post-commit obligations pending, hand history failures, semantic refusals) and had recovered by about 16:32. The rehearsal was cancelled. After that, the work was split into these two migrations, the fixtures read only by primary key, and the second migration takes its locks without queueing.

## What Is Still Not Here

- Steps 1 to 5 of the design: where a Diamond guarantee, a satellite's promised seats, rake and BBJ money go. These wait for Dan's answers in section 6. Until then a Diamond event with a guarantee or a funded overlay is refused by name.
- Tables downstream of a rake row (for example `rake_distribution_legs`) are not fenced. They are written only from rake rows, which now refuse the arena.

Law: the-chip-legs-refuse-a-diamond-row.
