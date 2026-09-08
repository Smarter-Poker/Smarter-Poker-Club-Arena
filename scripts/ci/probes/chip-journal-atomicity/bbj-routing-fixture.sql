ALTER TABLE bbj_pools ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE bbj_pools ADD COLUMN union_id uuid,ADD COLUMN pool_amount numeric DEFAULT 0,
 ADD COLUMN status text DEFAULT 'active',ADD COLUMN created_at timestamptz DEFAULT now();
CREATE UNIQUE INDEX bbj_probe_club_pool ON bbj_pools(club_id);
CREATE UNIQUE INDEX bbj_probe_union_pool ON bbj_pools(union_id) WHERE club_id IS NULL;
CREATE OR REPLACE FUNCTION public.fn_resolve_bbj_pool(p_table_id uuid, p_club_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid; v_union uuid; v_pool uuid; v_private boolean := false;
BEGIN
  SELECT t.club_id, t.union_id, COALESCE(t.is_private, false)
    INTO v_club, v_union, v_private
    FROM public.tables t WHERE t.id = p_table_id;
  v_club := COALESCE(v_club, p_club_id);

  -- UNION LAW: a private club game's BBJ never touches the union pool.
  IF v_private THEN
    v_union := NULL;
  ELSIF v_union IS NULL AND v_club IS NOT NULL THEN
    SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_club;
  END IF;

  IF v_union IS NOT NULL THEN
    SELECT id INTO v_pool FROM public.bbj_pools
     WHERE club_id IS NULL AND union_id = v_union AND status = 'active';
    IF v_pool IS NULL THEN
      INSERT INTO public.bbj_pools (club_id, union_id, pool_amount, main_balance, backup_balance, promo_balance, hands_contributed, status)
      VALUES (NULL, v_union, 0, 0, 0, 0, 0, 'active')
      ON CONFLICT DO NOTHING;
      SELECT id INTO v_pool FROM public.bbj_pools
       WHERE club_id IS NULL AND union_id = v_union AND status = 'active';
    END IF;
  ELSIF v_club IS NOT NULL THEN
    SELECT id INTO v_pool FROM public.bbj_pools
     WHERE club_id = v_club AND status = 'active' ORDER BY created_at LIMIT 1;
    IF v_pool IS NULL THEN
      INSERT INTO public.bbj_pools (club_id, pool_amount, main_balance, backup_balance, promo_balance, hands_contributed, status)
      VALUES (v_club, 0, 0, 0, 0, 0, 'active')
      ON CONFLICT DO NOTHING;
      SELECT id INTO v_pool FROM public.bbj_pools
       WHERE club_id = v_club AND status = 'active' ORDER BY created_at LIMIT 1;
    END IF;
    IF v_pool IS NULL THEN
      -- Club pool exists but was retired when its balance was swept to the
      -- union. Revive it (at its current zero balance) for private-game BBJ.
      UPDATE public.bbj_pools SET status = 'active', updated_at = now()
       WHERE club_id = v_club
      RETURNING id INTO v_pool;
    END IF;
  ELSE
    RAISE EXCEPTION 'BBJ contribution with no resolvable club or union (table %)', p_table_id;
  END IF;

  RETURN v_pool;
END;
$function$
;
