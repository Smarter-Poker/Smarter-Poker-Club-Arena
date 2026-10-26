# A parked source keeps its park until it is moved (2026-10-26)

Dan: "TABLES NEED TO ALWAYS BE BALANCED 100% OF THE TIME NO MATTER WHAT."

Follow-up to `2026-10-26-a-short-table-is-filled-at-the-big-tables-next-boundary.md`
(#8161), from an independent line-by-line review of that change. Four gaps in
the new hand-boundary balance path, each one a way a big table could deal on
while a short table waited:

1. **Unfinished sweep work released the park.** When the boundary path found
   a seat move whose outcome was not yet known, a pending table retirement,
   unfinished break discovery or a mixed recovery, it gave the parked table
   back to its dealer and asked for a sweep five seconds later. The table dealt
   another hand and was fenced again: the old loop, back under exactly the
   conditions it was hardest to escape. Now the park is kept and the sweep is
   woken at once, as the park edge did before #8161; the sweep finishes that
   work first and then moves the player while the park is still valid. A frozen
   platform, a tournament break, a finished event or a manager that no longer
   owns its tables still releases the table, as before.
2. **A source already between hands was fenced and never claimed.** A source
   the fresh plan needed that was already sitting at the gate (hand-for-hand,
   a final-table deal pause) had fired its park edge earlier and would not fire
   it again. It was fenced, nothing claimed it, and no follow-up was asked
   for. Now every source the plan still needs is fenced and one coalesced
   follow-up sweep is requested, which moves it (an idle source is moved
   directly by the sweep).
3. **A park that expired during the board reads was dropped.** If the fence ran
   out while the boundary path read the board, the table dealt on, the move
   was dropped, the table was released, and nothing re-fenced it or asked
   again. Now it is fenced again and the follow-up is requested.
4. **A fenced table that became a break source swallowed its own break edge.**
   The boundary path claimed it, then excluded it from its plan, and only the
   break step's five-second redrive picked it up. Now a durable break source's
   park edge always goes straight to the sweep.

Pinned by four new cases in
`server/src/tournament/aShortTableIsFilledAtTheBigTablesNextBoundary.law.test.ts`.

What this does not change: a player is never moved in the middle of a hand,
so a table that falls out of balance mid-hand is balanced at its own next hand
boundary. Busts, late registration and re-entries all wake the balance sweep
(late registration through its durable manager wake).
