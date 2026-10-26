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
profit. Current profile classification is identified as such; historical
identity is not reconstructed.

Run with existing authenticated psql configuration (no credential file loading
by this script):

```sh
node scripts/horse-human-scoreboard.mjs --run 2026-10-26T14:27:29Z 2026-10-26T15:00:00Z
```

`--sql` prints the same read-only SQL for an authorized SQL interface. Explicit
UTC endpoints are mandatory; maximum window fourteen days, a one-second server
statement budget and ten-second client deadline. Over 50,000 candidate facts
produces an incomplete result with no scores, never a passing partial sample.
Empty observations do not imply no horses or no human traffic elsewhere.

The retained PostgreSQL test invokes the real CLI and report query against an
isolated local database, covering mixed human pots, rake, missing identities,
invalid blinds, NaN, participant counts, duplicate opponents, endpoint exclusion,
variant/stake separation, tournament chips, empty windows and row-limit refusal.
The dedicated Horse human results workflow runs this test for report, regression
or workflow changes. Existing financial qualification inputs remain unchanged. No schema change, strategy activation, engine restart or schedule.

Read-only production execution for 14:27:29–15:00 UTC observed 51 sole-human
facts, all tournament NLH/PLO4. This is too small and has no cash PLO5 sample;
it is not evidence for a new PLO5 strategy or sustainable winning performance.
