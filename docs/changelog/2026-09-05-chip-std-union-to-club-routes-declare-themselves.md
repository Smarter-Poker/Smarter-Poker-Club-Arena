# 2026-09-05 - chip standard: every union to club chip route declares itself

**Branch** `fix/union-to-club-money-declares-itself`. One migration, `20260905034557_every_union_to_club_chip_route_declares_itself`, probed rolled back first, applied 03:50 UTC, mirrored byte-exact. Law test `tests/every-union-to-club-chip-route-declares-itself.law.test.ts`. Every figure below read from production between 03:39 and 03:52 UTC.

## What Dan reported, and what the journal says happened

Dan sent promo from the Midway Union wallet to SHARK CLUB, Club JAQK and a KingFish agent at 02:51 UTC and none of it showed in a promo wallet. Another agent had already found the cause and shipped the fix by the time the report reached this programme (PR #3065, merged as `2a2fe9083`; World Hub #1372), so this note verifies rather than rebuilds, and then closes what the incident exposed in the chip standard itself.

Read from `chip_ledger`: at 02:51:02 and 02:51:14 the two club sends went through `fn_union_send_to_club_atomic`, the Club Bank route (`union_wallets.chip_balance` to `clubs.chip_treasury`), because the union modal routed a club target to `unionApi.sendToClub` whatever wallet was chosen. Each 5,000 landed as TWO undeclared `adjustment` halves through `settlement_suspense`, so the money was in the Club Bank and the journal could not say why. At 02:51:20 the KingFish 5,000 went through the promo route and landed, declared and balanced, in `agents.promo_wallet_balance` (an agent promo float, which is where an agent target is supposed to land). At 03:07:38 the reroute migration moved the money with keyed rows: `promo_reroute_reversal:<club>` (club_treasury to union_bank, 5,000 each) and `promo_reroute_send:<club>` (union_wallet to `clubs.promo_balance`, 5,000 each).

Verified live: Midway Union promo wallet 32,546.42 (report said 32,546); union bank 61,981.34 (report said 62,016; the difference is rake and BBJ promo sweeps since); Club JAQK `promo_balance` 5,000.00; SHARK CLUB `promo_balance` 5,000.00; the KingFish agent float 5,000.00. Both #3065 migrations are in `schema_migrations` (as `20260905030738` and `20260905031852`) and on `main`. No suspense rows since 03:00, no supply-meter effect (a reroute inside the platform is a zero-sum move and the 03:05 snapshot's `unexplained` is the definitional step already reconciled to the register), no new drift incident from the reroute.

## What the chip standard learned, and closed tonight

1. **`fn_union_send_to_club_atomic` never declared its ledger.** It is the legitimate Club Bank route and the door the modal wrongly called; every send through it wrote two unrelated adjustments through `settlement_suspense`. It now writes one keyed row, `union_send`, `union_bank` to `club_treasury`, `union_send_to_club:<op>` (an op_id is minted when the caller sends none). Probed rolled back: a 1.00 send produced exactly `union_send union_bank -> club_treasury (clubs.chip_treasury) 1.00`, zero suspense rows.
2. **The `bbj_main` branch of `fn_union_promo_send` was an undeclared jackpot door.** Phase 4.3 declared every door that writes `bbj_pools` and missed this one (union promo to `bbj_pools.main_balance`). It now writes one keyed row, `promo_send`, `union_wallet` to `bbj_pool`, `union_promo_to_bbj:<op>`, which the BBJ meter reads as a seed rather than an unexplained bank move. Probed rolled back: `promo_send union_wallet -> bbj_pool (bbj_pools.main_balance) 1.00`.
3. **`fn_club_promo_wallet_send` (new in #3065) had no registry row.** `fn_ca_money_rpc_drift()` filed `rpc-drift:fn_club_promo_wallet_send` at 03:39:14 UTC, within a second of the first call after it landed. That is the net doing its job: a money door that is not in `ca_money_rpc_registry` is an incident, not a surprise. Registered (it already declares a keyed `promo_send`); the incident is resolved with this migration as `correction_ref`. The daily `ca-money-rpc-drift-daily` at 05:25 would have filed it unprompted.

After the migration `fn_ca_money_rpc_drift()` returns only the two cash-seat doors named for their owner below.

## Named for others

- **Mirror version mismatch in #3065.** The files on `main` are `20260905030103_union_promo_lands_in_the_club_promo_wallet.sql` and `20260905031715_the_club_promo_wallet_is_where_union_promo_lands.sql`; the rows in `schema_migrations` are `20260905030738` and `20260905031852` with the same names. The content shipped; the versions did not. A tool that replays unapplied file versions would re-run a money reroute. Correct forward (register the file versions as applied, or re-mirror under the applied versions); do not edit the applied rows.
- `fn_cash_seat_move_execute` / `fn_cash_seat_swap_execute` remain unregistered money doors (`rpc-drift` incidents open since 02:56).
- The two 02:51 suspense pairs stay in the journal as the record of the defective sends; they are cancelled in money terms by the keyed 03:07 reversals and are cited in `qr:suspense:2026-09-05`.
- Dan's open question from #3065, whether the rake wallet should ever have a club route, is his.

## Added to the audit list

Union to club money now has three declared routes and one meter over them: `fn_union_send_to_club_atomic` (bank), `fn_union_promo_send` (promo to club promo wallet, promo to jackpot main), `fn_club_promo_wallet_send` (club promo wallet to player wallet or agent float), all keyed, all registered, all counted by the supply meter and the rpc drift check. The next gate re-reads all three from the journal.
