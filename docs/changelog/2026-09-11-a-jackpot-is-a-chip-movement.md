# A jackpot is a chip movement, and the platform freezes

2026-09-11. Branch `fix/bbj-a-jackpot-is-a-chip-movement`. Phase 1 of 5 of the
post-audit programme.

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
live path checks the freeze; the write-ahead claim comes first, then the gate,
then the attempt loop (both orderings, see review finding 5); the claim carries
the deferral's own reason; the not-recorded alarm exists and is reachable only
through `if (!deferralRecorded)`; and the reconciler defers **every** kind of
row as the first statement in its loop.

Behaviour, not just source:

- `server/src/services/supabase/BBJPayoutIsPaidOrQueued.test.ts` — seven new
  pins: no RPC while frozen, no critical alert on an ordinary break, the claim
  written with the deferral's reason, a deferral whose durable write did **not**
  land is loud, the reason says why, the mini defers on the same gate, and a
  **control** proving that with the platform running nothing about the payout
  changed.
- `server/src/services/FeeReconcilerRedrivesJackpots.test.ts` — a frozen cycle
  skips the row, counts `deferredFrozen`, and calls `processBBJPayout` zero
  times.

LAW 3 reads both files with comments stripped: they explain in prose what the
freeze guard does _not_ do, and asserting on raw text would make the
explanation itself illegal.

---

## What the adversarial review of this change found, and what changed because of it

The first cut of this fix was reviewed with the instruction to break it. It
found seven things. All seven are addressed here, and three of them mattered.

**1. The deferral threw away the claim's answer (defect).** `queueSafely`
returns whether the durable write confirmed, and the frozen branch ignored it —
making it the only `queued` return in the module that could leave _nothing_
behind. The failure it missed is not exotic: Postgres unreachable while the
flag is set, which is the outage shape this queue exists for. The table would
be told "your jackpot is coming" by the pending event, and no row, no alert and
no parameter set would exist anywhere. It now reads the answer, and a deferral
that could **not** be recorded raises a critical
`processBBJPayout.frozen_without_a_claim` carrying every parameter needed to
re-drive by hand — the same payload the exhausted path raises. That alarm
cannot fire on an ordinary break; it is reachable only through
`if (!deferralRecorded)`.

Two details fell out of fixing it. The claim is now made with the _deferral's_
reason even when the write-ahead already confirmed, because
`queueUnpaidBBJPayout` refreshes `last_error` on its own open row — so an
operator reading the queue during a break sees "deferred for the break" rather
than a stale "not yet attempted" that makes a waiting jackpot look stuck. And
the test mocks now resolve `true`, which is what the real queue returns and
what `queueSafely` compares against; resolving `undefined` made them pass for
the wrong reason.

**2. The reconciler gate covered one kind of money out of three (gap).** It was
written as `row.kind === 'bbj_payout' && isMaintenanceFrozen()`. The `rake`
branch still called `atomic_distribute_rake` and the fall-through still called
`logBBJCollection`, both through the freeze. That made the check's own
justification false: it exists so a caller which forgets to gate the cycle
cannot slip money past it, and two thirds of the money was still slipping. The
check is now the first statement in the row loop and defers **every** kind — so
a deferred row costs no reads either, which also retires the wasted
`hand_history` lookup the review flagged separately.

**3. A test that could not fail (nit, but the worst kind).** "Still writes the
durable claim" asserted only `expect(claim).toHaveBeenCalled()`, and the
write-ahead calls `claim` unconditionally before any gate — so it passed with
this entire feature deleted. It now asserts the claim carried the deferral's
own reason, which only the frozen branch writes.

**4. Test isolation that worked by luck (gap).** The freeze reset lived in the
new `describe` alone. That was safe only because the block happens to be last
in the file and its last test happens to set `false`; one test added after it
and every earlier test in the file would have run against a frozen platform and
still passed. The reset moved to the file-wide `beforeEach`, with an `afterEach`
beside it.

**5. The law pinned the ordering that stops the RPC, not the one that stops the
loss (nit).** It asserted `gate < loop` and never `claim < gate` — and the
block-slice assertion would still have passed with the write-ahead deleted
entirely. Both orderings are pinned now, and so is the not-recorded alarm.

### Confirmed clean by the same review, and worth recording

- **No stack bump for an unpaid jackpot.** Every seat mutation on both the main
  and mini paths is inside `if (outcome.status === 'paid')`. A deferral
  increments only the queued counter and emits `bbj_payout_pending`.
- **No spurious near-miss row.** The mini's near-miss is guarded on
  `status === 'skipped'`; `queued` is not `skipped`.
- **`bbjPayoutQueue` cannot be null in production** — `setBBJPayoutQueue` is
  called at module scope in `FeeReconciler`, which `GameServer` imports
  statically, and every entrypoint reaches the engine through `GameServer`.
- **No circular import.** `freezeState.ts` has zero imports.
- **`deferredFrozen` is on all three return paths** and no caller destructures
  the summary.

### Understood and deliberately not changed

The `bbj_payout_pending` beat carries `replay_until: now + 60_000`, and the
freeze runs several minutes — so the pending overlay expires before the
reconciler's `bbj_payout_paid` arrives, and the engine restart at `:57` drops
the hub's retention anyway. Widening it is not the fix: `HUB_MAX_EVENT_REPLAY_MS`
caps every emitter at 60 s on purpose, and raising a shared bound for one case
is how a bounded, self-expiring buffer stops being either. The pending beat is
a transient courtesy, not a receipt. The receipt is the per-recipient
`notifications` row `processBBJPayout` writes when the payout lands from the
queue — which reaches players who have closed the tab, which no overlay can.
