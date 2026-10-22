# 2026-10-21 Every Live MTT Tab Fits Its Event Name

Follow-up to `2026-10-21-mtt-tab-names-its-event.md`. Dan: "USE THE SUPABASE FOR ANY AND ALL TOURNAMENTS THAT ARE SCHEDULED OR RUNNING".

Read from production (PokerIQ-Production, 2026-10-21 21:30 CT): 277 MTT and satellite events registering or running across the Midway Union and the Diamond Arena, 75 distinct names, none blank, longest 34 characters, entry totals from Free Buy to 2,000. Satellites resolve to the MTT code, so they take the same pill.

Defect found: most scheduled names end in a game tag ("Prime Time Main Event (NLH)", "Mid-Morning Turbo (6-Max NLH)"). At the 160px pill cap that tag pushed the event name itself into the ellipsis.

- `tournamentTabEventName` drops a trailing parenthetical from the pill's top line; the pill's title keeps the full name. A name that is only a parenthetical is kept.
- An MTT pill showing its event name may run to 210px on desktop (`.table-tab-bar__tab--event`); phones keep the shared quarter-width rule.
- The law test renders every live name at the real entry totals and asserts name over buy-in, never blinds.
