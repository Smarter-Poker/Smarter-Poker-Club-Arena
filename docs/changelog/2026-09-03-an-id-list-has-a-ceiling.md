# An Id List Has A Ceiling

**Date:** 2026-09-03
**Scope:** `server/src/services/supabase/chunkedIn.ts` (new), and eight call
sites across the rotator, the fleet-death watchdog, the recurring service, the
lifecycle manager and three tournament managers.

## How it was found

The retirement drain shipped in #2878 did nothing. Twelve tables were correctly
flagged, the fleet correctly refused to seat anyone at them - `[HorseFleet] 12
surplus table(s) draining` in the log - and not one horse ever stood up. No
error, no log line, nothing.

The rotator resolves who is a horse with one query:

```ts
const { data: horses } = await supabase
  .from('profiles')
  .select('id')
  .in('id', userIds)
  .eq('is_horse', true);
const horseIds = new Set((horses || []).map((h) => h.id));
```

PostgREST puts that id list in the URL. Measured against this project's
instance the same hour: the largest `.in()` it accepts on `profiles` is **675
ids**, about 25 KB of URL, and the rotator was handing it **713**. Every 90
seconds it got HTTP 400 Bad Request, the error went into a discarded field,
`horses` came back null, and `horseIds` was empty.

An empty horse set does not read as "the query failed". It reads as _nobody in
the room is a horse_. Every rule in the service is keyed on that set, so:

- no horse was ever a candidate to leave - the retirement drain, and every
  session end;
- `humanPresent` was true at every table in the room, which is the most
  protective answer possible and therefore looked like nothing to fix;
- no breaks, no top-ups, no table changes.

The entire humanisation layer had been inert since the room crossed 675 seated
players, which happened as the fleet grew during the day, and it said nothing.

## The sweep

Eight more of the same shape. Three were already past the ceiling at the floor
size of the day (1,131 tables):

1. **`DealRateVerifier`** counted hands across every dealing table in one
   `.in()`. Its own guard reads an error as "not evidence of silence", resets
   the counter and returns - so the watchdog whose only job is noticing the
   fleet stopped dealing had switched itself off, at exactly the scale where a
   fleet outage matters, and logged nothing.
2. **`TournamentRecurringService.cashFloorReserve`** counted seats across up to
   2,000 cash tables, returned 0 on failure, and 0 means "reserve nobody for
   the cash room" - which lets tournaments claim every free horse. That is the
   drain its own neighbouring comments blame for emptying the cash floor on
   2026-08-31.
3. **The rotator's second read**, of `club_members` for bankrolls. Worse than
   the first: with the map empty, `topUpAllowance()` is skipped entirely and a
   horse reloads the full desired amount with **no bankroll cap**.

And five that break at realistic field sizes: the horse lifecycle reset and its
cleanup delete (every registration in a finished event; the delete had no error
handling at all), late-reg seating (empty means "nobody is seated", so the whole
field reads as unseated - a write storm every five seconds and no table
expansion), the busted-player seat release (unchunked while the same class
defines a chunk constant 1,000 lines above and has a law test pinning it; a
ghost seat holds the felt), and fleet add-ons in big MTTs.

## The fix

One helper, `selectInChunks`, because the convention already existed - the
fleet chunks at 200, the elimination sweep at its own constant, the rakeback
settler at another - but there was no shared implementation, which is why it
was applied unevenly.

It makes the dangerous half impossible. It returns `{ rows, complete }`, so a
caller cannot read a failure as an empty answer without saying so, and every
site above now either declines the pass or reports the failure by name.

`fetchAllRows` solves the other half of the same problem and does not overlap:
it pages a result set too big to return; this bounds a filter too big to send.

## Verification

14 pins in `anIdListHasACeiling.test.ts`, including the one that matters - a
failed chunk is `complete: false`, never an empty result. Server 4,778 of 4,778
green; both typechecks clean.
