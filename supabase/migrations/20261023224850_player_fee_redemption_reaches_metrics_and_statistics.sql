-- 20261023224850_player_fee_redemption_reaches_metrics_and_statistics.sql
-- Owner-directed reporting-only lifetime VIP redemption; no money movement.
-- @live-proof: (SELECT count(*)=1 FROM smarter_private.player_fee_redemptions WHERE operation_key='woowoo-lifetime-vip-20261023' AND amount_cents=32233) AND position('player_fee_redemptions' IN pg_get_functiondef('public.ca_club_member_fee_totals(uuid,date,date,uuid)'::regprocedure))>0

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

-- A reporting-only redemption, not a refund or a change to any settled hand,
-- rake attribution, accounting batch, commission, rakeback or wallet balance.
-- The owner already traded 322.33 of WooWoo's generated rake for lifetime VIP
-- on October 23. Only player_stats was reduced then; report readers bypass it.
-- Retain that exact fixed reduction once, including future hands at full value.
CREATE TABLE smarter_private.player_fee_redemptions (
  operation_key text PRIMARY KEY,
  club_id uuid NOT NULL,
  user_id uuid NOT NULL,
  effective_on date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(reason) >= 40),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smarter_private.player_fee_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.player_fee_redemptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON smarter_private.player_fee_redemptions TO service_role;

INSERT INTO smarter_private.player_fee_redemptions
  (operation_key,club_id,user_id,effective_on,amount_cents,reason)
VALUES
  ('woowoo-lifetime-vip-20261023',
   'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
   '69f2cefa-017d-49f3-ac3e-61505633747c','2026-10-23',32233,
   'Owner-directed lifetime VIP trade: fixed half of the original 644.66 generated-rake counter, already reduced to 322.33 on October 23. Extend the same redemption to reports; no refund and no change to settled financial records.');

-- The same function serves Cash Fees, member statistics, roster and exports.
DO $patch$
DECLARE body text;
BEGIN
  body := pg_get_functiondef('public.ca_club_member_fee_totals(uuid,date,date,uuid)'::regprocedure);
  IF strpos(body,'SELECT d.user_id AS uid, sum(d.rake_cents)::numeric / 100 AS fees') = 0
     OR strpos(body,'GROUP BY d.user_id') = 0 THEN
    RAISE EXCEPTION 'fee totals source changed; review before installation';
  END IF;
  body := replace(body,
    'FROM public.ca_club_rake_daily_user d, bounds b',
    'FROM (SELECT club_id,user_id,day,rake_cents FROM public.ca_club_rake_daily_user
       UNION ALL
       SELECT club_id,user_id,effective_on,-amount_cents
         FROM smarter_private.player_fee_redemptions) d, bounds b');
  IF strpos(body,'smarter_private.player_fee_redemptions') = 0 THEN
    RAISE EXCEPTION 'fee redemption was not wired';
  END IF;
  EXECUTE body;
END;
$patch$;

-- Keep the original access checks, funded-club resolution and raw hand facts.
-- Only chip rake summary totals and their chip-denominated rates are redeemed.
DO $patch$
DECLARE body text; sig text; adjustment text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.ca_player_rake_stats(uuid,integer,text)',
    'public.ca_player_rake_stats_by_club(uuid,integer,text,uuid)'
  ] LOOP
    body := pg_get_functiondef(sig::regprocedure);
    IF strpos(body,'v_fee_redemption') > 0 THEN
      RAISE EXCEPTION 'redemption already wired in %',sig;
    END IF;
    body := replace(body,'DECLARE','DECLARE v_fee_redemption numeric := 0;');
    adjustment := $code$
  SELECT coalesce(sum(r.amount_cents),0)::numeric / 100
    INTO v_fee_redemption
    FROM smarter_private.player_fee_redemptions r
   WHERE r.user_id=v_uid AND p_asset='chips'
     AND (p_days IS NULL OR r.effective_on >=
       (now()-make_interval(days=>greatest(p_days,1)))::date)
     %CLUB%;
  v_rake := v_rake - v_fee_redemption;
  RETURN jsonb_build_object('fee_redemption',v_fee_redemption,
    'gross_rake_paid',round(v_rake + v_fee_redemption,2),$code$;
    adjustment := replace(adjustment,'%CLUB%',
      CASE WHEN sig LIKE '%by_club%' THEN 'AND r.club_id=p_club_id' ELSE '' END);
    IF sig LIKE '%by_club%' THEN
      adjustment := replace(adjustment,'greatest(p_days,1)','least(greatest(p_days,1),3650)');
    END IF;
    -- The non-club function also has an early unauthenticated zero response;
    -- replace only the final return immediately after the source query.
    IF sig LIKE '%by_club%' THEN
      IF strpos(body,'  RETURN jsonb_build_object(''contract_version'',2,') = 0 THEN
        RAISE EXCEPTION 'club rake return changed';
      END IF;
      body := replace(body,'  RETURN jsonb_build_object(''contract_version'',2,',
        adjustment || '''contract_version'',2,');
    ELSE
      IF strpos(body,'  RETURN jsonb_build_object(' || chr(10) || '    ''hands'', v_hands,') = 0 THEN
        RAISE EXCEPTION 'rake return changed';
      END IF;
      body := replace(body,'  RETURN jsonb_build_object(' || chr(10) || '    ''hands'', v_hands,',
        adjustment || chr(10) || '    ''hands'', v_hands,');
    END IF;
    EXECUTE body;
  END LOOP;
END;
$patch$;
COMMIT;
