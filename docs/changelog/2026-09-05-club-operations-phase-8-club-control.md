# Club Operations Phase 8: club control

The last phase of Dan's eight-phase upgrade. Four surfaces - settings, rules,
the promo vault and the player offer feed - and **two of them told an operator
that something had happened when nothing had**.

Everything below was proved against production inside a transaction that was
rolled back, in the `DO` block form that ends by raising, so the rollback is
not optional (CLAUDE.md 11.5).

## The vault sent nothing at all

`ca_promo_vault_grant` decremented `promo_vault_inventory`, wrote a
`promo_vault_records` row, and returned `success: true`. **The recipient
received nothing** - no entitlement, no trigger on the records table, no
follow-up job. The owner spent stock bought with diamonds, the shelf went down,
the player got nothing, and the toast said it was sent.

The original migration says so in its own words
(`20260823_05_promo_vault.sql`): _"Deliberately does NOT try to activate the
benefit on the recipient's account ... The record is the contract; wiring each
item type to its subsystem is follow-up work."_

**Nothing had been lost yet.** `promo_vault_records` held zero rows across the
platform - no grant has ever been made - so this is a forward fix with nobody
to repay.

### What can be delivered, and what is refused instead

Each catalogue item was traced to the code that would have to read it.

| item                  | verdict                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `time_bank_50`        | **Delivered.** `feature_purchases (feature='time_bank_seconds', uses_remaining)` is read by `fn_time_bank_allowance` and decremented by `fn_consume_time_bank`; the engine calls both. `sp_grant_shop_item` already writes exactly this row for the club shop, so the shape is proven rather than invented.                                                                                |
| `rabbit_hunt_100`     | **Delivered.** Same table, `feature='rabbit_hunt'`, read by `fn_consume_rabbit_hunt` from the engine's `revealRabbitHunt`. That function's own comment says its purchased-pack branch exists "to make promo_vault 'rabbit_hunt_100' pack mean something" - and nothing had ever written such a pack.                                                                                       |
| `vip_card_*`          | **Refused, and this is Dan's call.** The columns exist and are read everywhere, but the catalogue's tiers are bronze / sapphire / gold and the live vocabulary is `'monthly' \| 'lifetime'`. The string `sapphire` appears in exactly one place in the estate: the vault seed itself. Deciding what a Gold VIP Card gives a player sets what a player is owed, which 10.9 reserves to Dan. |
| `mystery_card_30d`    | **Refused.** `mystery_card` appears only in the catalogue seed and an icon glyph. There is no such feature.                                                                                                                                                                                                                                                                                |
| `multiplier_1500_30d` | **Refused.** The nearest column is `profiles.diamond_multiplier`, a guarded `numeric(4,2)` that cannot hold 1500, and wiring a "1500x multiplier" to a diamond EARN RATE would mint diamonds at 1500x and break the mint invariants.                                                                                                                                                       |

**A refusal costs the club nothing**: it returns before the inventory is
touched, so the stock stays on the shelf. That is the whole point - an operator
who cannot send a Gold VIP Card today still has the card tomorrow, when
somebody decides what it means. The deliverability check is asserted to run
BEFORE the decrement, by position and not merely by presence.

The grant is also retryable now (`p_op_id`), the same shape phase 7 gave
`fn_respond_chip_request`. The five-argument form is kept as a wrapper because
the bundle serving players right now calls it; dropping it would break the Send
button between the migration and the next publish.

Proved, then rolled back:

```
grant 2 x time_bank_50   success, stock 10 -> 8, delivered_ref set
retry, same op_id        replayed=true, SAME delivered_ref, one pack only
feature_purchases        uses_remaining = 100   (2 packs x 50, what the engine consumes)
grant 1 x Gold VIP Card  refused: "A Gold VIP Card Cannot Be Sent Yet..."
vip stock                4 -> 4   (untouched)
```

## The Claim button paid nothing, and let the browser name the figure

`claimPromotion` inserts a `promotion_claims` row and increments a counter. It
credits no wallet. Both callers then emitted `BALANCE_UPDATED` and toasted
"Promotion claimed!", so every surface re-read a balance that had not moved and
the player was told they had been paid.

Worse, the row's `bonus_amount`, `wager_required` and `status` came **from the
browser**, and the only INSERT policy on that table is `user_id = auth.uid()` -
it checks WHO is claiming and nothing about WHAT. Any signed-in caller could
post a claim carrying any figure into a money column.

A `BEFORE INSERT` trigger derives all three from the `promotions` row now and
discards whatever arrives. Proved, then rolled back: **a claim asking for
999,999.99 on a 1,000 pool over 40 claims was recorded as 25.00**, its status
forced to `active` by the promotion's own wager requirement.

Paying it is not fixed here, deliberately: what a claim on a leaderboard or
milestone promotion owes a player is Dan's to set. So the figure is now
trustworthy and the message says what actually happened.

**And the one paying path cannot fire at all.** `getDepositBonus` filters on
`type = 'deposit_match'`, and `promotions_type_check` allows only
`leaderboard, rake_race, milestone, mystery, high_hand`. The single code path
that calls `add_to_promo_wallet` is querying for a type the table forbids, so
it has always returned 0. Recorded here rather than fixed, because making it
fire is the same "what is a player owed" decision.

## The rules save reported success when the database refused it

```js
const { error } = await supabase
  .from('clubs')
  .update({ settings: newSettings })
  .eq(saveCol, saveVal);
if (error) throw error;
toast.success('Club rules updated!');
```

Three defects in six lines, and they compound.

- **No `.select()`**, and the only `clubs` UPDATE policy is
  `owner_id = auth.uid()`. A co-owner or admin - both of whom this page SHOWS
  the Edit button to - matched zero rows, got a 204 with no error, and watched
  the page paint text that was never stored.
- **A read-modify-write of the whole `settings` document**, which carries seven
  other keys on this club: rake cap, both buy-in bounds, straddle, run it
  twice, the time bank default and the rake percentage. Editing prose could
  silently revert the club's rake configuration.
- **No trace.** `fn_audit_club_settings_change` watched sixteen columns and
  `settings` was not among them, nor `tagline`, nor `lobby_message`.

`fn_set_club_rules` writes the one key with `jsonb_set`, gates on owner,
co-owner or admin - resolving the mismatch in the direction the page always
implied - and RETURNS what it stored, so an empty result is a refusal. The
audit trigger gained the three columns it was missing.

Proved, then rolled back: the owner's write returned the stored text, all seven
other keys survived untouched, and a non-member was refused with
_"only an owner, co-owner or admin can change the club rules"_.

## The settings page wrote four columns it offers no control for

`tests/settings-only-write-what-they-offer.test.ts` already states the rule for
the other settings surface. This page broke it four times.

- **`spins_enabled` is the live one.** The lobby reads it, `SpinActivationPanel`
  owns the control, and this page had none - yet blind-wrote whatever it had
  loaded on every save. A stale copy could turn Spins off for a club that had
  just turned it on.
- `spins_preseed_amount` and `spins_wallet_funding` have no control and no
  reader anywhere in `src/` or `server/`.
- **`bbj_rake_enabled` had a visible ON/OFF switch and no reader at all** - the
  bad beat jackpot engine reads the separate `bbj_enabled`. An owner could turn
  it off and every table went on taking BBJ rake. The switch is removed rather
  than wired, for the same reason the Time Bank field on this page was removed
  in August: whether a club takes BBJ rake sets what players pay, and that is
  Dan's. A switch that does nothing is worse than no switch.

Two more from the same page:

- **`inUnion` was dead state.** `setInUnion` had no caller, so the flag was
  permanently false and the Rake & BBJ section it guards was shown to every
  club - including clubs whose rake their union governs. `union_id` was already
  in the select and simply never read.
- **`WATCHED_COLUMNS` had drifted in both directions**, carrying five fields the
  form stopped rendering and omitting `tagline` and `lobby_message`, which it
  does render and write. A co-owner setting the day's message from the lobby
  left this form showing the old one with nothing to say it was stale.

## Verified

- Migrations `20260905083005`, `20260905083442` and `20260905084034`, one
  transaction each, applied and recorded.
- 13 pins in `tests/unit/phase8ClubControl.test.ts`; the `WATCHED_COLUMNS` pin
  in `clubSettingsRules.test.ts` moved to the rule rather than the membership,
  in the same commit.
- The discarded-error ratchet caught the improvement it should:
  `ClubRulesPage.tsx` went from 3 discarded reads to 2, and its baseline came
  down with it.

## Still Dan's, and named rather than guessed at

1. **What a VIP card, a Mystery Card and a Multiplier give a player.** Three
   catalogue items are on sale with no subsystem behind them.
2. **What a claim on a leaderboard, rake race, milestone, mystery or high hand
   promotion pays**, and whether `deposit_match` should be a legal promotion
   type at all.
3. **Whether `bbj_rake_enabled` should become real**, and if so what turning it
   off does to a club's rake.
