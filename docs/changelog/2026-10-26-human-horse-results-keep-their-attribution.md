# Human versus horse results keep their attribution

The earlier enhancement handoff mistook a player's whole-session PLO5 winnings
for winnings from horses. Human-versus-human pots made that conclusion wrong.
`ca_hand_transfers` also contains hand-level proportional attribution, not exact
individual-pot provenance in every multiway side-pot case.

The explicit private command now reads durable `ca_hand_facts`, without cards,
and reports the human's actual net after rake only when every other dealt
participant is currently classified as a horse. Mixed-human hands and unknown
or malformed participant sets are counted separately. Variant, blind level,
player and cash/tournament status remain separate. Tournament chip results are
not ROI, and negating a human's net includes rake rather than measuring horse
profit. Candidate reads use the existing player/time index for the current human roster;
unknown actor identities are excluded explicitly. Unknown opponents remain
unscored. Current profile classification is identified as such; historical
identity is not reconstructed.

Run with existing authenticated psql configuration (no credential file loading
by this script):

```sh
node scripts/horse-human-scoreboard.mjs --run 2026-10-26T14:27:29Z 2026-10-26T15:00:00Z
```

`--sql` prints the same read-only SQL for an authorized SQL interface. Explicit
UTC endpoints are mandatory; maximum window fourteen days, a five-second server
statement budget and ten-second client deadline. Over 50,000 candidate facts
produces an incomplete result with no scores, never a passing partial sample.
Empty observations do not imply no horses or no human traffic elsewhere.

The retained PostgreSQL test invokes the real CLI and report query against an
isolated local database, covering mixed human pots, rake, missing identities,
invalid blinds, NaN, participant counts, duplicate opponents, endpoint exclusion,
variant/stake separation, tournament chips, empty windows and row-limit refusal.
The dedicated Horse human results workflow runs this test for report, regression
or workflow changes. Existing financial qualification inputs remain unchanged. No schema change, strategy activation or engine restart. The accepted weekly reporting phase is read-only and has no release authority.

Read-only production execution for 14:27:29–15:00 UTC observed 51 sole-human
facts, all tournament NLH/PLO4. This is too small and has no cash PLO5 sample;
it is not evidence for a new PLO5 strategy or sustainable winning performance.

The wider 24-hour query initially exceeded the one-second read budget.
The bounded roster-driven index plan and explicit five-second report budget
replace the full fact-window scan; timeouts still refuse the report.

An optional final player UUID selects the same report through the player/time
index, allowing bounded historical investigation without a full-fleet scan.
Invalid IDs are refused before any connection. The native fixture verifies
that this scope excludes the second human's fact rows. The 24-hour roster
report completed with 2,828 sole-human facts; the full 14-day roster query
remains unavailable under the five-second budget. A single-player 14-day
query completed, so wider history can be inspected per player without
raising the database deadline or manufacturing a whole-fleet result.

Follow-up review reproduced JavaScript's normalization of invalid calendar dates
(February 30 and April 31). The UTC parser now verifies the canonical calendar
instant before querying. The workflow now cancels superseded checks per PR,
preserving main-branch verification. All 85 existing concurrency-law cases pass.
Over-limit reads stop without sorting or classifying a sample that cannot be
scored; the candidate count remains explicit and no partial scores are emitted.

## Complete historical and weekly reporting

The original report now partitions a long window into at most 56 six-hour
reads, each under the same five-second database limit and ten-second client
limit, with a 90-second overall request budget. This is finite pagination,
with no retry or repair process. It merges only complete, contiguous,
non-overlapping windows with identical roster digests and validated coverage,
counts and score groups. Missing/failed/capped windows refuse the whole report.
BB/100 is recomputed from total hands and total BB, never averaged across
windows. A 14-day production read completed across 23 previously qualified
contiguous windows: 17,107 candidate human facts, 620 mixed-human rows excluded,
16,487 sole-human-against-horses rows. Cash human results: NLH -1,258.905BB
over 2,343hands; PLO4 -908.895/1,508; PLO5 +421.735/1,661;
PLO6 -949.58/289; PLO8 +72.23/78. These historical results span releases.

The accepted phase 6 weekly scoreboard runs Monday 14:00UTC (Monday morning
in Chicago), on protected main, through the same read-only report command.
It uses the existing canonical DATABASE_URL secret through psql, enforces
default_transaction_read_only, and retains the private JSON as an Actions
artifact for 14days. Manual dispatch can select explicit endpoints, or leave
both empty for seven days. PR execution cannot run the production-report job.
It cannot merge, publish an application, alter gameplay, or advance a release.
The timer registry records this one weekly business report; unrelated timers
and financial qualification source pins remain unchanged.
