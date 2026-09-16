# tests/a-reporter-does-not-become-the-bug.law.test.ts

`reportError` is only ever called from a catch block, so a throw inside it does
not add an error - it replaces the one the caller was already handling. On
2026-09-12 two families of unresolved rows in `horse_bug_reports`, 5,592
between them, turned out to be one mechanism: `OfflineQueueService.getCount()`
called `db.transaction()` inside a `new Promise` executor that took no
`reject`, so IndexedDB's synchronous `InvalidStateError` became an unhandled
rejection on OfflineQueueBadge's 2000ms poll; main.tsx handed each one to
`reportError`, which assigned to `message`; and `DOMException.prototype.message`
is an accessor with no setter, so the assignment threw back out of the
`unhandledrejection` listener before both `event.preventDefault()` and
`captureException`. The browser re-raised the reporter's own TypeError through
`window.onerror` and HorseBugReporter filed it as a second critical bug - 2,686
pairs in one 98-minute session on 2026-04-02 and 158 pairs on 2026-08-29,
exactly one per rejection, and not one of the underlying IndexedDB failures
ever reached error reporting. The law pins all four halves: the reporter never throws
and never mutates the caller's error whatever was thrown (DOMException, Symbol,
circular, null-prototype, frozen, a hostile getter), the queue's readers resolve
rather than reject when the connection is closing, the rejection is marked
handled before anything that can fail runs, and `window.onerror` titles are not
prefixed with a second "Uncaught" - which since #4398 made the title the
fingerprint would file one defect as two permanently separate rows.
