# Native fault evidence in the existing incident reader

The explicit restart diagnostic previously read the kernel journal but exported only OOM markers. Exit 139 therefore remained unclassified even if a native fault existed in that same bounded journal.

The existing kernel branch now emits fixed native-fault categories, timestamp, Node/other process class, and a fixed library classification. It exports no addresses, process IDs, raw messages, arbitrary executable names or paths. Host evidence explicitly leaves engine attribution unproven. The original commands, four-second per-source limit, completed fifteen-minute window, opt-in dispatch and before/after identity checks are unchanged. No engine code or production configuration changes.

Regression: the new native-fault fixture fails on the old reader and passes with the parser. The complete existing native fixture covers transport, input bounds and sanitization. This is diagnostic capability, not a claim that the exit-139 root cause is fixed.
