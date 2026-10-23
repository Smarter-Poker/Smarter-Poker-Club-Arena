# The maniac read survives a restart (2026-10-22)

## What was wrong

The opponent exploit read (`HorseOpponentExploit`, decayed counters keyed
`scope|player`) is what lets a horse recognise a player who shoves or pots
every hand. It lived only in process memory, and nothing rebuilt it at boot:
`HorseMindHydrator` replays history through `HorseMind.observe()`, which feeds
the basic stats, while the exploit counters are fed only by
`observeHandComplete()`. So the daily 04:00 engine reset, and every decision
worker restart, gave a known maniac a clean slate, and the horses spent his
first hands of the day learning him again.

## The fix

`server/src/services/HorseExploitHydrator.ts` replays the last 72 hours of
hands a human was dealt into (`hand_history.has_human`, set at insert and
served by `idx_hand_history_human_created`), newest 12,000, oldest first,
through the same `exploitHandIncrements` the live hand uses, one hand per
sandbox, merged by `HorseMind.mergeSandboxExploit` (the entry point the worker
mirror already uses). The decision worker awaits it before READY, next to the
existing hydration.

No table, no RPC, no flush job and no repair path: the read is rebuilt from the
record the platform already keeps. Horse-only hands are skipped because a read
is per player and every hand a human played is a `has_human` hand; horses sit
inside the envelope the read is measured against, so their read is null
whether replayed or not. Nothing is denied to a horse.

No policy digest moves: the hydrator and the worker boot are not decision
sources, so the PLO4 generation 5 selection and the running strength leagues
are untouched.

## Proof

`server/src/services/HorseExploitHydrator.test.ts`: forty shove hands observed
live, the mind wiped, the hydrator run on the same rows, and every counter of
the maniac and of a horse matches the live values to nine places; the read is
a maniac read again. Paging past the PostgREST cap, a query error, and a
malformed row are each covered.
