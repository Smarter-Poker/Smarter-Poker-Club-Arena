# tests/the-union-sweep-commits-its-money-controls-before-the-snapshot.law.test.ts

The hourly union sweep runs every money control (integrity, ageing, stop-loss, lock hygiene, period closes) before the open-week rake basis refresh, which runs last in its own subtransaction that traps a statement timeout and stops refreshing for the hour, so a slow report can never roll a suspension or a period close back; the refresh records the cursor and input counts it read and does not recompute an unchanged stamp (20260926073120).
