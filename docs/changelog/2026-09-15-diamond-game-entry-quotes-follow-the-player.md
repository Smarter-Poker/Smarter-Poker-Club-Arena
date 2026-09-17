# Diamond Game Entry Quotes Follow The Player

Plinko, Crash, Donkey Crossing and Mines wait for a current server entry quote
before enabling a new wager. Quotes are bound to the chosen amount and, for
the choice games, the selected difficulty. A late response for an earlier
selection cannot replace the current quote. Launching a wager or a choice
action invalidates older reads; accepted and recovered choice rounds update
the current-round reference before refreshing their state. Crash no longer
borrows the first available bet's limit when the exact amount is absent.

An asynchronous Crash or choice-game proof check cannot report a verdict for
the previous round while a new wager is pending or after a newer round has
replaced it. Plinko stops its per-drop proof work after leaving the page and
does not request another commitment after an unmounted recovery completes.

The Donkey scene's moving directional-light target is attached to the scene
so its world position follows the donkey. Mines no longer allocates an unused
donkey, and scene teardown explicitly releases the shadow render target.
The existing geometry, material quality, controls and fallback stay in place.

Regression source exercises delayed amount quotes, out-of-order Mines and
Donkey difficulty responses, and previous-round proof completion during a
new entry. These scenarios extend the retained commitment, recovery and Crash
poll/cashout regression cases. Application tests, typechecks, builds, wallet
fixtures and browser/graphics acceptance have not run on these bytes.

The owner has now authorized publication for the four-game task. The required
protected pipeline is still unqualified for Club Arena source jobs, and its
read-only status returned an unconfirmed ValueError. The pipeline owner
acknowledged both the publication intent and the blocker; no approved game
execution identity exists yet. This source change is not a source-admission,
build, migration or release receipt. No GitHub or direct execution fallback
is authorized. Final wheel design remains the separately instructed phase.
