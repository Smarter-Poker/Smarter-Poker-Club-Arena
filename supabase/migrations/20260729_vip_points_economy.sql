-- VIP loyalty points economy (was 100% cosmetic — hardcoded to 0). Points accrue
-- from rake generated (1 pt per whole chip of a player's rake contribution),
-- awarded idempotently as rake_records land. current_points = spendable balance;
-- lifetime_points drives tier. Accrual starts now (no history reconstruction).
-- Applied to production via Supabase MCP on 2026-07-29 (accrual verified live).

CREATE TABLE IF NOT EXISTS public.vip_points (
  user_id         uuid PRIMARY KEY,
  current_points  bigint NOT NULL DEFAULT 0,
  lifetime_points bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.vip_points ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vip_points_select_own ON public.vip_points;
CREATE POLICY vip_points_select_own ON public.vip_points FOR SELECT USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.vip_points_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  points      bigint NOT NULL,
  reason      text,
  source_type text NOT NULL DEFAULT 'rake',
  source_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_vip_points_ledger_user ON public.vip_points_ledger(user_id, created_at DESC);
ALTER TABLE public.vip_points_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vip_points_ledger_select_own ON public.vip_points_ledger;
CREATE POLICY vip_points_ledger_select_own ON public.vip_points_ledger FOR SELECT USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE k text; v text; pts bigint; uid uuid;
BEGIN
  IF NEW.player_contributions IS NULL OR jsonb_typeof(NEW.player_contributions) <> 'object' THEN
    RETURN NEW;
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.player_contributions) LOOP
    BEGIN uid := k::uuid; EXCEPTION WHEN others THEN CONTINUE; END;
    pts := floor(COALESCE(v::numeric, 0))::bigint;
    IF pts > 0 THEN
      INSERT INTO vip_points_ledger (user_id, points, reason, source_type, source_id)
      VALUES (uid, pts, 'Rake generated', 'rake', NEW.id)
      ON CONFLICT (user_id, source_type, source_id) DO NOTHING;
      IF FOUND THEN
        INSERT INTO vip_points (user_id, current_points, lifetime_points)
        VALUES (uid, pts, pts)
        ON CONFLICT (user_id) DO UPDATE SET
          current_points  = vip_points.current_points + pts,
          lifetime_points = vip_points.lifetime_points + pts,
          updated_at = now();
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_award_vip_points_from_rake ON public.rake_records;
CREATE TRIGGER trg_award_vip_points_from_rake
  AFTER INSERT ON public.rake_records
  FOR EACH ROW EXECUTE FUNCTION public.fn_award_vip_points_from_rake();

CREATE OR REPLACE FUNCTION public.fn_redeem_vip_points(p_cost bigint, p_reason text DEFAULT 'Reward redemption')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); v_bal bigint;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
  IF p_cost IS NULL OR p_cost <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_cost'); END IF;
  SELECT current_points INTO v_bal FROM vip_points WHERE user_id = v_uid FOR UPDATE;
  IF COALESCE(v_bal, 0) < p_cost THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_points', 'balance', COALESCE(v_bal,0));
  END IF;
  UPDATE vip_points SET current_points = current_points - p_cost, updated_at = now() WHERE user_id = v_uid;
  INSERT INTO vip_points_ledger (user_id, points, reason, source_type, source_id)
  VALUES (v_uid, -p_cost, p_reason, 'redeem', gen_random_uuid());
  RETURN jsonb_build_object('success', true, 'balance', COALESCE(v_bal,0) - p_cost);
END; $$;

GRANT EXECUTE ON FUNCTION public.fn_redeem_vip_points(bigint, text) TO authenticated, service_role;
