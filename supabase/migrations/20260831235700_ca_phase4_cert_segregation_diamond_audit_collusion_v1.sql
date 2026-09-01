-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:57:00 UTC on kuklfnapbkmacvwxktbh.

-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT PHASE 4: cert-account segregation, diamond supply audit,
-- collusion detection v1. Detection and reporting only - nothing here locks,
-- closes, freezes, or blocks anything.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 4A. cert/test account segregation ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_cert_accounts (
  user_id   uuid PRIMARY KEY,
  reason    text NOT NULL,
  tagged_at timestamptz NOT NULL DEFAULT now(),
  active    boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE public.ca_cert_accounts IS
  'Zero-drift phase 4: known cert/test/bot accounts, segregated in supply and revenue reporting. Registry rows plus the zero-UUID pattern (fn_ca_is_cert_account) identify the fleet even when harness accounts are recreated.';
ALTER TABLE public.ca_cert_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_cert_accounts FROM PUBLIC, anon, authenticated;

-- seed: the 85 zero-UUID seeded bot profiles (sequential ids, poker-themed
-- names, role user) - evidence in the 2026-08-31 phase-4 audit
INSERT INTO public.ca_cert_accounts (user_id, reason)
SELECT p.id, 'zero-UUID seeded bot profile (phase-4 sweep 2026-08-31)'
FROM public.profiles p
WHERE p.id::text LIKE '00000000-0000-0000-0000-%'
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_is_cert_account(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL AND (
    p_user_id::text LIKE '00000000-0000-0000-0000-%'
    OR EXISTS (SELECT 1 FROM public.ca_cert_accounts c
                WHERE c.user_id = p_user_id AND c.active)
  );
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_is_cert_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_cert_account(uuid) TO authenticated, service_role;

-- supply snapshot: break out cert-held chips as a REPORTING dimension. The
-- total formula is unchanged (cert chips are real chips inside the economy),
-- so snapshot comparability and the unexplained math are untouched.
ALTER TABLE public.ca_supply_snapshots
  ADD COLUMN IF NOT EXISTS cert_wallets numeric;

-- ── 4B. diamond supply audit ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_diamond_snapshots (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  taken_at         timestamptz NOT NULL DEFAULT now(),
  profile_diamonds numeric NOT NULL,
  wallet_diamonds  numeric NOT NULL,
  cert_diamonds    numeric NOT NULL,
  total            numeric NOT NULL,
  journaled_delta  numeric,
  delta_vs_prev    numeric,
  unexplained      numeric
);
COMMENT ON TABLE public.ca_diamond_snapshots IS
  'Zero-drift phase 4: hourly diamond supply baseline. total = profiles.diamonds + diamond_wallets.balance; journaled_delta = signed sum of diamond_transactions since the previous snapshot; unexplained = supply movement no journal row explains.';
ALTER TABLE public.ca_diamond_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_diamond_snapshots FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_snapshot()
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric;
  prev RECORD; v_journal numeric; v_unexplained numeric;
BEGIN
  SELECT COALESCE(sum(diamonds),0) INTO v_prof FROM profiles;
  SELECT COALESCE(sum(balance),0)  INTO v_wal  FROM diamond_wallets;
  SELECT COALESCE(sum(p.diamonds),0) INTO v_cert
    FROM profiles p WHERE public.fn_ca_is_cert_account(p.id);
  v_total := v_prof + v_wal;

  SELECT * INTO prev FROM public.ca_diamond_snapshots ORDER BY taken_at DESC LIMIT 1;
  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount),0) INTO v_journal
      FROM diamond_transactions WHERE created_at > prev.taken_at;
  END IF;

  INSERT INTO public.ca_diamond_snapshots
    (profile_diamonds, wallet_diamonds, cert_diamonds, total,
     journaled_delta, delta_vs_prev, unexplained)
  VALUES
    (v_prof, v_wal, v_cert, v_total, v_journal,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL THEN NULL
          ELSE v_total - prev.total - COALESCE(v_journal,0) END)
  RETURNING unexplained INTO v_unexplained;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 50 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_diamond_snapshot', 'ledger_imbalance',
      CASE WHEN abs(v_unexplained) > 5000 THEN 'critical' ELSE 'warning' END,
      'diamond-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained,
      prev.total + COALESCE(v_journal,0), v_total,
      'ledger', 'ca_diamond_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'diamond supply changed by ' || round(v_unexplained,2)
        || ' with no diamond_transactions row explaining it - a diamond writer is bypassing the journal',
      false, jsonb_build_object('profile_diamonds', v_prof, 'wallet_diamonds', v_wal));
  END IF;

  RETURN v_unexplained;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_snapshot() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-diamond-snapshot-hourly', '10 * * * *',
  $$SELECT public.fn_ca_diamond_snapshot()$$);

-- baseline row now, so the first scheduled run has a prev to diff against
SELECT public.fn_ca_diamond_snapshot();

-- ── 4C. collusion detection v1 (pairwise net-flow over hand transfers) ──────
CREATE TABLE IF NOT EXISTS public.ca_collusion_signals (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  window_days    integer NOT NULL,
  user_a         uuid NOT NULL,   -- net receiver
  user_b         uuid NOT NULL,   -- net sender
  hands_together integer NOT NULL,
  gross_flow     numeric NOT NULL,
  net_flow       numeric NOT NULL,
  direction_ratio numeric NOT NULL,
  both_cert      boolean NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.ca_collusion_signals IS
  'Zero-drift phase 4: v1 collusion signals. A row means the pair''s chip flow over the window was large, frequent, and one-directional - a signal for human review, never an automatic action.';
ALTER TABLE public.ca_collusion_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_collusion_signals FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_collusion_scan(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(p_days,1));
  r RECORD; v_flagged int := 0; v_scanned int := 0;
BEGIN
  FOR r IN
    WITH pairflow AS (
      SELECT LEAST(t.winner_id, t.loser_id)    AS ua,
             GREATEST(t.winner_id, t.loser_id) AS ub,
             count(*)                          AS hands_together,
             sum(t.amount)                     AS gross_flow,
             sum(CASE WHEN t.winner_id < t.loser_id THEN t.amount ELSE -t.amount END) AS net_to_ua
        FROM public.ca_hand_transfers t
       WHERE t.played_at > v_since
         AND t.winner_id IS NOT NULL AND t.loser_id IS NOT NULL
         AND t.amount > 0
       GROUP BY 1, 2
    )
    SELECT CASE WHEN net_to_ua >= 0 THEN ua ELSE ub END AS receiver,
           CASE WHEN net_to_ua >= 0 THEN ub ELSE ua END AS sender,
           hands_together, gross_flow, abs(net_to_ua) AS net_flow,
           round(abs(net_to_ua) / NULLIF(gross_flow, 0), 3) AS direction_ratio
      FROM pairflow
     WHERE hands_together >= 20
       AND abs(net_to_ua) >= 5000
       AND abs(net_to_ua) / NULLIF(gross_flow, 0) > 0.8
  LOOP
    v_scanned := v_scanned + 1;
    INSERT INTO public.ca_collusion_signals
      (window_days, user_a, user_b, hands_together, gross_flow, net_flow,
       direction_ratio, both_cert, detail)
    VALUES
      (p_days, r.receiver, r.sender, r.hands_together, r.gross_flow, r.net_flow,
       r.direction_ratio,
       public.fn_ca_is_cert_account(r.receiver) AND public.fn_ca_is_cert_account(r.sender),
       jsonb_build_object('since', v_since));
    v_flagged := v_flagged + 1;

    -- signal, never a page: info for cert pairs and moderate flows; warning
    -- (one push, per policy) only for a large real-account flow
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_collusion_scan', 'unknown',
      CASE WHEN r.net_flow >= 50000
              AND NOT (public.fn_ca_is_cert_account(r.receiver)
                       AND public.fn_ca_is_cert_account(r.sender))
           THEN 'warning' ELSE 'info' END,
      'collusion:' || r.receiver::text || ':' || r.sender::text || ':' || to_char(now(), 'IYYY-IW'),
      r.net_flow, NULL, NULL,
      'reporting', 'user', r.receiver, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'one-directional chip flow: ' || r.net_flow || ' chips over ' || r.hands_together
        || ' shared hands in ' || p_days || 'd (direction ratio ' || r.direction_ratio
        || ') - review the pair; no automatic action taken',
      true,
      jsonb_build_object('receiver', r.receiver, 'sender', r.sender,
                         'hands_together', r.hands_together,
                         'gross_flow', r.gross_flow, 'net_flow', r.net_flow,
                         'direction_ratio', r.direction_ratio));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'window_days', p_days,
                            'pairs_flagged', v_flagged);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_collusion_scan(integer) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-collusion-daily', '20 4 * * *',
  $$SELECT public.fn_ca_collusion_scan(7)$$);

-- ── guard inventory ─────────────────────────────────────────────────────────
INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
SELECT v.kind, v.a, v.b, v.note, true FROM (VALUES
 ('cron', 'ca-diamond-snapshot-hourly', NULL, 'hourly diamond supply baseline + unexplained-drift alarm'),
 ('cron', 'ca-collusion-daily', NULL, 'daily pairwise net-flow collusion scan (signals only, no action')
) AS v(kind, a, b, note)
WHERE NOT EXISTS (SELECT 1 FROM public.ca_guard_inventory g WHERE g.object_a = v.a);;
