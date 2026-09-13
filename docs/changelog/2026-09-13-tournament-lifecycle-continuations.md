# Tournament lifecycle continuations and launch isolation

The September 13 production investigation found 24 overdue MTT starts and no
new hand in any of the 84 running MTTs during a 30-minute observation window.
Blind clocks continued advancing. These observations establish an incident;
they do not by themselves identify the cause of every stranded event.

This engine change fixes seven independently verified failure paths:

- A satellite terminal settlement with an unknown outcome awaited manager
  teardown from inside the same scheduler job teardown drains. It now applies
  the existing synchronous mutation fence and lets that job unwind before
  releasing any ownership. Unknown money results remain fenced.
- A helper returning after the elimination work budget expired could lose its
  causal continuation before reaching the stage checkpoint. The unfinished
  cursor now receives one coalesced continuation while its lifecycle is current.
- Scheduled discovery awaited each manager's entire physical retirement.
  Retirement now runs as one tracked job per exact manager, retaining its map
  slot and lease while discovery continues serving other tournaments.
- A synchronized tournament break resumed after a 90-second timeout even when
  platform thaw was unfinished. That threshold now reports once and preserves
  the paused clock until actual thaw or lifecycle cancellation.
- Spin presentation derived `is_premium_spin` from a 100x draw and attempted
  to alter a funded entry contract. Presentation no longer writes that economic
  field; booked blinds and payouts still come from the immutable draw receipt.
- A balancing pass that exhausted its budget could advance past an unfinished
  stage. It now retains the balancing cursor for the coalesced continuation.
- Break release now requests a consolidation sweep: single-player tables
  cannot produce the next hand edge needed to wake unfinished field work.

The new regressions reproduced the satellite self-wait, lost budget wake and
premature break resume before their fixes. Targeted checks cover physical
ownership retention, retirement coalescing, lifecycle abort, exact remaining
blind time, satellite receipt certainty and the booked Spin projection.
The full tournament suite passes 1,829 tests across 151 files; the server
typecheck also passes. The comparison and remaining certification matrix are
recorded in `docs/audits/2026-09-13-mtt-engine-blueprint.md`.

Production acceptance remains a separate requirement: observe starts, hands,
eliminations, table moves, final receipts and synchronized break recovery on
the actual released SHA. At investigation time engine releases were failing
their host memory-headroom check and production still served de406ca9.
