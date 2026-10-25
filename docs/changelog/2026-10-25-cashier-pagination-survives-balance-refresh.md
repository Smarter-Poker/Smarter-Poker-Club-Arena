# Older history pages survive a balance refresh

A balance event refreshed the first history page and advanced the same request generation used by an in-flight older-page read. The older response was discarded, including the completion that unlocked its button. A busy cashier could remain at 50 rows with Load Older stuck working.

Older-page reads now belong to the filter generation. A same-book head refresh can finish without retiring them; changing the club, book, kind, range, person or search still retires the old request before paint. The existing cursor, deduplication and older-page merge are preserved.

The mounted regression returns 51 real-shaped cursor rows, holds the next page, delivers the registered balance callback, and completes the head refresh before the older read. Before the fix only 50 receipts remain. After the fix 100 receipts are available and the older-page control is enabled. Existing changed-book, late-error, authorization and financial recovery regressions remain required.
