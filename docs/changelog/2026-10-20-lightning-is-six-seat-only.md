# 2026-10-20: Lightning is six-seat Action and Madness only

Dan, 2026-10-19 19:44 Central, verbatim: "classic games never get lightning
games, only action and madness, make all lightning games 6 handed."

The first half was already law (`20261016232120`,
`tests/lightning/lightning-action-madness-only.law.test.ts`). This change makes
the second half law, everywhere Lightning eligibility is decided, in the same
shape as the first.

## What now refuses a game that is not six seats

- **Database** (`20261020005222_lightning_only_on_six_seat_action_and_madness.sql`):
  `fn_lightning_table_size_allowed(handedness)` is true for exactly 6. The
  constraint `cash_games_lightning_six_seat_only` refuses enabling Lightning,
  `pending_on` or `lightning` on any other size, and refuses resizing an active
  Lightning game away from six. Every ordinary state stays legal. The hand
  trigger refuses a Lightning hand (`lightning_hand_table_size_allowed`); the
  operator door answers `LIGHTNING_TABLE_SIZE_NOT_ALLOWED` to `enable_lightning`,
  `resume`, `enable_joins` and `set_flag lightning_v1 true` (durable, replayable);
  readiness adds a blocking `LIGHTNING_TABLE_SIZE_NOT_ALLOWED`; formation returns
  `lightning_table_size_not_allowed` before any epoch, reservation or money
  access; the per-game thresholds answer `lightning_allowed: false` with that
  reason. Five functions patched at unique anchors behind preimage md5 guards.
- **Engine** (`LightningSupervisor`): discovery reads `handedness` beside the
  template; anything but exactly 6 forms nothing and a host already dealing
  drains (never abandons a hand).
- **Client**: `isLightningEligible(template, handedness)`; the Lightning route
  and the lobby offer Join Lightning only at six seats, every other size keeps
  Join Game and its ordinary lobby actions. The club home embed reads the game's
  handedness. The operator console words the new refusal.
- **Pilot tooling**: a Lightning pilot target must be six-seat Action or Madness
  (`assertLightningPilotTarget`); setup, targets, stage and qualification refuse
  any other size, and populated-cluster observation is six-seat only.

Horses and humans are treated identically: nothing in the rule names a kind of
player.

## Qualification

`scripts/dev/test-lightning-six-seat-boundary.sh` (chained from the required
`test-lightning-template-boundary.sh`) builds the installed image, proves it is
byte-for-byte the production catalog, reproduces the defect (a nine-seat Action
game could be enabled, converted, formed and was not refused by the operator
door), installs the migration and proves every refusal by name, the six-seat
positives and the migration's live proofs.

## The written record

`docs/LAWS.md` carries the ruling. In `docs/lightning/` the 9-max requirements
are retired by the ruling, marked superseded with the date and kept as history:
R06, the 9-max halves of R07 and R21 (`REMAINING-WORK.md`), gates L07 and L08
(`release-gates.json`, `FINAL-RELEASE-REVIEW.md`), and every "both table sizes"
coverage line (`ROLLOUT.md`, `HANDOFF-2026-10-15-GO-LIVE.md`).

## The Classic games in the private pilot club

"Lightning Pilot NLH 6" (Classic, 6 seats, 0.01/0.02) and "Lightning Pilot NLH
9" (Classic, 9 seats, 0.02/0.04) can never be Lightning and were holding most of
the pilot's horses away from the two Lightning targets. They are added to
`RETIRED_PILOT_TARGETS` with fresh stable request ids and are switched off only
through the owner's seat-safe `fn_cash_game_switch_off`: no new seating or
opening, nobody stood up, moved or cashed out, tables close as they empty. The
setup workflow gained a `retire` target that runs only the retirements, so it
works while both Lightning targets are enabled. The retired Madness 9-max entry
is unchanged. Public Lightning rollout stays off.
