# A jackpot is a chip movement, and the platform freezes

2026-09-11. Branch `fix/bbj-the-rules-page-and-the-engine-agree`. Phase 1 of 5
of the post-audit programme.

Dan, section 13: _"THE ENTIRE PLATFORM NEEDS TO FREEZE FOR THE 5 MINUTES, NO BUY
INS, NO CHIP MOVEMENTS ... EVERYTHING JUST FREEZES, THEN PICKS BACK UP EXACTLY
AS IT WAS."_ Rule 5 of that section: **a sweep checks `isMaintenanceFrozen()`
before moving money or seats.**

Crediting a seat with a jackpot share is moving money. `processBBJPayout` never
asked.

## Why the database was never going to catch it

`zz_freeze_guard` sits on `table_seats` and `club_members` — the two tables the
payout credits — and looks exactly like the backstop. Read the guard:

```
v_claims := current_setting('request.jwt.claims', TRUE);
IF v_claims IS NOT NULL AND v_claims <> ''
   AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
  RETURN COALESCE(NEW, OLD);      -- exempt
END IF;
```

The engine holds `SUPABASE_SERVICE_ROLE_KEY`. **The freeze is enforced against
browsers and not against the engine.** On this path the engine was the only
thing that could honour the break, and it was the one thing not looking.

This file's sibling law already recorded the other half of the same shape:
`bbj_pools` sits _outside_ the guard entirely, which is how 104 BBJ bank moves
kept their write and lost their journal leg at `:55` and `:00`.

And `processBBJPayout`'s own header has named _"the :55 maintenance freeze
refusing the write"_ as one of the causes the durable queue exists to survive,
since the day the queue was built. It could never refuse us, so that survival
path was never reached — the payout simply went through.

## What the data said, including where I was wrong first

My first measurement asked how many payouts landed in `:50–:03`. That is the
**migration** refusal window, which is deliberately wider than the freeze, and
it gave five payouts and a scare. The freeze itself runs from the `:53`
announcement to the `:00` resume (`freezeState.ts`).

Measured on the correct window: **zero of the 27 payouts since the freeze
shipped on 2026-09-01 landed inside it.** Those five were at `:50`, `:51`,
`:52` and `:01` — all outside.

So nothing has been paid through a freeze yet. That is the break working —
tables are told to finish at `:53` and parked at `:55` — and it is not a
guarantee. A long hand, `drainHands()` parking mid-flight at the `:57` restart,
or a re-drive landing in the window would each put a credit inside the freeze,
and the platform would have had nothing to stop it.

## The fix

**The payout defers instead of paying.** Before the attempt loop,
`processBBJPayout` checks the freeze and returns `queued` — no RPC call at all,
for the main jackpot and the mini alike.

Three properties make that safe rather than a new way to lose a jackpot:

- **The write-ahead claim is still written.** It is a _record_, not a chip
  movement, so it is not what the freeze forbids. It survives the `:57` engine
  restart.
- **The reconciler pays it at the thaw**, against an RPC that is idempotent on
  `(pool, table, hand)`. A jackpot deferred by a break is paid in full a few
  minutes later. _"Picks back up exactly as it was."_
- **It is not a failure.** Falling into the attempt loop would burn four
  attempts against a guard doing its job and end in a **critical** financial
  alert — every hour, for a break we scheduled. That is the alarm-that-is-always-on
  shape CLAUDE.md 10.84 warns about, and it is exactly how an alert gets muted.
  No attempts, no alert.

**The reconciler also checks, at the money move.** `GameServer` already returned
early from the whole reconcile cycle while frozen, so this is defence in depth
rather than the only gate — but the check now sits where the money moves, so a
second caller of `reconcilePendingFees` cannot miss it. A frozen row is left
completely untouched rather than attempted and failed: bumping its attempt
counter would read in the log as a payout that failed.

**And the deferral is countable.** `reconcilePendingFees` returns
`deferredFrozen` alongside `resolved` / `stillFailing` / `exhausted`, and
`GameServer` prints it. A row that is neither resolved nor still failing, and
that leaves no trace in the summary, is a signal answering when it deliberately
did not look (CLAUDE.md 10.86).

## Pinned

`tests/the-journal-is-never-refused-by-the-freeze.law.test.ts`, **LAW 3** — the
live path checks the freeze, the gate sits _before_ the attempt loop so no RPC
is made, the claim is still written, `raiseFinancialAlert` is absent from that
branch, and the reconciler leaves a frozen row untouched and counts it.

Behaviour, not just source:

- `server/src/services/supabase/BBJPayoutIsPaidOrQueued.test.ts` — six new
  pins: no RPC while frozen, no critical alert, the claim still written, the
  reason says why, the mini defers on the same gate, and a **control** proving
  that with the platform running nothing about the payout changed.
- `server/src/services/FeeReconcilerRedrivesJackpots.test.ts` — a frozen cycle
  skips the row, counts `deferredFrozen`, and calls `processBBJPayout` zero
  times.

LAW 3 reads both files with comments stripped: they explain in prose what the
freeze guard does _not_ do, and asserting on raw text would make the
explanation itself illegal.
