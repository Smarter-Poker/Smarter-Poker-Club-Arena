# Phase 6 of 8: the ledger speaks to the player (2026-09-20)

**THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER.** (Dan, 2026-09-13.)

Dan, 2026-08-20: every line a player reads is Title Case and carries no em
dash. Phase 6 was scoped as "server-written ledger copy defects: the pvp
refund em dash and the bare adjustments". The deep dive found the defect is
wider than two writers, and fixed it where every reader meets it.

## What was read

`diamond_transactions.description` is written by twenty-four functions for
two audiences at once. Across every row on 2026-09-20 (299 distinct shapes,
85,155 rows): 59,000 daily challenge claims carry a challenge id ("Challenge
reward: sd_10"); 418 reconciliation credits carry an audit sentence
("closes pre-existing ledger drift (signup grants, admin grants,
engine-direct UPDATEs that bypassed add_diamonds_to_balance)"); 488 PvP
refunds and 212 welcome bonuses carry an em dash, the refunds with the
number glued to its unit ("10diamonds"); 20 rows carry an emoji; the Diamond
Spins perks carry a table uuid ("Diamond Spins: Throwables for <uuid>");
"Retro-credit for orphaned daily_login claim ... Cowork audit", "Clawback:
... refund replay", "Make-good: egg clamp bug", "Test deduct". Three Club
Arena surfaces printed that column to players after a Title Case pass, and
so did the World Hub modal. The em-dash writers are legacy (last row
2026-08-23); the id and audit writers are live. The journal is append-only
(`trg_ca_append_only`), so history cannot be rewritten, and it should not
be: the operator's note is the operator's record.

## What shipped

**One place, next to the one kind map** (migration
`20260920142916_the_ledger_speaks_to_the_player.sql`, applied and
recorded as `the_ledger_speaks_to_the_player`):

- `fn_diamond_kind_row_label(kind, amount)`: the player-facing row label
  for a kind ("Daily Challenge Reward", "Diamond Arena Buy-In", "PvP
  Refund"), falling back to the bucket label from `fn_diamond_kind_bucket`.
- `fn_diamond_ledger_line(type, transaction_type, source, amount,
description)`: the description when it is player copy, cleaned - em and
  en dashes become a comma clause, "10diamonds" becomes "10 diamonds", the
  diamond glyph becomes the word, other emoji go, trailing `[uuid]`,
  `(match <uuid>)` and `for <uuid>` go - else the row label. An operator
  note (audit, reconciliation, retro-credit, clawback, make-good,
  certification, test, cowork, replay, bypass, drift, rollback, batch), a
  machine tail ("Challenge reward:", "Diamond Rewards v2:", "Diamond
  deduction:", "Training:"), a bare snake_case kind, a uuid that survived
  cleaning, and the two kinds that always carry an id (daily challenge
  claim, daily mission milestone) take the label.
- `player_line(diamond_transactions)`: a PostgREST computed column, so
  `select=...,player_line` returns the line with the row under the row's
  own RLS. Pure, IMMUTABLE, no table reads, refused to anon.

Measured over all 299 shapes / 85,155 rows after applying: zero lines with
a dash, an emoji, a uuid, a glued unit, a bare kind, an operator word, or
nothing at all.

**Club Arena reads it**: `useDiamondLedger` (the Send and Receive panes),
`DiamondWalletModal` and the VIP page's recent diamond activity select
`player_line` and print it (Title Cased by `formatPopupText`), never the raw
description. The send/receive naming path (a friend's name from the friend
list) is unchanged.

**World Hub reads it** (same day, `agent/cw-hubwallet3/feat/phase-6-...`):
`/api/store/diamond-transactions` selects `*, player_line` (a computed
column is not part of `*`) and the modal prints it, keeping its identity
split for transfers; search matches the line the player reads.

## Tests

- `tests/the-ledger-speaks-to-the-player.law.test.ts` (+ `docs/laws.d`):
  the one place strips every dash, glyph, glued unit and uuid; operator
  notes, machine tails, bare kinds and test rows take the label; row labels
  are Title Case with no em dash and name the arena as diamonds; the
  computed column is pure and refused to anon; every surface selects
  `player_line` and never prints the raw description.
- `tests/unit/theLedgerSpeaksToThePlayer.test.ts`: the hook selects
  `player_line` and surfaces it as `line`; a row without it falls back to
  the label.
- World Hub: `__tests__/the-ledger-speaks-to-the-player.law.test.mjs`, wired
  into `_test-guards-exist.test.mjs`.

## Recorded, not fixed here

The live writers that put an id or an audit note in the description
(`claim_daily_challenge_serialized_body`, `award_diamonds_v2`,
`fn_diamond_game_take_bet` via `deduct_diamonds`) belong to their own
programmes; the reader no longer depends on them, and the classifier trigger
already files their rows for the operator.
