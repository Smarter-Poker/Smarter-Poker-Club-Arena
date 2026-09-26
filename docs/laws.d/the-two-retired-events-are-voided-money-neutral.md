# tests/the-two-retired-events-are-voided-money-neutral.law.test.ts

The reviewed void door (smarter_private.f06_void_retired_mixed_custody_event) can only ever void the two retired mixed-custody events 5a387a75 and 615783bf, once, with every money and roster fact pinned; the f06_source_guard bypass it needs exists only inside the migration's own transaction and is restored byte for byte to the live pre-image; and the migration never waits while it holds the settlement lane (lock_timeout 5s, statement_timeout 10s) (20260926131948).
