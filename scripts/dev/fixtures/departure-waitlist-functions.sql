-- Isolated queue boundaries plus the exact pre-change function bodies.
-- Both definition hashes match production read-only inspection on 2026-09-14.
CREATE TABLE cash_game_waitlist(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_id uuid,user_id uuid,
 status text NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE table_waitlist(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,
 position integer NOT NULL DEFAULT 1,status text NOT NULL CHECK(status IN('waiting','notified','seated','left','cleared','expired')),
 created_at timestamptz DEFAULT now(),notified_at timestamptz,hold_expires_at timestamptz);
CREATE UNIQUE INDEX waitlist_test_active ON table_waitlist(table_id,user_id) WHERE status IN('waiting','notified');
CREATE UNIQUE INDEX game_waitlist_test_active ON cash_game_waitlist(game_id,user_id) WHERE status IN('waiting','notified');
ALTER TABLE table_waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_game_waitlist ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON table_waitlist,cash_game_waitlist TO authenticated;
CREATE OR REPLACE FUNCTION public.fn_cash_game_leave_waitlist(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_uid uuid := auth.uid(); v_n integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first' USING ERRCODE = '28000';
  END IF;
  UPDATE public.cash_game_waitlist SET status = 'cancelled', updated_at = now()
   WHERE game_id = p_game_id AND user_id = v_uid AND status IN ('waiting', 'notified');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'cancelled', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_table_waitlist_leave(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_n integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first' USING ERRCODE = '28000';
  END IF;
  UPDATE public.table_waitlist SET status = 'left'
   WHERE table_id = p_table_id AND user_id = v_uid AND status IN ('waiting', 'notified');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'cancelled', v_n);
END;
$function$;

