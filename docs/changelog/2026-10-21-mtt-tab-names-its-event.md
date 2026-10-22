# 2026-10-21 An MTT Action Tab Names Its Event

Dan, verbatim: "FOR MTT'S IT SHOULD SAY THE TOURNAMENT NAME AS WELL AS THE BUY IN INSIDE THE ACTION TAB. NOT JUST 35."

The multi-table action pill for an MTT read "MTT" over its buy-in ("35"), which does not say which tournament it is. MultiTablePage already read each tournament tab's event name (`readTournamentTabInfo`) for the take-seat banner, but never handed it to the tab bar.

- `TabInfo.tournamentName` added; MultiTablePage passes `t.tournamentName` to the bar.
- An MTT pill with no live cards prints the event name on top and the buy-in under it. The name ellipsises on one line inside the pill's existing max-width, with the full name on the element title.
- While the name is unknown (or empty) the top line stays "MTT". SNG and SPIN keep their code. Cash tabs are unchanged. Hole cards still replace the whole label.
- Pinned in `tests/a-tournament-tab-says-its-buy-in.law.test.tsx`.
