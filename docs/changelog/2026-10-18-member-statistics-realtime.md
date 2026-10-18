# Member performance follows the live member record

The linked Player Statistics page previously loaded only on entry and filter changes. It now consumes the same authorized private member-record events as member management, including the viewer record for permission changes. Rejoin, focus, restored connectivity and UTC date rollover reconcile current figures without applying draft dates or changing the selected game.

Background reads preserve verified values on temporary failure, coalesce bursts into one active read and one queued read, and ignore aborted results after scope changes. Permission denial removes statistics and discovered game choices. No polling, money writes or new engine dependency.

Regression coverage reproduces the missing subscription before the fix and covers event updates, burst coalescing, draft preservation, rejoin/outage recovery, permission withdrawal, viewer changes during an active read and the UTC boundary.

The primary member ledger also advances its seven-day scope at UTC midnight while continuously visible and idle. A targeted fake-clock regression fails before and passes after, including cancellation when switching to custom dates.
