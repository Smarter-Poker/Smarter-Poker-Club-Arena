-- 20260909181309_a_locked_rule_is_refused_not_ignored_and_a_band_refusal_names_the_holder
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-09 18:13:09 UTC.
-- Written by lane I of the 2026-09-09 must-move audit
-- (docs/audits/2026-09-09-must-move-audit/lane-I.md). NOT applied by the lane;
-- the integrator (lane C) applies it serially.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  TWO SENTENCES fn_cash_game_create SAYS TO A HOST, BOTH CORRECTED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. A LOCKED RULE THAT ARRIVES DIFFERENT IS REFUSED, NOT IGNORED.
--
--    20260909035303_a_classic_game_has_no_antes_and_no_bombs made regular_ante,
--    vpip_floor, vpip_window and the bombs object come from the template.
--    It did that by no longer READING them from p_overrides. It did not refuse
--    them. Read live 2026-09-09 18:00 UTC:
--
--      v_ante := v_def->>'regular_ante';
--      v_vpip := (v_def->>'vpip_floor')::integer;
--      v_bombs := coalesce(v_def->'bombs', '{}'::jsonb);
--
--    and the only check on the caller's bombs is `jsonb_typeof <> 'object'`.
--    So the client bundle serving at that hour - which still offered an ante
--    radio, a Bomb Pots switch, a trigger, an ante slider and a boards picker
--    - let a host set "One Big Blind" on a Classic game, sent it, and got a
--    game with no ante and a toast saying Game Created. The host believed the
--    table they built. CLAUDE.md 10.86: a signal that answers when it does not
--    know. The client is rebuilt in the same branch so it no longer sends the
--    four; THIS makes the server say so if anything ever does again.
--
--    The line is "did the caller ask for something other than the promise".
--    A locked key that arrives EQUAL to the template is accepted, so an older
--    bundle that echoes the defaults back keeps working; a locked key that
--    arrives DIFFERENT raises OVERRIDE_LOCKED naming the key and the template.
--    For bombs, `enabled` must agree, and when the template runs bombs the
--    trigger, ante and boards must agree too; a classic client that sent
--    {enabled:false, trigger:'timed_15m', ante_bb:2, boards:2} (the old
--    overridesFromSnapshot filled those in) is still accepted, because the
--    promise - no bombs - is what it asked for.
--
-- 2. A BAND REFUSAL NAMES THE GAME HOLDING THE BAND.
--
--    zz_one_game_per_blind_category raises, with ERRCODE unique_violation:
--
--      ONE_GAME_PER_BLIND_CATEGORY: this club already runs NLH 0.25/0.50
--      Action (0.25/0.50) as its Action micro game. Close it before opening
--      another.
--
--    fn_cash_game_create_impl_20260905 catches unique_violation and rewrites
--    EVERY one as
--
--      GAME_EXISTS: this club already runs <Template> <Variant> <the stakes
--      the host just picked>
--
--    which for the band case is false: a host opening Action NLH 1/2 where the
--    club runs Action NLH 0.50/1 (both 'low') was told the club already runs
--    Action NLH 1/2. It does not. The trigger's sentence, which names the game
--    to close, was swallowed. Now the handler re-raises the trigger's own
--    exception untouched when that is what it caught, and keeps the GAME_EXISTS
--    wording for the exact-key index (cash_games_one_per_key), where the stakes
--    the host picked ARE the stakes the club runs.
--
-- HOW THIS EDITS THE FUNCTION. Same method as 20260909035303: read the LIVE
-- definition, two literal replaces on anchors that each occur exactly once,
-- refuse to proceed if an anchor is missing, refuse if any sibling guard goes
-- missing from the result. Idempotent: if both edits are already present it
-- says so and does nothing.
--
-- PROBED ROLLED BACK before this file was written (one execute_sql call, one
-- DO block ending in RAISE EXCEPTION, request.jwt.claim.sub set to a club
-- owner for the duration of the aborted transaction). Transcript in
-- docs/audits/2026-09-09-must-move-audit/lane-I.md.
--
-- ROLLBACK
--   Reverse the two replaces; each quotes its before and after in full below.
--
-- Wrap ALL DDL for one change in ONE transaction (production DDL policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;

  v_anchor_def CONSTANT text :=
    'v_def := public.fn_cash_template_defaults(v_t, v_v);';
  v_guard CONSTANT text :=
    'v_def := public.fn_cash_template_defaults(v_t, v_v);' || E'\n' ||
    E'\n' ||
    '  -- A LOCKED RULE THAT ARRIVES DIFFERENT IS REFUSED, NOT IGNORED (2026-09-09,' || E'\n' ||
    '  -- 20260909181309). regular_ante, vpip_floor, vpip_window and bombs are the' || E'\n' ||
    '  -- template''s promise to the player. A caller may echo them back unchanged;' || E'\n' ||
    '  -- a caller asking for something else is told so, never quietly overruled.' || E'\n' ||
    '  DECLARE' || E'\n' ||
    '    v_lk text;' || E'\n' ||
    '  BEGIN' || E'\n' ||
    '    FOREACH v_lk IN ARRAY ARRAY[''regular_ante'', ''vpip_floor'', ''vpip_window''] LOOP' || E'\n' ||
    '      IF v_o ? v_lk AND (v_o->>v_lk) IS DISTINCT FROM (v_def->>v_lk) THEN' || E'\n' ||
    '        RAISE EXCEPTION ''OVERRIDE_LOCKED: % is set by the % template (sent %, template %)'',' || E'\n' ||
    '          v_lk, v_t, v_o->>v_lk, v_def->>v_lk;' || E'\n' ||
    '      END IF;' || E'\n' ||
    '    END LOOP;' || E'\n' ||
    '    IF v_o ? ''bombs'' AND jsonb_typeof(v_o->''bombs'') = ''object'' THEN' || E'\n' ||
    '      IF (v_o->''bombs''->>''enabled'') IS DISTINCT FROM (v_def->''bombs''->>''enabled'')' || E'\n' ||
    '         OR (coalesce((v_def->''bombs''->>''enabled'')::boolean, false) AND (' || E'\n' ||
    '              (v_o->''bombs''->>''trigger'') IS DISTINCT FROM (v_def->''bombs''->>''trigger'')' || E'\n' ||
    '           OR (v_o->''bombs''->>''ante_bb'') IS DISTINCT FROM (v_def->''bombs''->>''ante_bb'')' || E'\n' ||
    '           OR (v_o->''bombs''->>''boards'')  IS DISTINCT FROM (v_def->''bombs''->>''boards''))) THEN' || E'\n' ||
    '        RAISE EXCEPTION ''OVERRIDE_LOCKED: bombs is set by the % template (sent %, template %)'',' || E'\n' ||
    '          v_t, v_o->''bombs'', v_def->''bombs'';' || E'\n' ||
    '      END IF;' || E'\n' ||
    '    END IF;' || E'\n' ||
    '  END;';

  v_old_exists CONSTANT text :=
    'EXCEPTION WHEN unique_violation THEN' || E'\n' ||
    '    RAISE EXCEPTION ''GAME_EXISTS: this club already runs % % %'', initcap(v_t), v_variant_label, v_label;';
  v_new_exists CONSTANT text :=
    'EXCEPTION WHEN unique_violation THEN' || E'\n' ||
    '    -- zz_one_game_per_blind_category names the game HOLDING the band, which' || E'\n' ||
    '    -- is not the stakes the caller picked. Its sentence goes through as it' || E'\n' ||
    '    -- is (2026-09-09, 20260909181309); the exact-key index keeps GAME_EXISTS.' || E'\n' ||
    '    IF SQLERRM LIKE ''ONE_GAME_PER_BLIND_CATEGORY:%'' THEN' || E'\n' ||
    '      RAISE;' || E'\n' ||
    '    END IF;' || E'\n' ||
    '    RAISE EXCEPTION ''GAME_EXISTS: this club already runs % % %'', initcap(v_t), v_variant_label, v_label;';
BEGIN
  v_src := pg_get_functiondef(
    'public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure);

  IF position('OVERRIDE_LOCKED' in v_src) <> 0
     AND position('ONE_GAME_PER_BLIND_CATEGORY:%' in v_src) <> 0 THEN
    RAISE NOTICE '20260909181309: both edits already present, nothing to do';
    RETURN;
  END IF;

  IF (length(v_src) - length(replace(v_src, v_anchor_def, ''))) / length(v_anchor_def) <> 1 THEN
    RAISE EXCEPTION
      'the live definition does not carry the defaults anchor exactly once; read it before re-running';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_old_exists, ''))) / length(v_old_exists) <> 1 THEN
    RAISE EXCEPTION
      'the live definition does not carry the GAME_EXISTS handler exactly once; read it before re-running';
  END IF;

  v_new := replace(v_src, v_anchor_def, v_guard);
  v_new := replace(v_new, v_old_exists, v_new_exists);

  IF position('OVERRIDE_LOCKED' in v_new) = 0
     OR position('ONE_GAME_PER_BLIND_CATEGORY:%' in v_new) = 0 THEN
    RAISE EXCEPTION 'a replacement did not take';
  END IF;

  -- Every other guard this function performs must survive the edit.
  IF position('VARIANT_UNAVAILABLE' in v_new) = 0
     OR position('STAKES_INVALID' in v_new) = 0
     OR position('HANDEDNESS_INVALID' in v_new) = 0
     OR position('BUYIN_BAND_INVALID' in v_new) = 0
     OR position('ANTE_INVALID' in v_new) = 0
     OR position('VPIP_INVALID' in v_new) = 0
     OR position('VPIP_WINDOW_INVALID' in v_new) = 0
     OR position('BOMB_TRIGGER_INVALID' in v_new) = 0
     OR position('BOMB_ANTE_INVALID' in v_new) = 0
     OR position('BOMB_BOARDS_INVALID' in v_new) = 0
     OR position('STAY_CLOCK_BELOW_FLOOR' in v_new) = 0
     OR position('REJOIN_WINDOW_BELOW_FLOOR' in v_new) = 0
     OR position('CLOCK_TOO_LONG' in v_new) = 0
     OR position('NOT_AUTHORIZED' in v_new) = 0
     OR position('SESSION_REVOKED' in v_new) = 0
     OR position('GAME_EXISTS' in v_new) = 0
     OR position('v_ante := v_def->>''regular_ante'';' in v_new) = 0
     OR position('v_bombs := coalesce(v_def->''bombs'', ''{}''::jsonb);' in v_new) = 0 THEN
    RAISE EXCEPTION 'a guard went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

-- ── POST-APPLY ASSERTION: the body that is live is the body this file means ──
-- Read back through the catalogue, not from the variable, so a silent no-op
-- (a search_path surprise, a different overload) aborts the transaction here
-- rather than being reported as success.
DO $assert$
DECLARE
  v_live text := pg_get_functiondef(
    'public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure);
BEGIN
  IF position('OVERRIDE_LOCKED: % is set by the % template' in v_live) = 0
     OR position('OVERRIDE_LOCKED: bombs is set by the % template' in v_live) = 0
     OR position('IF SQLERRM LIKE ''ONE_GAME_PER_BLIND_CATEGORY:%'' THEN' in v_live) = 0
     OR position('GAME_EXISTS: this club already runs % % %' in v_live) = 0
     OR position('v_ante := v_def->>''regular_ante'';' in v_live) = 0 THEN
    RAISE EXCEPTION 'refusing to commit: the live fn_cash_game_create_impl_20260905 does not carry both edits';
  END IF;
  RAISE NOTICE '20260909181309: OVERRIDE_LOCKED and the band pass-through are live';
END;
$assert$;

COMMIT;
