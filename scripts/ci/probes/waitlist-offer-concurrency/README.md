# Native waitlist offer fixture

`baseline.sql` is the complete production `fn_offer_open_seat(uuid,interval,interval)` definition captured September 14, 2026, with MD5 `3dbcee6f093d9c36d7f0ee1e940d5a2b`.

`auth-uid.json` preserves the exact captured authentication helper, including its whitespace. `callers.sql` contains the complete captured `fn_cash_game_join`, `fn_cash_game_open_seats`, `fn_sweep_stale_waitlists` and `fn_cash_game_barred_seconds` definitions. No caller is replaced with a successful stub. The native schema preserves the current waitlist foreign keys, status check and active-row uniqueness. Production has no custom waitlist triggers at capture time. Other table columns are the fields exercised by these callers; this is not a complete production schema certificate.

The fixture notification table deliberately has no delivery trigger. Tests prove transactional notification intent and rollback, and cannot send push or SMS. No chips are funded, moved or paid. Run `python3 scripts/ci/test-waitlist-offer-concurrency.py --output /absolute/new/evidence-directory` with PostgreSQL 17 available through `PG_BIN`.
