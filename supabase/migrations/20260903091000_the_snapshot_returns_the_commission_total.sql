-- THE SNAPSHOT RETURNS THE COMMISSION TOTAL.
--
-- fn_ca_rake_by_agent computes total_commission and ca_rake_snapshot was
-- dropping it on the floor: the per-agent column rendered while the club's own
-- bill came back null, which the panel correctly showed as absent. Found by
-- reading the payload rather than the code.
--
-- Rewritten against pg_get_functiondef rather than restating the body, so the
-- edit touches one key and nothing else can drift, and the anchor is asserted -
-- a reshuffle upstream fails this migration loudly instead of passing while
-- adding nothing.

DO $$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='ca_rake_snapshot';

  IF v_def IS NULL THEN
    RAISE NOTICE 'ca_rake_snapshot not present, nothing to wire';
    RETURN;
  END IF;

  IF v_def LIKE '%commission_total%' THEN
    RAISE NOTICE 'commission_total already returned';
    RETURN;
  END IF;

  -- Both return sites carry the breakdown envelope. Only the club scope can
  -- ever hold a commission total, but adding the key to both keeps the payload
  -- shape identical across scopes so the client never meets a missing property.
  v_new := replace(v_def,
    '''breakdown_offset'',v_off,',
    '''breakdown_offset'',v_off,''commission_total'',(v_pack->>''total_commission'')::numeric,');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'ca_rake_snapshot: breakdown_offset anchor not found';
  END IF;
  EXECUTE v_new;
  RAISE NOTICE 'commission_total wired through';
END $$;
