# The Worst Lease Event Was The One Nothing Counted

**2026-09-12** · `tableLease`, `tournamentLease`, `poker_lease_heartbeat_outcomes_total`

## The Silence

`poker_lease_heartbeat_outcomes_total` has carried a `malformed` state since the
counter shipped. `engineInstruments` declares it, zero-seeds it, and documents
it as "the response could not be read as an answer."

Production read exactly **0**, for both scopes, forever.

Not because it never happened. Because both whole-answer refusals return above
the per-row loop that is the counter's only writer:

```ts
if (malformed || rowsById.size !== claims.length) {
  heartbeatErrors++;
  warnThrottled('malformed_response', '...');
  return { status: 'answered', proofs: [], lostTableIds: [...tableIds] };
}
for (const claim of claims) {                  // the only inc() in the file
  leaseHeartbeatOutcomesTotal.inc(1, { scope, state: row.state });
```

That return is the most destructive answer either module can give. It declares
**every** lease in the scope lost in a single pass, and the whole fleet is
fenced, torn down and rebuilt. It was also the only answer that left no trace in
the instruments.

## Why The Silence Mattered More Than The Count

`LeaseHeartbeatsNotBeingKept` is critical severity and pages by SMS. It is a
ratio:

```promql
sum by (scope) (rate(poker_lease_heartbeat_outcomes_total{state!="kept"}[10m]))
  /
clamp_min(sum by (scope) (rate(poker_lease_heartbeat_outcomes_total[10m])), 0.001)
  > 0.05
```

A refusal that increments neither the numerator nor the denominator moves that
expression by exactly nothing.

So the single worst lease event possible was the one event the alert built to
watch lease health was structurally unable to see, while the same counters went
on reporting a fleet at 99.8% kept.

## What Production Looked Like Through That Hole

On 2026-09-12 the tournament fleet was being torn down and rebuilt wholesale,
in a single minute, once every one to two hours:

| Minute | Tables killed | Distinct tables |
| ------ | ------------- | --------------- |
| 00:03  | 1,176         | 1,176           |
| 04:34  | 1,207         | 1,207           |
| 05:50  | 1,369         | 1,369           |
| 07:36  | 1,078         | 1,078           |
| 08:35  | 1,207         | 1,207           |
| 09:00  | 1,455         | 1,455           |

Exactly one kill per table: a fleet-wide event, not a churn. The code that
raises the kill-storm alarm states its own standard plainly: "Healthy is under
one an hour."

And through all of it:

```
poker_lease_heartbeat_outcomes_total{scope="tournament",state="kept"}      826986
poker_lease_heartbeat_outcomes_total{scope="tournament",state="taken"}          0
poker_lease_heartbeat_outcomes_total{scope="tournament",state="stale"}          0
poker_lease_heartbeat_outcomes_total{scope="tournament",state="malformed"}      0
```

## The Change

Both modules now charge one `malformed` outcome per claim before returning a
whole-answer refusal. Three sites: the cash claims refusal, the cash response
refusal, and the tournament response refusal. The increment is wrapped the same
way the per-row one is, because metrics must never affect a lease decision.

A fleet-wide refusal now reads as 100% not-kept for that scope and fires
`LeaseHeartbeatsNotBeingKept` on the rule that was already written for it. No new
alert was added; the existing one starts working.

## What This Deliberately Does Not Change

Declaring every lease lost on an unreadable answer is a documented safety
choice, stated in `tableLease`:

> `taken`, `stale`, `missing`, duplicate, omitted, or malformed rows all mean the
> old engine no longer has a current proof and must fail-stop before a database
> takeover is possible. That is deliberately stricter than the pre-deadline
> behavior, which allowed an UNKNOWN heartbeat to keep a dealer alive forever.

That decision is untouched. There is a real question about it, because a
transport failure carries exactly the same information (no usable answer) and is
treated as UNKNOWN rather than as proven loss, and the proof window bounds both
cases identically. But it is a safety ruling with a stated rationale, and it is
not an agent's to reverse on its own judgement. This change only makes the rule
visible when it is exercised, so the next occurrence is evidence rather than a
guess.

## What Is Still Unknown

The malformed path produces exactly the observed shape, but it does not close
the arithmetic. Two fleet-wide bursts occurred after the 07:56 restart and
`/health` reported a single tournament heartbeat error, so this path explains at
most one of them. That is an open question, not a conclusion, and it is the
reason this change is an instrument rather than a fix: the next occurrence will
name its own cause instead of being reconstructed from a kill ledger afterwards.

## Pins

`server/src/services/everyLeaseClaimLandsInAnOutcome.law.test.ts`, five cases.
The law is an accounting identity, not a threshold: a claim that was sent is
charged to exactly one state, and a refusal to read the answer is an outcome.

A transport failure is the one case that counts nothing, and that is correct: it
returns `uncertain`, fences nobody and extends nothing, so no claim was answered
and no claim earns an outcome. That case is pinned too, so the identity cannot be
"fixed" by counting the one thing that must not be counted.

Proven to bite: reverting the three producer sites fails all three accounting
cases and leaves both control cases passing.
