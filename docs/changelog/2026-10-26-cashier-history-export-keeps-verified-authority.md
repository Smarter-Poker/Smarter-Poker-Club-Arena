# Cashier History Export Keeps Verified Authority

Transaction History could finish a download after a same-view membership change or an unreadable authority check had invalidated Cashier access. Export now requires resolved authority, retires its pending page reads when that authority or account/view changes, and passes the same guard to the existing browser/native download helper. A verified Retry restores Download. Captured filter choices remain intact while the export runs; database authorization remains authoritative.

Mounted regressions reproduce both role-change and unreadable-authority timing failures before the repair, and verify cancellation plus a successful export after Retry. The existing production History case also checks the real read-only CSV handoff for its isolated identity's own book.
