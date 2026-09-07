-- ═══════════════════════════════════════════════════════════════════════════
--  REALTIME WAS BROADCASTING THE ANSWER
-- ═══════════════════════════════════════════════════════════════════════════
-- APPLIED TO PRODUCTION 2026-09-02. Door #3 of three; see
-- 20260902_horse_identity_is_not_readable_by_a_player.sql (direct reads) and
-- 20260902_horse_flag_is_masked_for_non_staff_rpcs.sql (the RPCs).
--
-- Column grants do not help here AT ALL: a logical-replication publication
-- carries whatever columns it lists, and Supabase Realtime hands that payload
-- to any subscriber whose RLS lets them see the row. GRANT/REVOKE never enters
-- into it.
--
-- FOUND: `supabase_realtime` published
--     public.profiles     -> is_horse, horse_status, horse_profile
--     public.table_seats  -> horse_id
--
-- And the client already subscribes to `profiles` postgres_changes: TablePage
-- watches seated players for avatar/cosmetic changes, and PostgresSyncHooks
-- keeps a `global_db_sync:<userId>` channel open for the whole session. A
-- player could subscribe to profile changes and read `is_horse` straight off
-- the wire, with the REVOKE fully in place and looking like it worked.
--
-- AFTER (verified):
--     profiles     117 of 120 columns published, withholding
--                  is_horse, horse_status, horse_profile
--     table_seats   21 of 22 columns published, withholding horse_id
--
-- The column lists are BUILT DYNAMICALLY rather than typed out, because
-- `profiles` has 120 columns and a hand-written list would be wrong the day
-- someone adds the 121st.
--
-- `ALTER PUBLICATION ... SET TABLE` replaces the publication's ENTIRE table
-- set, which would silently unsubscribe every other realtime table on the
-- platform. So this DROPs and re-ADDs one table at a time, inside the single
-- transaction the migration runs in.
--
-- REPLICA IDENTITY is 'd' (default = primary key) on both tables, so the
-- primary key is inside the column list and replication stays valid.
--
-- KNOWN MAINTENANCE COST, stated plainly: a publication with a column list
-- does not automatically publish columns added later. A new `profiles` column
-- will not reach realtime subscribers until it is added to this list. That is
-- the correct trade - the failure mode is "a new field is not broadcast",
-- which someone notices and fixes, versus "a new sensitive field is broadcast
-- to everyone", which nobody notices.
--
-- This also closes `table_seats.horse_id`, which the first migration could NOT
-- revoke at column level (that table carries a table-level SELECT grant, so a
-- column REVOKE there is a no-op). Direct SELECT of it remains possible for
-- now and returns NULL on every row - nothing has ever written it - and the
-- column is dropped once PR #2743 stops the felt selecting it.
--
-- ROLLBACK:
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.profiles;
--   ALTER PUBLICATION supabase_realtime ADD  TABLE public.profiles;
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.table_seats;
--   ALTER PUBLICATION supabase_realtime ADD  TABLE public.table_seats;

DO $$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO v_cols
  FROM pg_attribute a
  WHERE a.attrelid = 'public.profiles'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname NOT IN ('is_horse', 'horse_status', 'horse_profile');

  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'PRE-FLIGHT: could not build a column list for public.profiles.';
  END IF;

  EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.profiles';
  EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles (%s)', v_cols);

  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO v_cols
  FROM pg_attribute a
  WHERE a.attrelid = 'public.table_seats'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname <> 'horse_id';

  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'PRE-FLIGHT: could not build a column list for public.table_seats.';
  END IF;

  EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.table_seats';
  EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.table_seats (%s)', v_cols);
END $$;

DO $$
DECLARE
  v_leaked text;
  v_profile_cols int;
BEGIN
  SELECT string_agg(pt.tablename || '.' || a.attname, ', ')
    INTO v_leaked
  FROM pg_publication p
  JOIN pg_publication_rel pr ON pr.prpubid = p.oid
  JOIN pg_class c ON c.oid = pr.prrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_publication_tables pt ON pt.pubname = p.pubname AND pt.tablename = c.relname
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE p.pubname = 'supabase_realtime'
    AND a.attname = ANY (ARRAY['is_horse','horse_status','horse_profile','horse_id'])
    AND (pr.prattrs IS NULL OR a.attnum = ANY (pr.prattrs));

  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION 'POST-APPLY: realtime still publishes horse identity: %', v_leaked;
  END IF;

  -- and the rest of profiles must still be broadcast, or every avatar and
  -- cosmetic update on the platform silently stops arriving.
  SELECT cardinality(pr.prattrs) INTO v_profile_cols
  FROM pg_publication p
  JOIN pg_publication_rel pr ON pr.prpubid = p.oid
  JOIN pg_class c ON c.oid = pr.prrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
  WHERE p.pubname='supabase_realtime' AND c.relname='profiles';

  IF COALESCE(v_profile_cols, 0) < 100 THEN
    RAISE EXCEPTION 'POST-APPLY: profiles publishes only % columns - the list is too narrow.', v_profile_cols;
  END IF;
END $$;
