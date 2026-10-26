# Short Deck, Omaha Hi-Lo and Pineapple never run Lightning (2026-10-25)

## The ruling

Dan, 16:55 Central, verbatim:

> SHORT DESK AND OMAHA HI LOW SHOULD NOT BE RUNNING LIGHTNING AT THIS POINT, JUST FEEDER GAMES.
>
> AND PINNEAPPLE AS WELL, SHOULD ONLY BE FEEDER GAME, NOT LIGHTNING

Approved for production at 17:22 Central: "Approved: install the rule on
production that Short Deck, Omaha Hi-Lo and Pineapple never run Lightning,
and rename the four drained games."

## What was live

Four Midway games of these variants were running Lightning: FLO8 0.25/0.50,
PLO8 0.25/0.50, Short Deck 0.25/0.50 and Short Deck 0.50/1.00. No Pineapple
game had Lightning (all 15 are Classic).

## The stand-down (21:57-21:58 UTC)

Each was drained through the operator door, `fn_lightning_operator_control`
with `drain`, as the Midway owner, after a rolled-back probe of the same four
calls. All four drains completed within 80 seconds. 56 pool sessions closed
(every one a horse; no human was in these pools). Of the 48 horses whose
anchor seat then closed, 35 cashed out through the ordinary seat cash-out
(receipt per seat) and 13 were moved by the must-move controller to another
table of the same game (equal source and destination rows in
`cash_seat_move_ledger`). No chip was lost or created.

## The rule (migration 20261026015255)

Mirrors the six-seat rule (20261020005222) door for door:

- `fn_lightning_variant_allowed(variant)` is false for short_deck, flo8, plo8,
  pineapple (and the spellings shortdeck, omaha8, o8, pineapple_holdem) and
  for a missing variant.
- Constraint `cash_games_lightning_variant_allowed`: these games exist in every
  ordinary state; only `lightning_enabled`, `pending_on` and `lightning` are
  refused.
- `LIGHTNING_VARIANT_NOT_ALLOWED` at the operator door (enable, resume, enable
  joins, lightning_v1 on), rollout readiness, hand formation, the hand guard
  trigger and the thresholds reader (`lightning_allowed` false).
- `fn_cash_game_create` refuses an Action, Madness or Lightning request for
  these variants before anything is written. Classic is unchanged.
- `fn_cash_template_defaults` is deliberately not touched: the floor trigger
  calls it on every write to `cash_games`, so a raise there would stop every
  write to the four existing games.

The four games were renamed for their own template (FLO8 0.25/0.50 Madness,
PLO8 0.25/0.50 Action, SHORT_DECK 0.25/0.50 Madness, SHORT_DECK 0.50/1.00
Madness), and their open tables follow the same name projection
20261023230807 uses. They keep running as must-move feeder games.

Verified before install without DDL on production: every replaced function's
md5 matched, every anchor was unique, the rename was probed in a rolled-back
transaction (four games and five tables renamed, nothing else written), and
the new functions compiled and passed behaviour checks on a scratch Postgres.

## The client

- `isLightningVariant` / `LIGHTNING_EXCLUDED_VARIANTS` in
  `src/lightning/lightningLobby.ts`; `isLightningEligible` takes the variant.
- The Join Lightning door (`lightningEntryDecision`) and the lobby card's
  Lightning state read the variant.
- The lobby's Lightning Games mark is drawn only for a variant that may run
  Lightning, so the renamed Madness and Action games read as feeder games.
- The create screen offers Short Deck, PLO8, FLO8 and Pineapple only as
  Classic, with one note naming all three.

Pinned by `tests/lightning/lightning-never-short-deck-hi-lo-pineapple.law.test.ts`.
