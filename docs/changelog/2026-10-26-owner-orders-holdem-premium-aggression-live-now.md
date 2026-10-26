# Owner orders the hold'em premium rule live now

Dan, 2026-10-25 21:09 Chicago: "MAKE THESE FIXES NOW FOR THE HORSE BRAIN AND
UPDATE ALL 1000 HORSES". 23:12 Chicago: "finish it up now, and push and
publish now, not at 4am."

PR #8122 (`HorseHoldemPremiumAggression.ts`: premiums are never passive,
dominated hands fold to a 3-bet, every NLH horse) is merged. One owner-ordered
window in `server/release/owner-maintenance-windows.json` names that merge, so
the release of this merge activates it at the next certified off-cycle break
instead of 04:00. It uses the existing last-hand notice, drain, freeze,
certificate, rollback reserve and thaw, expires within six hours, and grants
nothing more once an engine containing the merge is serving. No migrations.
