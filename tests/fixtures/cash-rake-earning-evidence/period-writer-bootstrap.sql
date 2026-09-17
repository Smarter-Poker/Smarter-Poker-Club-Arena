CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE public.accounting_cash_accrual_cutover (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 starts_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.accounting_cash_accrual_batches (
 rake_record_id uuid PRIMARY KEY REFERENCES public.rake_records(id),
 hand_id uuid NOT NULL UNIQUE,
 earned_at timestamptz NOT NULL,
 source_fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN('accrued','legacy_unverified')),
 plan jsonb,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status='accrued')=(plan IS NOT NULL))
);
CREATE INDEX accounting_cash_accrual_batches_earned ON public.accounting_cash_accrual_batches(earned_at,status);
CREATE TABLE public.accounting_cash_rake_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 rake_record_id uuid NOT NULL REFERENCES public.accounting_cash_accrual_batches(rake_record_id),
 player_id uuid NOT NULL REFERENCES auth.users(id),
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 union_id uuid,
 coordinator_union_id uuid,
 earned_at timestamptz NOT NULL,
 rake_credit numeric NOT NULL CHECK(rake_credit>=0 AND rake_credit=round(rake_credit,2) AND rake_credit::text NOT IN('NaN','Infinity','-Infinity')),
 contract jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(rake_record_id,player_id)
);
CREATE INDEX accounting_cash_rake_sources_period ON public.accounting_cash_rake_sources(club_id,earned_at,player_id);
ALTER TABLE public.accounting_cash_accrual_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_cash_accrual_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_cash_rake_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_cash_accrual_cutover,public.accounting_cash_accrual_batches,public.accounting_cash_rake_sources FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.accounting_cash_accrual_cutover,public.accounting_cash_accrual_batches,public.accounting_cash_rake_sources TO service_role;
CREATE TRIGGER accounting_cash_cutover_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_accrual_cutover FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_cutover FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_batch_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_accrual_batches FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_batch_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_batches FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_source_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_rake_sources FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_source_no_truncate BEFORE TRUNCATE ON public.accounting_cash_rake_sources FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();


INSERT INTO public.accounting_cash_accrual_cutover(singleton,starts_at) VALUES(true,'2026-01-01Z');
ALTER TABLE public.rakeback_periods ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.rakeback_periods ADD COLUMN rakeback_rate numeric(5,4), ADD COLUMN rakeback_earned numeric(15,2),ADD COLUMN total_rake_paid numeric(15,2);
ALTER TABLE public.rakeback_periods ADD UNIQUE(user_id,club_id,period_start,period_end);

CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_written integer := 0; v_day date; v_days integer := 0; v_rebuilt integer := 0;
  v_res jsonb;
BEGIN
  IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('written', 0, 'error', 'missing params');
  END IF;

  v_day := p_period_start;
  WHILE v_day <= p_period_end LOOP
    v_res := public.fn_rakeback_recompute_day(p_club_id, v_day, false);
    v_days := v_days + 1;
    IF COALESCE((v_res->>'fresh')::boolean, false) IS NOT TRUE THEN
      v_rebuilt := v_rebuilt + 1;
    END IF;
    v_day := v_day + 1;
  END LOOP;

  WITH totals AS (
    SELECT d.user_id, (SUM(d.cents)::numeric / 100) AS total_rake
      FROM rakeback_daily_user d
     WHERE d.club_id = p_club_id
       AND d.day >= p_period_start AND d.day <= p_period_end
       AND (p_user_ids IS NULL OR d.user_id = ANY (p_user_ids))
     GROUP BY d.user_id
  ), eligible AS (
    SELECT t.user_id, t.total_rake,
           public.fn_player_rakeback_rate(t.user_id, p_club_id, t.total_rake) AS rate
      FROM totals t
  ), ins AS (
    INSERT INTO rakeback_periods (
      user_id, club_id, period_start, period_end,
      rake_generated, rakeback_rate, rakeback_earned, rakeback_amount,
      total_rake_paid, status
    )
    SELECT e.user_id, p_club_id, p_period_start, p_period_end,
           round(e.total_rake, 2), e.rate,
           round(e.total_rake * e.rate, 2), round(e.total_rake * e.rate, 2),
           round(e.total_rake, 2), 'pending'
      FROM eligible e
     WHERE e.rate > 0
    ON CONFLICT (user_id, club_id, period_start, period_end) DO UPDATE
      SET period_end      = EXCLUDED.period_end,
          rake_generated  = EXCLUDED.rake_generated,
          rakeback_rate   = EXCLUDED.rakeback_rate,
          rakeback_earned = EXCLUDED.rakeback_earned,
          rakeback_amount = EXCLUDED.rakeback_amount,
          total_rake_paid = EXCLUDED.total_rake_paid
      WHERE rakeback_periods.status = 'pending'
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM ins;

  RETURN jsonb_build_object('written', v_written, 'days_scanned', v_days,
                            'days_rebuilt', v_rebuilt);
END $function$
;

CREATE INDEX fixture_rake_attribution_record ON rake_attributions(rake_record_id);
CREATE INDEX fixture_rake_records_created ON rake_records(created_at,id);

CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
