# A parked Lightning anchor recovers its busted horse

**What was wrong.** A Lightning Cluster's halt parks every anchor table for as
long as the Cluster is Lightning, and the parked pass is the only loop those
tables run. It finished departures and acknowledged the halt, but it never ran
the horse bust recovery every ordinary cash table runs (Settlement step 5 and
the idle `recoverBustedSeatedHorses`). A horse that busted in a Lightning hand
was therefore never rebought from the club treasury and never stood up: it sat
in the pool on a zero anchor stack indefinitely. On 2026-10-19 at 02:08Z the
private Action pilot had 37 open pool sessions and only 4 playable; the other
33 were horses at zero, none rebought, the oldest stuck since 21:21Z on
2026-10-18. That broke CLAUDE.md 10.5 (a horse gets exactly what a seat at an
ordinary table gives it) and starved the pilot of players.

**The fix.** The parked pass now calls `recoverBustedHorsesWhileHalted`, which
the dealing engine implements with the same shared recovery an idle cash table
uses: the temperament's stop-loss, `horseRebuyAmount`, the treasury funding
door (`fn_horse_fund_from_treasury`) and the one busted-seat exit door, whose
departure exits the pool session through the existing anchor-seat trigger.
The only thing a parked anchor supplies is the bust's identity. Its own
`handCount` never moves, so keying the funding operation on it would make a
second bust replay the first bust's receipt. Instead it reads the Lightning
hand that took the anchor to zero in its open pool session
(`LightningBustIdentity`, read-only). An unreadable identity funds and
releases nothing and is asked again on the next pass; no Lightning bust in the
session falls back to the table's own key. A changed seat wakes the Cluster's
matcher. No database change, no change to Lightning settlement, thresholds,
rake or the auto-rebuy option for people.

**Proof.** `aParkedLightningAnchorRecoversItsBustedHorse.law.test.ts` pins the
hook's position in the parked pass and the shared recovery, and exercises the
Lightning key, a second bust as a second operation, the unknown and fallback
identities, stop-loss and an unpaid treasury. Against production on
2026-10-19 the identity query resolved a bust hand for all 33 stuck horses.
