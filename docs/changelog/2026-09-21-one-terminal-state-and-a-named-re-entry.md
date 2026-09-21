# One terminal state for an F06 operation, and a re-entry that says its name

2026-09-21. Two defects on the engine release path, both found while the
engine had been frozen on `8825af51` for sixty-seven hours. They are in one
branch on purpose: several agents editing this path in parallel has already
produced one conflicted pull request.

---

## 1. Two definitions of "terminal", and one of them could never go quiet

### What was wrong

Two things in the database answered _is this table break finished?_ and they
disagreed:

| reader                                          | its test                                                    |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `public.fn_f06_discover_breaks`                 | `state NOT IN ('acknowledged','withdrawn_before_manifest')` |
| `smarter_private.f06_lease_has_pending_custody` | `state <> 'acknowledged'`                                   |

Measured on production before the fix:

```
acknowledged               423
park_requested             153
withdrawn_before_manifest   31   (30 distinct events)
begun                        8
```

and, over every event carrying an F06 operation or permit:

```
pending, custody helper's definition   501
pending, the protocol's definition     471
pending for no reason but a withdrawal  30
```

Discovery is the protocol - the engine drives the break state machine from it

- and it was also, by then, the only spelling left alive. A query of every
  installed function found **exactly one** object in the whole database still
  saying `state <> 'acknowledged'`: the custody helper, added five days earlier
  in `20260919024039`. Even `f06_one_source`, the partial unique index on
  `source_table_id`, already read
  `state <> ALL (ARRAY['acknowledged','withdrawn_before_manifest'])`.

So 30 events held an engine lease that `reap_dead_engine_leases` could never
release. Waiting could not fix it, and **#5035 deliberately produces more
`withdrawn_before_manifest` rows** - it is what finally gives an abandoned
last-table park a terminal state it previously could not reach at all.

### Does the release path read it?

**No.** This was checked rather than assumed, and it is worth stating plainly
because the premise that sent me looking was that it might.
`f06_lease_has_pending_custody` has exactly two references in the tree:
`public.reap_dead_engine_leases` (called from `GameServer.ts`), and a CI probe
that asserts `service_role` is refused permission to call it. The release
preflight and the cutover gate read `/health`
(`maintenance.*`, `handsInFlightTotal`, `unparkedReasons`),
`engine-release-inflight-hands.py` (#5003's 120 s incomplete-snapshot
predicate, reused, never re-invented) and
`engine-release-database-proof.py` (which pins the F06 mixed-custody
_contract_ - signatures and definition md5s - and never counts operations).
None of them touches the custody helper.

The harm is therefore to lease housekeeping, not to the release: an event
whose only unfinished business is a withdrawal keeps a dead lease for ever,
and a successor generation cannot adopt it. That is the shape of "the engine
restarted but refuses to adopt N tournaments".

### Why `withdrawn_before_manifest` is terminal - from the protocol

Not from anybody's assertion. From this table's own constraints:

```
f06_withdrawal_receipt  (state = 'withdrawn_before_manifest') = (abort_receipt_id IS NOT NULL)
f06_operations_check    (state IN ('close_confirmed','acknowledged')) = (close_receipt IS NOT NULL)
```

The state is unreachable without a durable abort receipt, and it is mutually
exclusive with ever having closed. The withdrawal and its receipt are written
by one statement (`generation-authority.sql` line 195). And no manifest was
written, so no member was enrolled and no attempt was made: all 31 production
rows carry **zero `f06_attempts` and zero `f06_members`**. An `f06_attempts`
row _is_ the player movement - it holds the destination table, the destination
seat and the winning receipt - so zero attempts is the proof that nothing is
half-moved and no seated stack is in transit behind one.

### What shipped

`supabase/migrations/20260921165904_one_terminal_state_for_an_f06_operation.sql`,
applied to production at 17:05 UTC (outside the :50-:03 window;
`fn_ca_break_window_refuses_migrations(now())` was NULL), single
BEGIN/COMMIT, `lock_timeout = '2s'`:

- **`smarter_private.f06_terminal_operation_states()`** - the one definition,
  `ARRAY['acknowledged','withdrawn_before_manifest']`, adopted verbatim from
  discovery. CLAUDE.md 10.8 forbids settling a disagreement by writing a third
  rule; this writes none.
- **`f06_lease_has_pending_custody` rewritten to ask it.** The divergent
  literal is deleted. A state the database cannot classify now counts as
  **open** and keeps the lease (`COALESCE(..., true)`), which is the
  fail-closed direction.
- **A new CHECK, `f06_withdrawal_has_no_manifest`**, so "before manifest" is
  what the row _means_ and not merely what it is called. Validated against
  every existing row.
- **Five assertions that abort the migration if the board moved**: the
  helper's exact preimage md5, owner, `proconfig` and ACL; the reaper's md5
  (untouched here); the five-state CHECK verbatim, so a sixth state has to be
  classified by a human; the withdrawal-receipt CHECK verbatim; and the
  load-bearing one - **zero** withdrawn rows carrying a manifest, a close
  receipt, a missing abort receipt, an attempt or a member.

### Verified from rows, after

```
f06_terminal_operation_states()          {acknowledged,withdrawn_before_manifest}
functions still spelling state<>'acknowledged'   0
three withdrawn-only events, pending?    false, false, false   (was true)
an event with a park_requested op        true                  (unchanged)
```

Nothing was widened: `park_requested`, `begun` and `close_confirmed` still
hold the lease, and the helper's two other tests - a `reserved` hand permit
(685 of them live) and a manager custody transfer with no completion row -
are untouched and still hold it on their own.

Note for honesty: `stale_event_leases` was **0** at the time of the fix, so
this released no lease _today_. It removes a class of lease that could never
be released, which is latent harm, and #5035 was about to make more of it.

### The gap that let it ship, named

`scripts/ci/probes/f06-shared-hand-lane/lease_reaper_qualification.py` drives
a real Postgres through the reaper's state matrix - `park_requested`, `begun`,
`close_confirmed`, `acknowledged`, four permit states and a control - and
**`withdrawn_before_manifest` is not in it**, nor in the fixture's insert
branch. That is exactly why the divergence passed CI. Closing it needs that
probe to reproduce this migration's preimages before applying it (the way it
already reproduces `lease-reaper-preimage.json`), which is its own piece of
work; bolting it on here would risk reddening a green CI job on the release
path for no extra safety. The contract is pinned statically instead, by
`tests/one-terminal-state-for-an-f06-operation.law.test.ts`, and the live
behaviour is verified above.

---

## 2. A re-entry that surfaced as a raw traceback

### What happened

Run 35626149078:

```
FileExistsError: [Errno 17] File exists:
  /var/lib/club-arena/engine-release-requests/35626149078-1.legacy-checkpoint-intent
##[error]could not reattach to the durable Hetzner release transaction (1)
```

The durable systemd transaction made a first checkpoint attempt in the ~16:41
break, wrote its one-shot `O_EXCL` intent, was interrupted (_"transient
release interruption recovered; durable request retained"_), and re-entered
the helper **under the same run id**.

Two things were wrong and only the first is a defect.

**(a) The second invocation happened at all.** `LEGACY_CHECKPOINT_ATTEMPTED`
is process memory. A boot-resumed or re-entered unit is a fresh process, so it
starts back at `0` and the in-memory one-shot forgets. The _durable_ one-shot -
the intent file - was never consulted on entry. Root cause, CLAUDE.md 10.11.

**(b) An expected, nameable condition wore no name.** `O_EXCL` did exactly its
job. What the operator saw was a Python traceback that reads identically to a
full disk, a permission fault or a broken interpreter, and a caller message
that says "could not reattach". CLAUDE.md 10.86 rule 1.

### What shipped

`server/scripts/engine-release-transaction.sh`

- `LEGACY_CHECKPOINT_INTENT_FILE` is read **once at startup** and seeds
  `LEGACY_CHECKPOINT_ATTEMPTED` from the durable record.
- If the checkpoint is required and that seed is set, the run refuses **by
  name, before the wait loop** - before a break is entered, before the engine
  lock, before `prove_rollback_readiness`. It does not `continue`, does not
  `bounded_sleep`, and does not wait for a later window, because a later
  window cannot make an unknown entry knowable.
- A dedicated branch for helper exit `70` at the call site, so the condition
  is named at both levels rather than folded into the generic refusal.

`server/scripts/legacy-engine-checkpoint.sh`

- The `O_EXCL` write is wrapped in `try/except FileExistsError` and exits
  **70** with its own sentence. The guard itself is **unchanged**: same flags,
  no `O_TRUNC`, no `exist_ok`, no unlink. 70 ends the release exactly as 1 did.

### What is deliberately not done

The intent is **not retired** by this path. Nothing durable records whether an
interrupted entry completed, "I could not tell" is a refusal, and re-entering
a one-shot over a live predecessor holding seated stacks is the failure mode
the `O_EXCL` exists to prevent. The run ends and the next dispatch gets a new
run key. This is not a retry, a sweep or a repair job (CLAUDE.md 10.12).

`70` is deliberately outside the workflow's `uncertain_status` set
(`255`, `124`, `76`, `75`, `>= 128`), so it is never replayed.

### How it composes with the open work

- **#5036** retires the intent only when the guard came _back_ and proved in
  its own fields (`stage: preflight`, `attemptedTables: 0`,
  `completedCalls: 0`, `checkpointOutcome: not_started`) that it touched
  nothing. After that the file is absent, the seed above reads `0`, and a
  later break may enter. The two fixes are complementary: #5036 handles _the
  guard answered and did nothing_, this handles _the transaction never got an
  answer_.
- **#5035** is untouched by both.

### Laws

- `tests/a-re-entered-release-refuses-by-name.law.test.ts` - including a
  behavioural case that drives the real intent-write block twice in a
  temporary directory and reads the answers: `0` then `70`, `ALREADY ENTERED`
  on stderr, no `Traceback`, and the first attempt's record preserved byte for
  byte.
- `tests/one-terminal-state-for-an-f06-operation.law.test.ts`.
