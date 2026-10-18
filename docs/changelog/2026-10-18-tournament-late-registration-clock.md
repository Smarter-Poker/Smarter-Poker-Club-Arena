# Tournament Late Registration Uses Its Authored Clock

Diamond MTT creation stored eight in `late_reg_mins` regardless of the
configured level cutoff. The live Sunday 200 therefore had twelve ten-minute
levels but closed admission after eight minutes; the corresponding chip event
correctly carried 120 minutes. The shared details countdown also ignored the
minute deadline whenever a level deadline existed.

The guarded migration replaces the Diamond creator's literal with the same
indexed blind-ladder calculation used by the maintained engine creators.
Break entries consume their index without adding playing time; an extended
cutoff uses the last playable duration. Explicit zero windows and satellite
and SNG formats retain no late registration. Invalid or overflowing clocks
are refused before creation.

Only legacy literal-eight Diamond platform MTTs with an eligible, unfinalized
level window are corrected. A narrow postgres-only lifecycle exception permits
that exact canonical clock correction after an accepted entry. It still checks
every other protected field. Completed, cancelled and finalized events retain
their fields. No prices, payouts, balances, custody or accepted entries change.
Both function definitions and authority metadata are checked in the migration;
a repeat installation is refused.

The details action and overview now apply both existing admission bounds using
the synchronized server clock. The existing countdown updates local text;
this adds no network polling or snapshot diff. Tournament lifecycle updates
continue through the existing tournament-change subscription. The approved
registration artwork and both entry points are preserved.

Validation: the actual creator reproduces twelve levels/eight minutes before
the migration. The isolated PostgreSQL 17 current 134-authority scene exercises
a real funded entry, canonical correction, price and arbitrary-clock refusal,
future creation, zero/SNG windows, rounding, aliases, indexed breaks, overflow,
both actual admission deadlines, supply/custody and replay refusal. Three
selected connected-client regressions fail on the preimage; the repaired
details and overview pass focused checks. Installation, protected merge,
publication and cold production proof are separately recorded in the existing
Diamond audit checkpoint; this source change alone is no launch certificate.

No engine runtime or API changes are required. Generic chip creation already
uses the authored clock; its configured windows are preserved.
