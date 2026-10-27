-- 20261027144913_lightning_retains_the_anchor_until_every_original_hand_is_te.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A released normal/fast-fold reservation permits another deal, never departure
-- before every original hand settles or is abandoned. The stop/reaper used the
-- reservation-only reader, closed the pool, and thereby released its seat guard.
-- Preserve the original live-hand/anchor/settlement authority and pending holds.
-- This migration replaces only function bodies; no live-table lock or money write.
-- @live-proof: (position('public.fn_lightning_player_live_hand(v_uid, p_cluster_id) IS NOT NULL' in pg_get_functiondef('public.fn_lightning_stop_playing(uuid)'::regprocedure)) > 0)
-- @live-proof: (position('public.fn_lightning_player_live_hand(s.player_id, s.cluster_id) IS NOT NULL' in pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure)) > 0)
-- @live-proof: (position('lightning_settlement_marker' in pg_get_functiondef('public.fn_table_seats_lightning_anchor_guard()'::regprocedure)) > 0)
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $patch$
DECLARE item record; definition text; replacement text;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('public.fn_lightning_stop_playing(uuid)',
     'a46a994e3e62ff38d7b06e017b3e2794',
     'public.fn_lightning_player_in_hand(v_uid, p_cluster_id)',
     'public.fn_lightning_player_live_hand(v_uid, p_cluster_id) IS NOT NULL'),
    ('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
     '639cd7eade58264d26248ac720a59faa',
     'public.fn_lightning_player_in_hand(s.player_id, s.cluster_id)',
     'public.fn_lightning_player_live_hand(s.player_id, s.cluster_id) IS NOT NULL')
  ) AS patches(signature, expected_md5, old_text, new_text)
  LOOP
    definition := pg_get_functiondef(item.signature::regprocedure);
    IF md5(definition) IS DISTINCT FROM item.expected_md5
       OR (length(definition)-length(replace(definition,item.old_text,'')))/length(item.old_text) <> 1 THEN
      RAISE EXCEPTION 'Lightning anchor exit source drift: %',item.signature;
    END IF;
    replacement := replace(definition,item.old_text,item.new_text);
    EXECUTE replacement;
    IF pg_get_functiondef(item.signature::regprocedure) IS DISTINCT FROM replacement THEN
      RAISE EXCEPTION 'Lightning anchor exit readback failed: %',item.signature;
    END IF;
  END LOOP;
END $patch$;

COMMIT;
