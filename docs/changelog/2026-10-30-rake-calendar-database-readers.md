# Additive calendar Rake readers

Prepare the database contract before the client selects it. The legacy Rake RPCs use a rolling clock cutoff while the Stats overview uses viewer-calendar dates. At Chicago midnight, the observed seven-day mismatch included 3,012 extra cash hands and 860.74 extra rake.

The additive All Clubs and funded-club calendar readers use the same ca_stats_calendar_bounds as the overview. Their bounded private share helper preserves historical funding, existing rule/day rounding and fixed redemption accounting. Original RPCs are unchanged. This database-only change writes no financial data and does not require an engine replacement.

Native PostgreSQL reproduces the defect and validates the actual migration, date and asset/club boundaries, 23/25-hour DST days, standing shares including recipients without hands, redemption boundaries, original APIs, private ACLs and replay refusal. The maintained Data Console fee-redemption driver executes these cases.

Required sequence: protected merge, exact Apply Merged Migration installation and readback, then the separately delivered client switch. A schema-manifest promise does not certify installation.

The same screenshot's downline row also ignored the selected ledger dates: WhatTheBell showed57.14 Overall fees while raw receipts in Oct26..29 summed7.22. Add ca_club_member_downline_in_range, preserving the original API/hierarchy/access fields and passing the applied UTC dates to the existing fee reader. Its native fixture verifies57.14/7.22, inclusive days, other hierarchies, refused access, unchanged identities/wallets and replay refusal. Install20261030051204 before its separate client switch.
