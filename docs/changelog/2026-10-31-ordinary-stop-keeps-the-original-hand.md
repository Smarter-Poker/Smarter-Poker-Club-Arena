# Stop exact hand waits without discarding the original

Ordinary engine stop could cancel the cooperative hand safety timer and then
wait forever for a dealing loop whose exact controller wait had no remaining
release edge. Shutdown after its bounded drain and tournament-manager stop both
reach this path.

At the synchronous stop fence, the exact controller cancels its existing
pineapple settle beat so a refused or pending stop cannot advance that hand.
After fencing input, stop releases only that controller-owned local wait and
physically joins accepted continuation, settlement and other owned writers.
It does not complete a hand, invent an action, cancel its original permit or
release process ownership early.

An unretained continuation refuses retirement before snapshot, controller
cleanup or process release. An unfinished original without a retained lane also
refuses: generic cash snapshots omit the private deck, and their legacy startup
path abandons incomplete hands rather than reconstructing them. Both refusals
retain the exact original controller, lane and permit in quarantine. The same
rejected stop remains authoritative on retry.

A side-effect-free controller getter exposes only authoritative started and
completed lifecycle flags. The exact controller captured at the stop fence is
checked after physical writers drain. Unknown or malformed phases refuse;
genuinely prepared and completed controllers remain eligible. Completed
external RIT boards do not need private recovery serialization merely to prove
their completed phase. This getter is not a retention or settlement receipt.

RIT and insurance response waits check mutation authority before continuing the
hand, and clear their existing intervals on stop or supersession. The common
synchronous runout fallback checks the same authority: waking a paced sleep at
stop must not let its catch handler advance the retained original.

The existing fixtures reproduce the wait timeout, false successful retirement
of an unfinished cash original, stale response callbacks and actual paced catch
fallback. Regression coverage includes pending and queued continuation writes,
unknown phases, repeated refused stops, pending real pineapple beats across
quarantine and physical writer waits, held final snapshots, genuine prepared
originals, completed external RIT and the existing positive gameplay/payout
assertions. Positive fixtures claim and clean up their exact isolated process
registrations; that cleanup is not a runtime retirement certificate.

Source qualification is separate from activation and live behavior. This change
does not establish applicability to the historical serving EED guarded cutover
or automatically recover a quarantined original. No retention authority is
bypassed, and no migration, payment, refund, forced action or watchdog is added.
