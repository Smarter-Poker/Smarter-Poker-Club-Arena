# Qualify river-call learning and retained decision evidence

Continuation of the river-call visibility work (#8108, #8130, #8151, #8160).
The client Called-tag repair remains separately tracked in #8185.

The v6 read-frame encoder added river-call counters, but journal allocation
qualification still stopped at v5. A genuine allocated v6 capture therefore
became `invalid_plan_binding`. Extend the same allocation rules to v6; retain
context, request binding and legacy-downgrade refusals. A real encoded-frame
regression fails before the correction (49 pass, one fails), and passes after.

A high-hand name alone cannot classify the strength of a hi-lo or multi-board
call. Carry variant and actual board count through accepted physical-hand
observations, the worker and the private public-observer copy. Unknown contexts,
unknown hand categories, hi-lo and multi-board hands teach no weak-call sample.
The current single-board Lightning producer and single-board league harness
supply the same context. Decision-time hi-lo/multi-board gates prevent old
counters from affecting these games. Cards and player classification are never
added to this context, and the table's reveal rules remain unchanged.

A five-sample 50% cutoff also confuses ordinary hold'em calls with a tendency.
Use at least twelve shown calls and a one-sided Wilson lower bound (z=1.645)
above the family baseline before adjusting river bluffs/thin value. Preserve
the existing bounded adjustment range. A decision with a known scope never
borrows these counters from the mixed-family pooled bucket.

Baseline evidence: the inherited handoff measured roughly 40% one-pair-or-worse
river calls in hold'em and 4% in Omaha. A fresh read-only production sample at
2026-10-26 ~14:20 UTC, last three hours capped at 30,000 hands, found shown final
plain river calls on a single board: NLH 102/308, FLH 17/69, pineapple 18/49;
PLO4 0/61, PLO5 0/66, PLO6 0/48; short deck 3/96. These are pre-table-all,
shown-only samples and are selection-biased. Retain conservative .40 hold'em
and .04 Omaha/short-deck baselines, rather than treating zero observations as a
zero population rate. No population-wide false-positive guarantee is claimed.
Hi-lo samples were excluded from calibration (FLO8 62/230; PLO8 3/55) because
the high name omits low-hand value.

Regression coverage includes actual encoded v6 allocation and downgrade
refusal, minimum sample/confidence boundaries, variant and multi-board
exclusions, unknown categories, cross-family fallback refusal, settlement
context production and queued observer consumption, and identical strategy
against horse and human opponents.

This changes engine source. A protected merge is not activation. The existing
`20261026033405_horse_mind_river_call_reads.sql` remains a daily-window migration;
readback on October 26 found it absent, with no columns installed. Never replay
or install this declared-window file outside its existing owning transaction.
