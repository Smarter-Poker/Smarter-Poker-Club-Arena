# No band-aids. The fix goes at the source

**2026-09-07** — branch `fix/no-band-aids-the-fix-is-at-the-source`

Dan, verbatim:

> "I DO NOT WANT CRONS AND 'BACK PAY JOBS'! I DO NOT WANT SYSTEMS IN PLACE THAT
> 'MONITOR FOR ERRORS'! I WANT THE ERRORS FIXED AND PLUGGED AND HARD CODED
> SOLUTIONS TO THE ISSUES! ... I WANT HARD CODED FIXES AT THE ROOT SOURCE WHEN
> AN ISSUE IS DISCOVERED! NOT A FUCKING BAND AID!"

10.11 already said a detector is not a fix, in writing, on 2026-09-06. This is
what the platform looked like the day after.

## What the deep dive found

**Money paid by repair machinery instead of by the engine, last 7 days:**

| `source`              |    rows |         chips | events | median lateness    |
| --------------------- | ------: | ------------: | -----: | ------------------ |
| `reconcile`           |     342 |     32,849.99 |    191 | **6.3 hours**      |
| `overlay_backpay`     |     173 |     14,596.70 |     40 | **8.4 days**       |
| `unclassified`        |      32 |        161.30 |     15 | **105 days**       |
| `late_reg_adjustment` |      10 |        532.55 |      6 | 0 min              |
| `spin_backpay`        |       1 |          6.40 |      1 | 25 min             |
| **total**             | **558** | **48,146.94** |        | worst: **84 days** |

74,544 tournaments completed; **108 needed the reconciler** — 1 in 690. Of
those, **69 events** had the engine pay some places and stop, and **39 events**
had it pay nothing at all.

**Two hypotheses tested and rejected**, so nobody re-tests them: the `:55`
maintenance freeze (3.7% of reconciled events vs a 3.2% baseline — no signal),
and the escrow refusing (4 of 191).

**The surface:** 127 active cron jobs, 29 of them repair-shaped. **50
band-aid-shaped functions live in `public`**, 15 of them `backpay`/`backfill`.

**And the three Dan named himself.** He said "LIKE THE BOMB POTS NOT PAYING
OUT". Bomb pots carry three separate plasters:

```
fn_backfill_bomb_pot_award_units
fn_backfill_bomb_multi_winner_units
fn_ca_bomb_pot_catchup
```

## What shipped

**CLAUDE.md 10.12 — no band-aids.** You may not create a scheduled job, a
sweep, a compensating write or a reconciler as the answer to a defect, for
money or for anything else. You find the line that produced the wrong outcome
and you change that line. Two carve-outs, both narrow: a job whose schedule IS
the product (tournament starts, blind levels, retention pruning), and keeping an
existing net alive until its root fix lands — because ripping them out today
would strand real players' money.

**`docs/BAND-AIDS-REGISTER.md`** — every band-aid, measured, with the root cause
where it is known, the hard fix, and the condition under which the job is
deleted. Tier 1 is the money, Tier 2 the state repairs, Tier 3 the monitors that
must never be mistaken for fixes. Work order at the bottom.

**`scripts/ci/check-no-new-band-aids.mjs`** — the reader. Any migration that
declares a repair / back-pay / re-drive / catch-up / backfill / heal / shortfall
path, or schedules a cron that runs one, is refused, on the pull request and at
`pre-push`. A migration that DROPs one or `cron.unschedule`s one passes — that
is the rule being obeyed. Three outcomes: `0` clean, `1` band-aid, `2` COULD NOT
TELL.

**`scripts/ci/band-aid.allowlist.json`** — the existing debt, 36 entries, every
one pointing at its register row. `tests/no-band-aids.law.test.ts` (12 cases)
asserts the guard recognises every shape the platform actually grew, ignores
ordinary names, never reads the words out of a comment, and that the allowlist
stays in step with the register. **It is a list that may only ever get shorter.**

## One root cause named in the process, and it is Dan's to decide

Both _Sunday $200 Deep Stack_ events pay their pool out in full **and still owe
the winner 180.00** — because bubble protection pays the bubble one buy-in out
of a pool the structure has already allocated to 100%. The shortfall always
lands on the last place paid, which is always first place. Two winners, 180.00
each, one weekend.

No job can fix that. It is a pricing decision: either the house funds bubble
protection, or the structure is computed on `pool − bubble_protection`. Both are
one line at the source. Register item #11.

## Files

- `CLAUDE.md` — section 10.12
- `docs/BAND-AIDS-REGISTER.md` (new)
- `scripts/ci/check-no-new-band-aids.mjs` (new)
- `scripts/ci/band-aid.allowlist.json` (new)
- `tests/no-band-aids.law.test.ts` (new, 12 cases) + `docs/laws.d/no-band-aids.md`
- `.github/workflows/ci.yml`, `.husky/pre-push` — the gate
