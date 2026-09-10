# Tournament format controls match their runtime — 2026-09-10

Phase 3 B11 remains partial. This change fixes two demonstrated UI gaps.

- The creation modal offered Multi-Day Tournament even though the installed database trigger refuses multi-day and flight settings. The modal now states that the format is unavailable, removes its unused state and controls, and submits the supported single-session configuration.
- The detail page offered a cash-deal vote and badge on satellite events that settlement refuses. Its existing satellite classification now governs the deal panel, poll and badge.
- The deal panel publishes the existing settlement terms before voting: unanimity, a settled hand boundary, tournament completion, prior paid prizes and unpaid fixed/bubble debts deducted first, then chip-proportional shares with cent rounding and the existing chip-leader tie order. The same terms remain visible after voting.

No settlement rule, vote RPC, money writer, stored flag or historical record is changed.

The manager's final-deal path requests `fn_complete_tournament_terminal(uuid,uuid,text)`, whose installed definition at 04:13:16 UTC has MD5 `f4275f9fa8cb2711f19ffdf7b16a04e6` and calls `fn_settle_tournament_final_table_deal(uuid)`. The inspected cash authority (03:58:31 UTC, MD5 `141c723b5225bcec588b8957cf039184`) supplies the disclosed arithmetic and satellite exclusion.

The enabled multi-day guard was verified read-only at 03:57:24 UTC. No production writes or financial rehearsals were performed.

Verification: focused diff reviewed and `git diff --check` passed. Root integration owns combined behavioral tests, typecheck, build, browser verification and publication; none are claimed here.

B11 still requires the equal-prize stopping contract and supported current-schema terminal acceptance. The installed satellite authority rejects more than one survivor even when several identical ticket awards are funded; this UI correction does not alter that rule.
