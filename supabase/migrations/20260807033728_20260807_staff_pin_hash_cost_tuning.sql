-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260807033728 "20260807_staff_pin_hash_cost_tuning"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 01e39620d02165b1123c434a3ebf8b55 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PIN verification is PIN-only (venue + pin -> staff), so the RPC must bcrypt
-- every active staff row at the venue until one matches; there is no unique
-- identifier to index on. Measured with cost 10 and 12 staff: 827ms per login,
-- scaling linearly with headcount (a 40-staff room would exceed 2.5s) — far too
-- slow for a floor tablet.
--
-- PINs are 4-6 digits (~10^4-10^6 keyspace), so a high bcrypt cost buys little
-- against offline cracking anyway; the meaningful protections are not leaking the
-- table and rate-limiting online attempts. Cost 6 keeps a full-venue scan well
-- inside the latency budget while still being enormously better than the
-- plaintext equality check it replaces.
--
-- ROLLBACK: re-run the cost-10 backfill from 20260807_staff_pin_hashing_additive.

UPDATE public.commander_staff
   SET pin_hash = extensions.crypt(pin_code, extensions.gen_salt('bf', 6))
 WHERE pin_code IS NOT NULL;
