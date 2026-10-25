-- 20261025025154_a_lightning_pool_session_tells_its_player_the_moment_it_open.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A player SEATED at a Lightning anchor table whose game converts is entered
-- into the pool by fn_cash_cluster_commit_lightning without ever clicking Join
-- Lightning, and their tab offers "View Game" once fn_lightning_my_session
-- names their pool session. Nothing told the tab that moment had come.
-- useLightningAnchorHandoff first waited on a postgres_changes UPDATE of
-- public.cash_games, which is not in supabase_realtime and must not be (19.7M
-- updates on 266 rows, pg_stat_user_tables 2026-10-24), so it never fired; #7943
-- replaced it with a 30-second read loop, which is a guess on a clock, not the
-- event. The other two carriers are wrong too: lightning_pool_session is
-- unpublished and unreadable by authenticated (1.4M updates on 4.3k rows), and
-- cash_cluster_events is published but has no player grant and takes about 5M
-- inserts.
--
-- THE ROOT FIX: the transaction that opens a player's pool session tells that
-- player. Both writers of public.lightning_pool_session do it (read live: the
-- conversion's INSERT ... SELECT, and fn_lightning_pool_enter, the door every
-- later entry goes through: abort_pending_off, the seat trigger,
-- pool_enter_seated). Each send is one realtime.send onto the EXISTING
-- owner-only topic profile-account:<player> (policy "players receive their own
-- account change signal", 20260927001026), which ProfileAccountSync already
-- holds open once per signed-in tab. So this adds no Realtime policy, no
-- publication member, no grant, no table and no new channel. The payload
-- carries identity only, {user_id, cluster_id, reason: 'lightning_room_opened',
-- domains: []}, with no stack, seat or row image, and the client answers it by
-- re-reading fn_lightning_my_session, which stays the authority.
-- realtime.send writes realtime.messages inside the caller's transaction, so a
-- conversion that aborts or rolls back sends nothing, and a send failure is
-- caught inside realtime.send itself and can never roll the conversion back.
-- Measured volume: 41 conversions to date, at most 54 pool sessions each (19 on
-- average). The topic already carries about 970 messages an hour.
--
-- HOW: an md5 pre-image guard on each live body (pg_get_functiondef, read
-- 2026-10-25), one anchor that must occur exactly once, a substituted
-- post-image whose md5 is asserted before and after EXECUTE, and a read-back
-- that the owner, SECURITY DEFINER flag, search_path and ACL are unchanged.
-- CREATE OR REPLACE keeps the OID, so the grants stay the function's own. One
-- transaction, one schema-cache reload. No table lock beyond the catalogue's
-- AccessShare (measured on PG16: CREATE OR REPLACE FUNCTION takes
-- AccessShareLock only), so it needs no install window.
--
-- NOTHING ELSE MOVES. No chip, seat, session, wallet or ledger row is written;
-- the conversion's chip-total, left-behind and stranded assertions are
-- untouched and still run after the new statement. No is_horse anywhere
-- (CLAUDE.md 10.5): every pool session is told.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure)) = 'e1edf0a3a4a1cecf749f2ed24d35cc71')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure)) = '9149913448f4d27054de4b6334d60aeb')
-- @live-proof: (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND p.prosecdef = (p.proname = 'fn_cash_cluster_commit_lightning')) AND count(*) = 2 FROM pg_proc p WHERE p.oid IN ('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure, 'public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename IN ('cash_games', 'lightning_pool_session')))

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';

DO $patch$
DECLARE
  r      record;
  v_src  text;
  v_new  text;
  v_acl  text[];
  v_def  boolean;
  v_cfg  text[];
  v_own  oid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_cash_cluster_commit_lightning(uuid,uuid)', '35cf4a34f4e2cce1cc2a77b8e5576de4', 'e1edf0a3a4a1cecf749f2ed24d35cc71',
     $a$  -- Step 22.
$a$,
     $n$  -- THE PLAYER IS TOLD THE ROOM IS OPEN (20261025025154). One private
  -- signal per pool session this conversion opened, on the owner-only
  -- profile-account:<player> Broadcast topic that every signed-in tab already
  -- holds (ProfileAccountSync). It is written inside this transaction, so it
  -- is delivered only if the conversion commits, and it carries no row
  -- value: the client answers it by re-reading fn_lightning_my_session.
  -- Every pool session is told, whoever holds it (CLAUDE.md 10.5).
  PERFORM realtime.send(
           jsonb_build_object('user_id', ps.player_id, 'cluster_id', g.id,
             'reason', 'lightning_room_opened', 'domains', '[]'::jsonb),
           'account_changed', 'profile-account:' || ps.player_id::text, true)
     FROM public.lightning_pool_session ps
    WHERE ps.cluster_id = g.id AND ps.cluster_epoch = v_epoch AND ps.exited_at IS NULL
    ORDER BY ps.entered_at, ps.id;

  -- Step 22.
$n$),
    ('public.fn_lightning_pool_enter(uuid,timestamp with time zone)', '634a4efa3919619a00347a1758eda79e', '9149913448f4d27054de4b6334d60aeb',
     $a$    'cash_player_session_id', v_cps, 'via', 'fn_lightning_pool_enter', 'at', v_now), g.cluster_epoch);
$a$,
     $n$    'cash_player_session_id', v_cps, 'via', 'fn_lightning_pool_enter', 'at', v_now), g.cluster_epoch);

  -- THE PLAYER IS TOLD THE ROOM IS OPEN (20261025025154), exactly as the
  -- conversion tells every player it enters: one owner-only signal, delivered
  -- only if this entry commits, answered by a re-read of fn_lightning_my_session.
  PERFORM realtime.send(
    jsonb_build_object('user_id', s.user_id, 'cluster_id', g.id,
      'reason', 'lightning_room_opened', 'domains', '[]'::jsonb),
    'account_changed', 'profile-account:' || s.user_id::text, true);
$n$)
  ) AS x(sig, pre_md5, post_md5, anchor, replacement) LOOP
    v_src := pg_get_functiondef(r.sig::regprocedure);
    -- THE PRE-IMAGE GUARD. The body this file was written against, byte for
    -- byte; anything else is a newer body this substitution was never read
    -- against, and the whole transaction rolls back.
    IF md5(v_src) <> r.pre_md5 THEN
      RAISE EXCEPTION 'LIGHTNING_ROOM_SIGNAL_SOURCE_CHANGED: % is %, expected %',
        r.sig, md5(v_src), r.pre_md5;
    END IF;
    IF (length(v_src) - length(replace(v_src, r.anchor, ''))) / length(r.anchor) <> 1 THEN
      RAISE EXCEPTION 'LIGHTNING_ROOM_SIGNAL_ANCHOR: % does not carry its anchor exactly once', r.sig;
    END IF;
    v_new := replace(v_src, r.anchor, r.replacement);
    IF md5(v_new) <> r.post_md5 THEN
      RAISE EXCEPTION 'LIGHTNING_ROOM_SIGNAL_POSTIMAGE: % would be %, expected %',
        r.sig, md5(v_new), r.post_md5;
    END IF;
    SELECT p.proacl::text[], p.prosecdef, p.proconfig, p.proowner
      INTO v_acl, v_def, v_cfg, v_own
      FROM pg_proc p WHERE p.oid = r.sig::regprocedure;
    -- CREATE OR REPLACE, from the catalogue's own definition: the OID, the
    -- owner, SECURITY DEFINER (or its absence), search_path and every grant
    -- are the function's own and are kept. They are read back below.
    EXECUTE v_new;
    IF md5(pg_get_functiondef(r.sig::regprocedure)) <> r.post_md5 THEN
      RAISE EXCEPTION 'LIGHTNING_ROOM_SIGNAL_INSTALLED_BODY: % did not install as written', r.sig;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = r.sig::regprocedure
         AND p.proacl::text[] IS NOT DISTINCT FROM v_acl
         AND p.prosecdef = v_def
         AND p.proconfig IS NOT DISTINCT FROM v_cfg
         AND p.proowner = v_own) THEN
      RAISE EXCEPTION 'LIGHTNING_ROOM_SIGNAL_ATTRIBUTES: % changed its grants, owner or security settings', r.sig;
    END IF;
  END LOOP;
END
$patch$;

COMMIT;
