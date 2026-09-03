# Cashier Phase 3 — Roster, Ledger, And Batch Performance

The cashier now renders the first 500 authorized recipients as soon as that
page arrives, continues through a deterministic role/user keyset, and preserves
the usable partial roster with a visible retry if a continuation fails.

Send Out and Send Ticket now submit bounded chunks of 25 recipients. The
database returns one result per recipient and delegates each item to the same
mandatory-key money RPCs as a single action. The modal announces live progress,
keeps per-recipient failures visible, and emits one aggregate diagnostic rather
than flooding monitoring once per target.

Club/from-user and club/to-user ledger paths now have covering indexes, and the
recursive roster edge has a club/agent partial covering index. All three are
built concurrently so live chip writes are not stopped during publication.

Production certification is transaction-isolated: two sends and two tickets
are executed and replayed, exact balances and receipt counts are checked,
keyset pages are checked for overlap, all index states are checked, and the
entire fixture is rolled back.
