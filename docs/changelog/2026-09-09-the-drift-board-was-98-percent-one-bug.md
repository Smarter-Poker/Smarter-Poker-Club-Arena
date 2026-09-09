# The drift board was 98% one bug (2026-09-09)

The Drift Incidents board showed **500 open criticals**. The table held
**3,402**. Dan asked for all of them resolved and each one root-caused.

They were not 3,402 findings. **3,330 of them (98%) were three conditions,
re-filed once per hand**, and the real findings were buried underneath.

| source                                                  | open incidents |       actual distinct causes |
| ------------------------------------------------------- | -------------: | ---------------------------: |
| `postHandTasks.hand_history_failed`                     |          1,154 | (re-report of the row below) |
| `ServerTableEngine.authoritative_hand_semantic_refusal` |          1,118 |                            9 |
| `ServerTableEngine.post_commit_obligations_pending`     |          1,058 |                            1 |

Open incidents after this work: **75**, and those are being worked
individually.

## The amplifier

`fn_ca_financial_alert_to_incident` built its dedupe key as

```
'fa:' || source || ':' || md5(left(message, 200))
```

directly beneath a comment promising _"One root cause = one incident = one
push"_. The promise fails for any alert whose message names the occurrence,
and all three of these do — `Hand <table-uuid>#8510686 committed, but ...`.

The proof is arithmetic, not inference: for those three sources the count of
**distinct message hashes equalled the row count exactly** (1154/1154,
1118/1118, 1058/1058). The control case is in the same table —
`Satellite.stuck_completing_unawarded`, whose message names nothing
per-occurrence, folded **534 alerts into ONE incident** with
`occurrences = 534`, which is the behaviour the comment describes.

**Fixed** in `one_cause_is_one_incident_not_one_per_hand`: the key now hashes
a _normalised_ message (uuids, hand numbers, amounts and timestamps replaced
by placeholders) joined with the normalised `context->>'error'`. The error is
in the key deliberately — a refusal message often names the hand but not the
reason, and "stale lease" and "vacated seat" are different bugs that deserve
different rows. Measured against the same 1,138 alerts: **1,138 keys before,
9 after.**

**Hardened** in `no_detector_may_flood_the_board`: past 25 open incidents for
one source, further findings are counted on a single labelled storm incident
rather than filing row 26. Nothing is discarded — every occurrence stays in
`financial_alerts` and in the storm incident's event log. The widest
legitimate fan-out ever seen here is 8 open rows, so the cap cannot bite a
real case.

## The three conditions

**1. `post_commit_obligations_pending` — a critical alarm for a transient
that has never once failed to clear.** It was raised on `attempt === 1` of a
bounded retry loop. All **1,058** alerted hands have `post_commit_completed_at`
set: 0 still pending, 0 chips stranded (alerted `hand_id`s joined against
`hand_atomic_commits`). The alert now fires only in the `!obligationsApplied`
give-up branch — the condition its own message always described — and names
the attempt count.

**2. `[object Object]` — the diagnosis was destroyed at the source.**
`handProjection.ts` rethrew the Supabase `PostgrestError`, which is a plain
object and not an `Error`, and the alert path serialised it with
`String(err)`. Every one of those 1,058 alerts carried the four words
`[object Object]`, which is why the board classified them all `unknown`.
Added `describeError()` (the precedence `reportError` already applied
internally), wrapped every raw rethrow in `handProjection.ts`, and switched
the settlement's three alert paths to it.

**3. A dealt hand thrown away by the table balancer.** The remaining live
cause of the semantic refusals. `executePlayerMoves` vacates the source seat
with

```ts
.update({ left_at: new Date().toISOString() })
```

and had no hand-in-flight check of its own. Both callers probe
`waitForHandComplete` — but **once per batch**, and the loop then spends
several awaited round trips per move (`mayTakeSeat`, the source-stack read,
the seat writes). By move N the boundary checked before move 1 is gone. The
intent has been written down since 2026-07-24 ("never move players mid-hand");
only the timing was wrong.

Measured 2026-09-08/09: **32 fully dealt tournament hands discarded**, with
leave/join pairs **0.17–0.37s apart** — inside the hand.
`fn_ca_settle_hand_stacks_absolute` finds the seat gone at commit time, raises
`seat missing or left for <uuid> - hand write rejected whole`, and that aborts
the entire atomic commit and kills the engine generation. **Every player at
the table loses the hand they just played**, not only the mover.

No money was lost — the refusal rolls back whole, and the next successful hand
resumes from the last committed stacks. What was lost is poker.

Fixed by re-probing `waitForHandComplete(move.fromTableId)` immediately before
the only destructive write. Nothing is stamped before that point, so a refusal
leaves the player exactly where they were — the same shape as the two guards
already above it in that loop.

## The findings that were buried

Cleared away, these were finally visible. The largest, **`club_treasury`
drift of 9,981,736.92 chips**, is not a loss: the reconciler compared the
stored treasury against a ledger sum that assumed an opening balance of **0**,
while `ca_treasury_baseline` holds **9,981,739.70** for that club (taken
2026-08-31 19:02, after the 10:45 cutover the other four baselines share). It
has since read the baseline correctly — the 09-08 and 09-09 runs both report
`ledger_balance = stored_balance` exactly, severity `ok`. The incident stayed
open only because **nothing closes an incident when its check goes green**,
which is why the board's "Avg Resolution Age" reads `--`.

## Cascade performance

Resolving the backlog timed out twice. Resolution propagates in _both_
directions (`alert -> incident` and `incident -> alert`) and **neither side was
indexed**, so one alert resolution seq-scanned 5,709 incidents and the
resulting closure seq-scanned 18,226 alerts. The first index attempt did not
help either, because it indexed the expression as `text` while the trigger
compares `(...)::uuid` — an index is only an index if its expression is the one
the query actually writes. Both legs are now indexed on the cast, under the
same partial predicate the triggers apply. This is not cleanup scaffolding:
those triggers run on every alert that is ever resolved.

## Still open, deliberately

- **`lease_proof_expired`** (146 hands/12h, none since 03:12) — bursts are
  one minute wide and overwhelmingly cash tables, consistent with a heartbeat
  RPC whose round trip passed the pre-anchored 20s proof deadline, losing the
  whole batch at once. A slow-but-successful renewal and a genuine loss are
  currently _indistinguishable_ in production, so the next step is to count
  the `kept`-but-late case separately, not to guess at a fix.
- **A latent trap in `reconcile_ledger_nightly`**: the flow cutover is a
  global `MIN(taken_at)` over `ca_treasury_baseline`, but each baseline row
  has its own `taken_at`. Club `2a1132b9`'s was taken 8h17m after the global
  cutover and club `002c2d27`'s eight days after, so any ledger flow in that
  gap is double-counted. It nets to zero today only because no flow existed in
  those windows.
