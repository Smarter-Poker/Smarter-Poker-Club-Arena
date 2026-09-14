# Diamond Phase 8: A Tournament Pays From Its Own Custody

Status: Phase 8 money path complete on the database side. Diamond Tournaments Remain Refused At Every Door (`tournaments_enabled` is false). No real entry has been written against a real wallet, and no real prize has been paid.

## What A Diamond Tournament Could Not Do Until Now

After "a tournament entry is custody" (earlier today) a Diamond event could take entries, add-ons, re-entries and refunds, launch through the estate's protocol and be cancelled before its start. It could not finish. The terminal path is the chip estate's one path - `fn_complete_tournament_terminal` -> `fn_settle_tournament_places` -> `fn_settle_tournament_obligation` -> `fn_credit_and_log`, then `fn_settle_tournament_rake` - and its last two steps credited a club chip wallet the arena refuses to hold and banked the fee from `rake_records` rows a Diamond entry never writes. The terminal writer also demanded a `tournament_escrow` shadow that a Diamond event never opened.

## The Shape

Nothing new pays. The terminal path is kept whole and two of its steps learn where a Diamond event's money is:

- **The prize.** `fn_credit_and_log`, for a Diamond event only, credits through `fn_poker_diamond_tournament_pay`: the same credit key claimed in `wallet_credit_idempotency` before a Diamond moves, the same bank check, the same `tournament_payouts` evidence row. The Diamonds come out of the PRIZE parts of the event's custody rows, oldest first, and land in the winner's `profiles.diamonds` as `arena_withdraw` - a move inside the player supply that the Mint's register does not follow, exactly as a cash-out. Whole Diamonds only; the ladder is already whole-Diamond behind the unit rule.
- **The fee.** `fn_settle_tournament_rake`, for a Diamond event only, settles through `fn_poker_diamond_tournament_settle_fee`: each player's OWN fee part comes out of their own custody row, journaled as that player's spend (the register retires it from that player, as it retires every spend), and the same total is minted to the house in the register and added to `ca_diamond_house`, exactly as `fn_ca_mint` issues to the house. Players + house + custody = register, before and after. The rake settlement row says `diamond_house`; the terminal writer and the receipt reader admit that destination for a Diamond event and read the fee from the Diamond fee bank.
- **The shadow.** `tournament_escrow` opens for a Diamond event at the start of its terminal settlement, copied from the Diamond ledger with its exact parts, so every apply that follows moves it as a chip event's evidence moves it and the writer's exact-zero close is the same close.
- **The close.** When the banks are empty the zero-balance custody rows are released through the estate's own release door under the refund authority, so a settled event leaves no open entry behind.

Every custody row knows its parts from the ledger (an entry is 99 prize + 11 fee; an add-on is all prize, which is how the chip rebuy core prices it), so a prize drains prize parts only and the fee drains fee parts only; each drained row records a release movement naming its bank and carrying the journal row the Diamonds arrived in.

## The Chip Path Is Proved Unchanged

`fn_credit_and_log`, `fn_settle_tournament_rake`, the terminal writer and the terminal receipt reader are each edited in place: live text read, md5 pinned, the documented clauses replaced (three, one, six and two), the result re-created, and the reverse substitution proved to give back the pinned text. The chip credit (`fn_credit_player_wallet_once`), the chip receipt (`log_wallet_transaction`) and the chip rake destinations (`increment_union_wallet`, `credit_club_rake_to_treasury`) are asserted present at the end.

## What The Rehearsal Found, And What Changed Because Of It

The whole life of a Diamond event was rehearsed against production inside one transaction ending in a deliberate error: six players entered as clients, one withdrew and came back, the event launched through the estate's protocol, one player added on, five busts were recorded, and the engine's one terminal door was called under service authority. Ten runs before `REHEARSAL OK`. Three things the design could not have known without running it:

1. **The deferred entry guard sees row versions.** P0814 (an entry holds exactly its movements) is a deferred constraint trigger, and a deferred trigger presents each queued row version as it was at its event, against the movements as they stand at commit. A row drained twice in one settlement - the fee, then a prize - would have presented its first version against the final sum and refused the whole terminal at commit, with every prize rolled back. The single-transaction rehearsal cannot see a commit, so a commit boundary was simulated by firing the deferred guard after every door; the original drain failed exactly there (proved on a negative run), and the drain now writes the movement before the balance and checks P0814 at the end of each drain.
2. **A refund is not proportional.** The chip escrow shadow, opened "at first sight", splits a refund across the banks in proportion to what came in. A Diamond refund returns an entry's own parts (99 + 11), and once an add-on carried no fee the proportions disagreed by two Diamonds. The shadow now opens from the Diamond ledger with its exact parts and refuses to open if it disagrees with the banks or the custody.
3. **The fee belongs to each player.** The first fee drain took the fee from the oldest rows, so one player's register history would have shown them spending everybody's fee. The drain now takes one bank at a time, and the fee bank of a row is exactly that player's fee part.

Also found: the estate's launch rewrites the payout structure from the final field (20% of six players is two places), so the rehearsal proves two whole-Diamond places (447 and 257 of a 704 pool) and a 66 fee, six spends of 11.

## What Is Deliberately Not Here

Bounties, PKO, mystery bounties, satellites, spins, guarantees and horse funding are Phase 9; the pay door refuses a bounty by name. The engine's `placeLadderUnitCents` still returns the chip unit for its mid-event display of `tp.prize` (cosmetic; the database ladder is unit-aware); that follows in the engine change.

## Evidence

- Applied to kuklfnapbkmacvwxktbh as `20260914032315 a_diamond_tournament_pays_from_its_own_custody`; the stored statement text is byte-identical to the repo file (md5 `42592e8fc6608fcb8a6cc45f4fd3446d`).
- Final rehearsal report: `REHEARSAL OK: entries=6(+1 refund,+1 re-entry) launch+addon=ok(704 prize,66 fee) prizes=447.00/257.00(2 places of 6) fee=66->house(6 own spends of 11,register:burns=fee,+1 house mint,supply unmoved) custody=closed,shadow=zero,no chip rail replay=idempotent,receipt=proved,P0814=held at every commit | ledger_rows=12 mint_rows=+7`, then rolled back; `fn_ca_diamond_register_vs_supply().difference` unchanged across the whole run.
- Negative run: the same rehearsal with the pre-fix drain fails at the first simulated commit with `P0814 A Diamond Tournament Entry Holds Only What Was Reserved For It`.
- After apply: five owner-only settlement steps present, `tournaments_enabled` false, zero settlement rows in the ledger, every watched guard on its baseline (none of the four edited chip functions is watched).

Law: a-diamond-tournament-pays-from-its-own-custody.
