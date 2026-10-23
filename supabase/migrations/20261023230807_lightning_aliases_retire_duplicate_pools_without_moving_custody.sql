-- Reserved by scripts/reserve-migration-version.sh at 2026-10-23 23:08:07 UTC.
-- Action and Madness split the same stake into separate populations (20 pairs
-- observed). Keep Madness canonical and retire only its exact-stake Action twin.
-- Wallets, occupancies, sessions, blind obligations and settled history retain
-- their original owners. Existing disabled-source pools use the original
-- controller's pending_off/commit_must_move settlement barrier. Existing seats
-- finish and leave via ordinary cashout; no custody rewrite or forced cashout.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $transition$ DECLARE r record; s text; n text; policy_sql text:=$always$EXISTS(SELECT 1 FROM public.cash_games policy
 WHERE policy.id=g.id AND policy.enabled AND policy.closed_at IS NULL
 AND policy.must_move AND policy.lightning_enabled AND policy.handedness=6
 AND policy.template_name IN ('action','madness')
 AND policy.ruleset_snapshot#>'{lightning,always_on}'='true'::jsonb
 AND NOT EXISTS(SELECT 1 FROM public.lightning_cluster_drain d
   WHERE d.cluster_id=policy.id AND d.completed_at IS NULL))$always$; BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.fn_cash_cluster_begin_pending_on(uuid,uuid)','a6af3d59f2b6e46a06cca79a12fe24fc'),
  ('public.fn_cash_cluster_commit_lightning(uuid,uuid)','894ef4788a1f2fdcd9d05bf273a802e7')
 ) x(sig,want) LOOP
  s:=pg_get_functiondef(r.sig::regprocedure);
  IF md5(s)<>r.want THEN RAISE EXCEPTION 'Lightning conversion source changed: %',r.sig; END IF;
  n:=replace(s,'IF NOT coalesce((v_state -> ''verdict'' ->> ''would_turn_on'')::boolean, false) THEN',
   'IF NOT __LIGHTNING_ALWAYS_ON__ AND NOT coalesce((v_state -> ''verdict'' ->> ''would_turn_on'')::boolean, false) THEN');
  IF n=s THEN RAISE EXCEPTION 'Lightning conversion population anchor changed: %',r.sig; END IF;
  n:=replace(n,'__LIGHTNING_ALWAYS_ON__',policy_sql);
  EXECUTE n;
 END LOOP;
 s:=pg_get_functiondef('public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure);
 IF md5(s)<>'488f0de79cd381b1afd4a9f93dbc237b' THEN RAISE EXCEPTION 'Lightning drive source changed'; END IF;
 n:=replace(s,'v_on_ok  := coalesce((v_state -> ''verdict'' ->> ''would_turn_on'')::boolean, false);',
  'v_on_ok := __LIGHTNING_ALWAYS_ON__ OR coalesce((v_state -> ''verdict'' ->> ''would_turn_on'')::boolean, false);');
 n:=replace(n,'v_off_ok := coalesce((v_state -> ''verdict'' ->> ''would_turn_off'')::boolean, false);',
  'v_off_ok := NOT __LIGHTNING_ALWAYS_ON__ AND coalesce((v_state -> ''verdict'' ->> ''would_turn_off'')::boolean, false);');
 n:=replace(n,'ELSIF v_live_ok AND v_live > v_off THEN',
  'ELSIF v_live_ok AND (__LIGHTNING_ALWAYS_ON__ OR v_live > v_off) THEN');
 IF n=s OR n NOT LIKE '%NOT __LIGHTNING_ALWAYS_ON__%' THEN RAISE EXCEPTION 'Lightning drive population anchors changed'; END IF;
 n:=replace(n,'__LIGHTNING_ALWAYS_ON__',policy_sql);
 EXECUTE n;
END $transition$;

DO $source$
DECLARE s text; n text;
BEGIN
 s:=pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure);
 IF md5(s)<>'9d7d798d07a6ecc5138d3e334940e44e' THEN
  RAISE EXCEPTION 'Cash join source changed; requalify canonical admission';
 END IF;
 -- The complete original auth, private-membership, wallet, VPIP-bar,
 -- waitlist and seat-offer transaction executes against the canonical game.
 n:=replace(s,'  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR NO KEY UPDATE;',
  $join$
  IF coalesce((SELECT target.id FROM public.cash_games source
 JOIN public.cash_games target
  ON target.id::text=source.ruleset_snapshot->>'canonical_lightning_game_id'
  AND target.club_id=source.club_id AND target.variant=source.variant
  AND target.sb=source.sb AND target.bb=source.bb
  AND target.template_name IN ('action','madness') AND target.closed_at IS NULL
 WHERE source.id=p_game_id AND source.template_name IN ('action','madness')),p_game_id) IS DISTINCT FROM p_game_id
     AND public.fn_cash_game_barred_seconds(p_game_id,v_uid) IS NOT NULL THEN
    RAISE EXCEPTION 'GAME_BARRED:%',public.fn_cash_game_barred_seconds(p_game_id,v_uid)
      USING ERRCODE='check_violation';
  END IF;
  p_game_id := coalesce((SELECT target.id FROM public.cash_games source
 JOIN public.cash_games target
  ON target.id::text=source.ruleset_snapshot->>'canonical_lightning_game_id'
  AND target.club_id=source.club_id AND target.variant=source.variant
  AND target.sb=source.sb AND target.bb=source.bb
  AND target.template_name IN ('action','madness') AND target.closed_at IS NULL
 WHERE source.id=p_game_id AND source.template_name IN ('action','madness')),p_game_id);
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR NO KEY UPDATE;$join$);
 IF n=s THEN RAISE EXCEPTION 'Cash join canonical anchor changed'; END IF;
 EXECUTE n;

 s:=pg_get_functiondef('public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure);
 IF md5(s)<>'b9f7b55465879edb285a8fc93a980c4a' THEN
  RAISE EXCEPTION 'Cash creator implementation changed; requalify Lightning capability';
 END IF;
 n:=replace(s,'v_lightning boolean := false;', 'v_lightning boolean := lower(coalesce(p_template,'''')) IN (''action'',''madness'',''lightning'');');
 n:=replace(n,'    v_lightning := (v_o->>''lightning_enabled'')::boolean;', $lock$
    IF (v_o->>'lightning_enabled')::boolean IS DISTINCT FROM (v_t IN ('action','madness')) THEN
      RAISE EXCEPTION 'OVERRIDE_LOCKED: lightning_enabled follows the Classic or Lightning Games format';
    END IF;
    v_lightning := (v_o->>'lightning_enabled')::boolean;$lock$);
 -- The maintained creator retains commerce, membership and all locked rules.
 -- This user-transaction advisory key serializes aliases before the INSERT;
 -- existing per-template exact-key and category constraints remain intact.
 n:=replace(n,'  BEGIN
    INSERT INTO public.cash_games', $unique$
  IF v_t IN ('action','madness') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('lightning-game-key:'||p_club_id::text||':'||v_v||':'||round(p_sb,2)::text||':'||round(p_bb,2)::text,0));
    IF EXISTS(SELECT 1 FROM public.cash_games existing
       WHERE existing.club_id=p_club_id AND existing.variant=v_v
         AND existing.sb=p_sb AND existing.bb=p_bb AND existing.enabled
         AND existing.closed_at IS NULL AND existing.template_name IN ('action','madness')) THEN
      RAISE EXCEPTION 'GAME_EXISTS: this stake already has Lightning Games';
    END IF;
  END IF;
  BEGIN
    INSERT INTO public.cash_games$unique$);
 n:=replace(n,'  v_variant_label := CASE v_v', $config$
  IF v_t IN ('action','madness') THEN
    v_snap:=jsonb_set(v_snap,'{lightning}',
      CASE WHEN jsonb_typeof(v_snap->'lightning')='object' THEN v_snap->'lightning' ELSE '{}'::jsonb END ||
      jsonb_build_object('always_on',true,'on_threshold',5,'off_threshold',4,'worker_mode','form'));
  END IF;
  v_variant_label := CASE v_v$config$);
 n:=replace(n,'  RETURN jsonb_build_object(''ok'', true, ''game_id'', v_game_id,', $birth$
  IF v_lightning THEN
    -- Start the ORIGINAL conversion in the create transaction. A new anchor
    -- cannot become visible and deal ordinary cash before its pool takes over.
    PERFORM public.fn_cash_cluster_lightning_drive(v_game_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'game_id', v_game_id,$birth$);
 IF n=s OR n NOT LIKE '%lightning-game-key:%' OR n NOT LIKE '%lightning_enabled follows%' OR n NOT LIKE '%on_threshold'',5%' THEN
  RAISE EXCEPTION 'Lightning creator implementation anchors changed';
 END IF;
 EXECUTE n;
END $source$;

-- Physical must-move anchors wait for the pool's conversion. They must never
-- start a short-handed ordinary hand before the Lightning barrier takes over.
-- Repair both original projection owners so new and reconciled tables agree.
DO $physical$ DECLARE s text; n text; BEGIN
 s:=pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure);
 IF md5(s)<>'d49e1da1fe6d13f68651250009e1051f' THEN RAISE EXCEPTION 'Cash opener changed; requalify Lightning physical minimum'; END IF;
 n:=replace(s,
  'LEAST(120, GREATEST(10, coalesce((v_opts->>''action_time_seconds'')::integer, 15))), 2,',
  'LEAST(120, GREATEST(10, coalesce((v_opts->>''action_time_seconds'')::integer, 15))), CASE WHEN g.template_name IN (''action'',''madness'') THEN 6 ELSE 2 END,');
 IF n=s THEN RAISE EXCEPTION 'Cash opener minimum anchor changed'; END IF;
 EXECUTE n;
 s:=pg_get_functiondef('public.fn_cash_apply_ruleset(uuid)'::regprocedure);
 IF md5(s)<>'55fbd44177f9cafacfeeafa0c11f4012' THEN RAISE EXCEPTION 'Cash projection changed; requalify Lightning physical minimum'; END IF;
 n:=replace(s,'     SET ante_enabled = v_ante_chips > 0,',
  E'     SET auto_start_players = CASE WHEN g.template_name IN (''action'',''madness'') THEN 6 ELSE t.auto_start_players END,\n         ante_enabled = v_ante_chips > 0,');
 n:=replace(n,'          t.ante_enabled IS DISTINCT FROM (v_ante_chips > 0)',
  E'          (g.template_name IN (''action'',''madness'') AND t.auto_start_players IS DISTINCT FROM 6)\n       OR t.ante_enabled IS DISTINCT FROM (v_ante_chips > 0)');
 n:=replace(n,'  RETURN v_n;', $retired$
  -- Replaced sources park through this original projection owner.
  -- Preserve foreign holds; original OFF conversion already keeps all
  -- holds when disabled, so current settlement can finish safely.
  IF NOT g.enabled AND coalesce((SELECT target.id FROM public.cash_games source
 JOIN public.cash_games target
  ON target.id::text=source.ruleset_snapshot->>'canonical_lightning_game_id'
  AND target.club_id=source.club_id AND target.variant=source.variant
  AND target.sb=source.sb AND target.bb=source.bb
  AND target.template_name IN ('action','madness') AND target.closed_at IS NULL
 WHERE source.id=g.id AND source.template_name IN ('action','madness')),g.id)<>g.id THEN
    UPDATE public.tables t SET dealing_halted_at=clock_timestamp(),
      dealing_halted_reason='lightning_retired'
     WHERE t.cluster_id=g.id AND coalesce(t.lifecycle,'')<>'closed'
       AND NOT coalesce(t.is_deleted,false) AND t.dealing_halted_at IS NULL;
  END IF;
  RETURN v_n;$retired$);
 IF n=s OR n NOT LIKE '%auto_start_players IS DISTINCT FROM 6%' THEN RAISE EXCEPTION 'Cash projection minimum anchors changed'; END IF;
 EXECUTE n;
END $physical$;

-- Bounded, exact-scope one-hop aliases. Never rewrite historical template IDs,
-- transfer a table's cluster, or copy pool/session custody to another game.
WITH twins AS (
 SELECT a.id source_id,m.id target_id FROM public.cash_games a
 JOIN public.cash_games m ON m.club_id=a.club_id AND m.variant=a.variant
  AND m.sb=a.sb AND m.bb=a.bb AND m.template_name='madness'
  AND m.enabled AND m.closed_at IS NULL
 WHERE a.template_name='action' AND a.enabled AND a.closed_at IS NULL
)
UPDATE public.cash_games a SET enabled=false,
 ruleset_snapshot=jsonb_set(coalesce(a.ruleset_snapshot,'{}'),'{canonical_lightning_game_id}',to_jsonb(t.target_id::text)),
 updated_at=now() FROM twins t WHERE a.id=t.source_id;

-- Retiring sources carry the same40%/BB promise without being reenabled.
UPDATE public.cash_games g SET ruleset_snapshot=
 coalesce(g.ruleset_snapshot,'{}') || jsonb_build_object('regular_ante','bb','vpip_floor',40),
 name=upper(g.variant)||' '||g.sb::text||'/'||g.bb::text||' Lightning Games',updated_at=now()
WHERE g.template_name IN ('action','madness') AND g.closed_at IS NULL;

UPDATE public.cash_games g SET ruleset_snapshot=
 coalesce(g.ruleset_snapshot,'{}') || jsonb_build_object('regular_ante','bb','vpip_floor',40,
  'lightning',CASE WHEN jsonb_typeof(g.ruleset_snapshot->'lightning')='object' THEN g.ruleset_snapshot->'lightning' ELSE '{}'::jsonb END ||
   jsonb_build_object('always_on',true,'on_threshold',5,'off_threshold',4,'worker_mode','form')),
 lightning_enabled=true,must_move=true,
 name=upper(g.variant)||' '||g.sb::text||'/'||g.bb::text||' Lightning Games',updated_at=now()
WHERE g.template_name IN ('action','madness') AND g.enabled AND g.closed_at IS NULL;

DO $projection$ DECLARE r record; BEGIN
 FOR r IN SELECT id,name FROM public.cash_games
  WHERE template_name IN ('action','madness') AND closed_at IS NULL LOOP
  PERFORM public.fn_cash_apply_ruleset(r.id);
  UPDATE public.tables t SET name=CASE WHEN t.role='main' AND coalesce(t.main_index,1)>1
    THEN left(r.name,50)||' Main '||t.main_index
    WHEN t.role='feeder' THEN left(r.name,50)||' Feeder' ELSE r.name END,updated_at=now()
   WHERE t.cluster_id=r.id AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false);
 END LOOP;
END $projection$;
-- A finite admission event starts the original conversion immediately.
-- The ordinary controller retains the same durable conversion identity and
-- completes it only after current hands settle and dealers observe the halt.
DO $wake$ DECLARE r record; answer jsonb; BEGIN
 FOR r IN SELECT id FROM public.cash_games
  WHERE template_name IN ('action','madness') AND enabled AND closed_at IS NULL
  ORDER BY id LOOP
  answer:=public.fn_cash_cluster_lightning_drive(r.id);
  IF answer->>'ok' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'Canonical Lightning conversion refused: % %',r.id,answer;
  END IF;
 END LOOP;
END $wake$;
-- The existing pass visits disabled Lightning sources. Its original drive
-- opens pending_off on game_disabled and settles before committing must_move.
-- No new timer, watcher, wallet write, cashout or recurring repair.

-- Finite retirement is an explicit pg_temp operation in
-- scripts/dev/lightning-retire-occupancies.sql, using the existing cashout API.
COMMIT;
