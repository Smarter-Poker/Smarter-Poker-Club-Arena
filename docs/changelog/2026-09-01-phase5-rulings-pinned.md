# Phase 5 of 7 - Dan's four rulings, pinned

2026-09-01. Branch `phase5/rulings-pinned`.

Four decisions were put to Dan at the close of Phase 5. **Every one of them
describes what the engine already does.** Three because the behaviour was built
correctly; the fourth because he had already ruled on it on 2026-08-26 and the
gate went in the same day. No behaviour changed here.

That is precisely when a rule is most fragile: it holds by accident of the
current code rather than by anything that would notice it changing.
`server/src/tournament/headsUpIntegrityRulings.law.test.ts` is what notices.

---

## Ruling 1 - duel limits stay signal-only

> "Keep detection in signal-only mode for now. Do not auto-block or cap
> legitimate play from a seven-day sample where no pair exceeded five
> meetings... High-confidence signals may go to manual review, but must not
> automatically punish players."

`fn_ca_duel_pairing_scan` (shipped earlier today) already only inserts a signal
row and raises an incident. The pin proves it stays that way: every write in
the migration must target `ca_collusion_signals` or `ca_guard_inventory`, and
it may never UPDATE or DELETE `tournament_players`, `table_seats`,
`club_members`, `profiles` or `blacklists`. The approved calibration - 8
meetings, 0.8 win share - is pinned as a literal.

**30-day review scheduled.** At the end of it Dan gets the distribution, the
flagged-pair details, a false-positive analysis and a recommended enforcement
threshold.

## Ruling 2 - an all-in hand survives a disconnect

> "Once a player is all-in and no further action is possible, disconnecting
> must not fold or otherwise disadvantage that hand. The board and settlement
> should complete normally."

Already true, by two independent guards, and both are pinned:

- `handlePlayerDisconnectedMidTurn` returns immediately on
  `player.is_folded || player.is_all_in || player.is_sitting_out`;
- an all-in seat is never handed a turn in the first place, so there is no
  countdown for a disconnect to expire against.

## Ruling 3 - no permanent pause at two players

> "Do not pause the tournament indefinitely. Preserve the existing disconnect
> grace/countdown, then blind or time the player out under the normal rules.
> No special permanent pause at two players."

The pin is the ABSENCE of a two-player special case: neither `DisconnectEngine`
nor `ServerTableEngineTurns` may contain a heads-up branch or a tournament
pause, with comments stripped before the check so prose about heads-up does not
satisfy it. The normal mechanism is pinned as it stands: 30-second disconnect
timeout, 5-second reconnect grace, 3 consecutive timeouts to a sit-out.

## Ruling 4 - no insurance or run-it-twice in heads-up tournaments

> "Disable both in heads-up tournaments for now. Tournament outcomes should use
> one board and the standard prize structure."

Already true, and **wider than the ruling** - which is recorded rather than
narrowed, per "do not broaden... without checking with me". Dan, 2026-08-26,
quoted in the engine itself:

> "run it twice or 3 times is a cash game only area. it should never be in MTT,
> SPINS OR HEADS UP."

`applyRunItTwiceConfig` computes `ritIsTournament` from `tournament_id` or
`game_type === 'tournament'` and refuses BOTH features on any tournament table.
Live check on 2026-09-01: of **2,127 duel tables and 5,527 spin tables** created
in the last two days, **zero** had run-it-twice or insurance enabled.

If Dan later wants the gate narrowed to heads-up only, that is a deliberate
change to a standing ruling and this pin is where it gets discussed.

---

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- `npx vitest run src/tournament`: 55 files, 659 tests, green.
- The three server-side law tests written today are now rows in `docs/LAWS.md`
  (CLAUDE.md 10.8 rule 1). The registry test only scans `tests/`, so these were
  not required; they are listed because the next agent should be able to find
  them.
