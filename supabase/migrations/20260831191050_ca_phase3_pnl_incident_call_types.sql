-- ZERO-DRIFT phase 3 fixup (prod): fn_union_settle_player_pnl passed v_ca_id
-- (uuid) positionally into fn_ca_raise_drift_incident's p_settlement_id
-- (text) — no implicit uuid->text cast exists for call resolution, so the
-- failure handler itself would have failed. Fixed to v_ca_id::text; the
-- settlement claim id now rides as p_entity_id. Idempotent.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure);
  v_new := replace(v_def,
    'NULL, NULL, p_union_id, NULL, NULL, NULL, v_ca_id, NULL, NULL,',
    'v_settlement_id, NULL, p_union_id, NULL, NULL, NULL, v_ca_id::text, NULL, NULL,');
  IF v_new <> v_def THEN
    EXECUTE v_new;
  END IF;
END $$;
