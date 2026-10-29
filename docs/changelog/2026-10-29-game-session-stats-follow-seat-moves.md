# Game session stats follow the chair

Confirmed seat moves now hand the original session to the destination before replacing the table page. The live Stats panel and recap counters retain the start time, hands, wins, VPIP/PFR, buy-ins, rebuys, peak and largest pot. Independent tables and accounts stay separate. Empty snapshots and view teardown do not end a sitting; the existing matching confirmed SESSION_ENDED event does, and the next sitting starts fresh.

The completed-hand path records the final dealt-in hand immediately, rather than waiting for another deal that never happens on the old table after a move. Carried table/hand identities reject replay counting. Destination fact/baseline restoration adds the prior-table counters and funding adjustment instead of replacing whole-session totals with one table's figures. Retained memory is cleared on sign-out. Financial writes, settlement authority and Diamond/chip history separation are unchanged.

Focused integration uses the actual seat-move navigation, lifecycle, stats service and recap hook across repeated moves, an already-open destination, a session over two hours, hand replay, unrelated games/accounts and confirmed end/new sitting. No engine or database installation is required.

The verified tournament insertion prefers the seated source over earlier observer tabs of the same event. New-session reset seeds funding and peak with the actual initial stack before rendering counters.
