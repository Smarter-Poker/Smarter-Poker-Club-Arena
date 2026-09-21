# tests/an-abandoned-break-can-still-reach-a-terminal-state.law.test.ts

An F06 table break has one terminal exit when its source is the last open table
of the event: the no-start continuation. Until 2026-09-21 that exit was reachable
from exactly one caller - table engine admission - so a park abandoned by a lease
generation that died could never take it. The repeating discovery path reaches
the continuation only through bindStoppedOriginalBreak, which demands an
in-memory hand permit issued under the CURRENT generation, and a table parked by
a now-retired generation that has not dealt since can never present one. On
2026-09-18, 153 operations parked and stopped; 54 were last-table parks holding
custody that satisfied every other precondition, and discovery found them
hundreds of times across three days without being able to finish one. The fix
offers the same audited continuation to the operation discovery already holds;
it does not weaken the permit binding, and the continuation still re-proves the
entire last-table scope itself.
