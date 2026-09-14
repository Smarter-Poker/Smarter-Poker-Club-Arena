# Creation engines preserve percentage bounties to the cent

A 30% bounty on a 5-chip entry was saved as 2 rather than 1.50. Scheduled,
recurring and union creators rounded percentage allocations to whole chips.
Recurring creators also ignored an explicit amount such as 6.75. These are
separate from the already-fixed scheduled explicit-amount branch.

The three creators now share one integer calculation in the Club Arena engine.
Entry total and fee rules remain the same. Percentages retain their existing
percent-of-total meaning; explicit amounts take precedence and the allocation
cannot exceed the contribution after fees. Percentage rounding occurs once at
the cent boundary. Invalid, non-finite, negative, sub-cent or unfunded settings
are rejected before an event is inserted. Supported percentages have at most
two decimal places and lie above zero through 100. The absent value defaults
to 30; an explicit zero is invalid. Non-bounty formats ignore unused settings.
Mystery range amounts derive from the same saved head.

This affects newly generated contracts. It does not recalculate existing
registered events, bounty obligations, winner payments or stored repeats.
The correction is chip-denominated creation, not Diamond currency certification.

Eleven of twelve initial actual-creator cases failed before the repair. After
repair, 102 focused cases and 3,370 service/creation tests across 189 files pass;
server TypeScript passes. Native PostgreSQL passes six groups across bounty
heads 5, 1.50 and 6.75, with current captured purchase/conservation bodies,
real inherited entry funding, add-on, replay and financial rollback checks.
See the bounty-add-on fixture README for exact hashes and the limited synthetic
schema/auth/maintenance scope. No knockout, mystery draw, bounty rebuy or final
payout is certified by that rehearsal. No production financial rows were changed.

Source publication and served-engine adoption remain open.
