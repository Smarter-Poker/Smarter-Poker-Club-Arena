# Preparation retains ownership of accepted cashouts

An actual ServerTableEngine regression reproduced premature teardown: prepareNextHand started processLeavePending in parallel with the roster read; the read failed, and stop released resources while that cashout was still pending. A Promise.race step budget could detach the same writer.

Preparation now acquires the existing seat boundary and joins the roster read, raw cashout and budget result using Promise.allSettled. A failed read or elapsed budget cannot cancel a database transaction or establish that its owner may be replaced. Reads remain parallel. Confirmed departures filter both the local and returned roster by original occupancy, preserving a replacement seat. The boundary releases in finally only after the accepted cashout settles. No watcher/reconciler or new timer was added.

Verification: the original teardown case failed before correction. All 13 ownership tests passed after correction; the full server suite then passed 8,084 tests (73 opt-in database cases skipped). A second regression was subsequently added and all 14 ownership tests passed, proving elapsed-budget ownership, next-boundary exclusion and replacement preservation. The affected client timing law passed all eight tests and server TypeScript passed after the final test addition. The full client suite had passed 17,377 tests immediately before this server-only change; it has not been repeated for this checkpoint.

This remains part of the unpublished occupancy bundle. SQL-driven cluster cashouts and close ownership, compatibility adoption and deployed verification remain open; Phase 2 is not complete.
