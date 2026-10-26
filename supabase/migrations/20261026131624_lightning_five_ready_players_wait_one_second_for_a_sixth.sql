-- 20261026131624_lightning_five_ready_players_wait_one_second_for_a_sixth.sql
-- @live-proof: position('interval ''3 seconds''' in pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure))=0 AND (length(pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure))-length(replace(pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure),'interval ''1 second''','')))/length('interval ''1 second''')=3
-- @live-proof: position('interval ''3 seconds''' in pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure))=0 AND position('interval ''1 second''' in pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure))>0 AND position('WAITING_FOR_SIXTH_PLAYER' in pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure))>0
-- @live-proof: position('interval ''3 seconds''' in pg_get_functiondef('public.fn_lightning_formation_sizes(integer,integer,integer,integer,timestamp with time zone,timestamp with time zone)'::regprocedure))=0 AND position('p_now-p_oldest_idle>=interval ''1 second''' in pg_get_functiondef('public.fn_lightning_formation_sizes(integer,integer,integer,integer,timestamp with time zone,timestamp with time zone)'::regprocedure))>0
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (owner, Dan, 2026-10-26: "Approved: five-player
-- Lightning hands wait 1 second").
--
-- 20261023230001 set the owner's policy of 2026-10-23: six ready players deal
-- at once; exactly five wait THREE seconds, counted from the fifth player
-- becoming ready, for a sixth; fewer than five never deal. Measured on
-- 2026-10-26, five-player hands are about 14% of all Lightning hands, and their
-- last-freed-to-reserved time was 3,401 ms p50 against 293 ms for six. The
-- owner has now chosen ONE second. Nothing else changes: still five or six,
-- never fewer than five, and the wait still starts at the latest (fifth)
-- arrival, never the oldest.
--
-- The three seconds lives in three functions, each a literal interval:
--   fn_lightning_match_plan       3 sites (two potential-remainder sizings and
--                                  the selected group's own fifth-arrival test)
--   fn_lightning_form_hand        1 site  (a direct caller obeys the same wait)
--   fn_lightning_formation_sizes  1 site
-- Each is rewritten in place from its installed image: every
-- `interval '3 seconds'` becomes `interval '1 second'`, and the one comment
-- that names the wait is reworded. The function is refused if its image does
-- not hold exactly those sites, so an unknown edit aborts the transaction
-- instead of being overwritten. The images are patched by anchor, not by md5,
-- on purpose: the same file is installed by the matcher parity harness
-- (scripts/dev/test-lightning-matcher-parity.sh) on its own captured chain,
-- whose fn_lightning_form_hand predates the 20261026015255 variant guard, and
-- the anchors are the exact text being changed. Production images read
-- 2026-10-26 (SELECT pg_get_functiondef/md5, no DDL):
--   fn_lightning_match_plan       0f78751618b7c64222e683acfbad2341
--   fn_lightning_form_hand        a49a971d0e8598ba1d8e62fd57da15ca
--   fn_lightning_formation_sizes  a5306a9bb0e4f8b10c2b9a408a5ce548
--
-- CREATE OR REPLACE keeps each function's owner, grants and security. No
-- table is touched and no lock is taken on one, so this installs on merge.
-- The engine's own model of the same rule (LightningMatcherModel
-- LIGHTNING_FORMATION_MAX_WAIT_MS) moves to 1,000 ms in the same pull
-- request; until that engine is live (the daily 04:00 window) its passes run
-- every second anyway, and the database decides who is dealt.
-- Horses and humans are not distinguished anywhere here.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $one_second$
DECLARE
  r record;
  s text;
  n text;
  sites integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)', 3, NULL::text, NULL::text),
    ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)', 1,
       'eligible arrival starts the three seconds; an old first arrival cannot',
       'eligible arrival starts the one second; an old first arrival cannot'),
    ('public.fn_lightning_formation_sizes(integer,integer,integer,integer,timestamp with time zone,timestamp with time zone)', 1, NULL::text, NULL::text)
  ) x(sig, want, old_note, new_note) LOOP
    s := pg_get_functiondef(r.sig::regprocedure);
    sites := (length(s) - length(replace(s, 'interval ''3 seconds''', ''))) / length('interval ''3 seconds''');
    IF sites IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'Lightning five-ready wait sites changed in %: found %, expected %', r.sig, sites, r.want;
    END IF;
    IF position('interval ''1 second''' in s) > 0 THEN
      RAISE EXCEPTION 'Lightning five-ready wait already carries a one-second interval: %', r.sig;
    END IF;
    n := replace(s, 'interval ''3 seconds''', 'interval ''1 second''');
    IF r.old_note IS NOT NULL THEN
      IF (length(n) - length(replace(n, r.old_note, ''))) / length(r.old_note) <> 1 THEN
        RAISE EXCEPTION 'Lightning five-ready wait note changed in %', r.sig;
      END IF;
      n := replace(n, r.old_note, r.new_note);
    END IF;
    IF position('interval ''3 seconds''' in n) > 0
       OR (length(n) - length(replace(n, 'interval ''1 second''', ''))) / length('interval ''1 second''') <> r.want THEN
      RAISE EXCEPTION 'Lightning five-ready wait rewrite incomplete: %', r.sig;
    END IF;
    EXECUTE n;
  END LOOP;
END
$one_second$;

COMMIT;
