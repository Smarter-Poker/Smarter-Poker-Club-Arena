# Launch client data recovery

Returning to Transaction History refreshed page one and replaced the list, hiding its newest 25 entries. Visibility refresh now starts at page zero. The rendered-page regression checks both the requested range and the retained/new transaction descriptions.

Welcome-package decoding rejected existing PostgreSQL UUIDs whose version bits differ from generated RFC identifiers, including Club JAQK. The parser now accepts canonical hexadecimal UUIDs while preserving club equality, malformed-input rejection, package version and financial response validation. Tests cover existing and generated IDs plus malformed inputs.

Table Operations listened to tables and table_seats WAL streams, neither of which is published. It now uses the existing useVisibleRead mechanism for authoritative table and expanded-seat reads while mounted and visible, every 20 seconds. Hidden/offline views stop reads; returning refreshes; old-scope replies are discarded. A failed initial table read shows an error and retry rather than claiming the club is empty. These reads do not write or repair server state. Tests cover external changes, hidden/visible transitions, errors/retry and late replies across clubs.

Client-only change, using existing APIs. No database or engine deployment dependency. Publication and live proof remain separate from local tests.
