# Bomb Pot Audit + Standardization — 2026-08-27

Audited the entire bomb pot feature against Dan's **Bomb Pot Rules +
Architecture Specification** (the 22-section platform contract), then closed
the gaps in the same session. This file is the audit record; the work shipped
in PR `agent/cowork-bombpot/feat/bomb-pot-standardization`.

## Compliance table (spec section → verdict)

| Spec             | Requirement                                                      | Before                                                                 | After                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 BP-001        | Server authority for trigger/ante/deal/settle                    | PASS (engine on Hetzner since 2026-08-20)                              | PASS                                                                                                                                                                                                                        |
| §1 BP-003/BP-004 | Settlement computed before animation, atomic                     | PASS (WINNERS computed at showdown, AWARD sequence is presentation)    | PASS                                                                                                                                                                                                                        |
| §1 BP-005        | Config snapshot per hand                                         | PASS (HandConfig.bombPot frozen at hand creation)                      | PASS + persisted (`hand_history.bomb_pot`)                                                                                                                                                                                  |
| §1 BP-006        | One deck, no card reuse                                          | PASS (single Deck; pinned by tests)                                    | PASS (15-card uniqueness pinned for 3 boards)                                                                                                                                                                               |
| §1 BP-007        | Deterministic remainders                                         | PASS for 2 boards (odd cent → Board 1)                                 | PASS for 2 and 3 boards (ascending board order)                                                                                                                                                                             |
| §2.1             | Trigger modes                                                    | FAIL — only every-N-hands                                              | PASS — every_n_hands, once_per_orbit, timed, bomb_pot_only (`BombPotScheduler`)                                                                                                                                             |
| §3               | Single canonical config                                          | PARTIAL — four scattered legacy columns                                | PASS — five canonical columns, legacy kept in lockstep                                                                                                                                                                      |
| §3               | anteMode FIXED                                                   | FAIL — BB multiple only                                                | PASS — `bomb_pot_ante_fixed` overrides the multiple                                                                                                                                                                         |
| §3.1             | Minimum players (default 3)                                      | FAIL — none                                                            | PASS — due bombs stay pending below `bomb_pot_min_players`                                                                                                                                                                  |
| §4.1             | Pending token, no catch-up spam                                  | FAIL — n/a                                                             | PASS — one token, consumed at next valid hand (tests T03/T04)                                                                                                                                                               |
| §4.2             | Once per orbit, join/leave-safe                                  | FAIL — n/a                                                             | PASS — button-crossing anchor tracker (tests T01/T02)                                                                                                                                                                       |
| §5.1/§5.2        | Participant lock, equal ante, short-stack all-in                 | PASS                                                                   | PASS                                                                                                                                                                                                                        |
| §5.2 BP-ANTE-04  | Blinds suppressed                                                | PASS                                                                   | PASS                                                                                                                                                                                                                        |
| §5.3             | First action left of button on flop                              | PASS (normal postflop order)                                           | PASS                                                                                                                                                                                                                        |
| §6               | Intro sequence, fallback, server-timed action                    | PASS (BombPotOverlay, art fallback, engine never waits)                | PASS + board-count badge (TRIPLE BOARD)                                                                                                                                                                                     |
| §7               | Lockstep multi-board dealing, one shared betting round           | PASS (2 boards)                                                        | PASS (3 boards, all three dealing paths)                                                                                                                                                                                    |
| §8               | Double board pot partition per pot layer                         | PASS (integer cents, remainder → Board 1)                              | PASS (unchanged, now the N=2 case of the general split)                                                                                                                                                                     |
| §9               | Triple board                                                     | FAIL — unsupported                                                     | PASS — full engine + client support                                                                                                                                                                                         |
| §10              | Per-variant evaluation (NLH/PLO/hi-lo)                           | PASS (evaluator per variant; per-board hi/lo in determineWinners)      | PASS + board-3 muck eligibility for hi and lo                                                                                                                                                                               |
| §10.1            | Variant override                                                 | DEFERRED at first ship                                                 | PASS — shipped 2026-08-28: bomb_pot_variant column, one activeHandVariant() seam (snapshot betting structure, pot-limit clamps, horse equity, hand history), deck-feasibility yield, host control, lobby + intro disclosure |
| §11              | Side pots split per board, eligibility enforced                  | PASS (per-pot split before evaluation)                                 | PASS (N boards)                                                                                                                                                                                                             |
| §11.2            | Board-major award order                                          | PASS (SHOWDOWN POLISH 2026-08-25)                                      | PASS (boards 1→2→3)                                                                                                                                                                                                         |
| §11.3            | Same rake engine                                                 | PASS                                                                   | PASS                                                                                                                                                                                                                        |
| §12/§13          | Winner highlight, chop portions, odd chips clockwise from button | PASS                                                                   | PASS + board-3 highlights                                                                                                                                                                                                   |
| §14              | All-in runout fills all boards; RIT/insurance suppressed         | PASS                                                                   | PASS (suppression keys off isDoubleBoardActive ⇒ any multi-board)                                                                                                                                                           |
| §15.1            | Lobby discloses frequency/boards/mode                            | PARTIAL — "1 IN N" only                                                | PASS — per-mode medallions incl. BOMB POT ONLY identity                                                                                                                                                                     |
| §15.2            | Table header countdown                                           | PASS (every-N pill)                                                    | PASS + bomb-only identity pill; `bomb_pot_next_at` published for timed                                                                                                                                                      |
| §15.3            | Host controls with guardrails                                    | PARTIAL                                                                | PASS — schedule/boards/min-players controls; mid-hand changes still apply at next hand via throttled re-read                                                                                                                |
| §16/§17          | State machine, events                                            | PASS (existing engine events)                                          | PASS + cards3/board3/hand3/boardCount/triggerReason                                                                                                                                                                         |
| §19              | Fold-out skips board evaluation; deck-infeasible downgrade       | PASS                                                                   | PASS (3→2→1 stepwise)                                                                                                                                                                                                       |
| §20              | Hand history reconstructs trigger, config, every board           | PARTIAL — board 2 only, no bomb metadata, antes missing from `actions` | PASS — community_cards3, bomb_pot jsonb, bomb_ante FORCED_BETS_POSTED rows                                                                                                                                                  |
| §21              | QA matrix                                                        | PARTIAL (double-board tests)                                           | PASS for shipped scope — 30 server tests incl. T01-T04 analogues                                                                                                                                                            |
| §22              | Recommended defaults                                             | PARTIAL                                                                | PASS — defaults follow the spec (min players 3, remainder Board 1, RIT off, server commit first)                                                                                                                            |

## Deliberately deferred (with reasons)

- **Variant override** (§10.1): the engine's HandConfig already carries a
  per-hand `gameVariant`, so nothing in the data model precludes it; what is
  missing is a host control and client hole-card-count handling mid-session.
- **Separate bomb button** (§5.3): USE_REGULAR_BUTTON is the spec's own
  recommendation for ordinary cash tables; nothing else exists today.
- **MANUAL_NEXT_HAND admin trigger** (§2.1): needs role-gating + audit
  plumbing; scheduler accepts a new mode string when that lands.
- **Per-award-unit settlement ledger table** (§16.2 AwardUnit): the engine
  computes exact per-pot/per-board awards (perPotAwards) and persists winners,
  pots and boards; a dedicated ledger table with idempotency keys is a larger
  platform change tracked for the settlement-hardening phase.
- **Scheduler persistence**: trigger state is in-memory per engine, same
  trade-off the 2026-08-20 counter made — a deploy delays the next bomb by at
  most one cycle. Persisting it means a DB write per hand for every bomb table.

## Bugs found and fixed during the audit

1. Bomb antes were absent from the persisted `actions` log — postBombPotAntes
   never ran the #1477 forced-money recorder. Every reader reconstructing a
   bomb hand's pot from `actions` was short the entire starting pot.
2. `bomb_pot_in` snapshot arithmetic was computed from a counter the trigger
   block ALSO mutated — now both read the one scheduler.

## Production verification

- Migration `bomb_pot_standardization` applied via Supabase MCP; verified:
  5 new `tables` columns, 2 new `hand_history` columns, the single
  `bomb_pot_double_board=true` row backfilled to `board_count=2`.
- Server: 30/30 vitest green (BombPotScheduler 16, tripleboard 9,
  doubleboard 5). Client: 183/183 green in touched areas. `tsc --noEmit`
  clean, both tsconfigs.

## Round 4 — BOMB POT MAX (2026-08-28)

Every remaining audit item shipped in one pass (branch
`agent/cowork-bombpot/feat/bomb-pot-max`): full scheduler persistence
(`bomb_pot_sched_state`), MANUAL_NEXT_HAND with `fn_request_manual_bomb_pot`

- audit table, SEPARATE*BOMB_BUTTON with regular-rotation rewind, the timed
  announce window, host presets, the `bomb_pot_award_units` idempotent ledger,
  horse multi-board equity averaging, multi-board all-in equity display
  (per-board average, unsuppressed), scoop/sweep felt labels, replay bomb
  facts, the three `v_bomb_pot*\*` analytics views, lobby ante disclosure + the
  Multi-Board Bomb filter chip, and the 375px 3-board CSS review. The former
  DEFERRED rows (§2.1 manual, §5.3 separate button, §16.2 ledger) are all PASS
  as of this round. On-device mobile verification remains the one recommended
  manual step.
