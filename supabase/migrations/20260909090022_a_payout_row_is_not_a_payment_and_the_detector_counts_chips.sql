DO $mig$
DECLARE v_src text; v_new text; v_n int;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* A PAYOUT ROW IS NOT A PAYMENT.                                      */
  /*                                                                     */
  /* The open critical said "32 prize obligation(s) in the last 24h were  */
  /* settled by more than one repair path (1001.00 chips paid twice)".    */
  /* Not one chip was paid twice. Checked against the events themselves:  */
  /*                                                                     */
  /*   Union Grand Championship  guarantee 2500.00  paid 2040 + 460 = 2500 */
  /*   Union Mystery Bounty       guarantee  800.00  paid  450 + 350 =  800 */
  /*   Evening Mystery Bounty     guarantee  400.00  paid  225 + 175 =  400 */
  /*   Turbo Tuesday Opener       guarantee  250.00  paid  234 +  16 =  250 */
  /*                                                                     */
  /* Every event paid its guarantee to the chip. What is doubled is the   */
  /* RECORD: migration "the_authoritative_record_must_show_every_prize_   */
  /* paid" wrote 32 tournament_payouts rows under source overlay_backpay  */
  /* directly, without going through fn_credit_and_log. Those rows spent  */
  /* no idempotency key, left no chip_ledger leg, and carry a NULL        */
  /* balance_after that the ordinary credit path can never produce. The   */
  /* reconciler then could not see the top-up in its source allow-list,   */
  /* computed the shortfall again, and paid it - for real, once, through  */
  /* the audited path. The paper says it happened twice; the money        */
  /* happened once, and correctly.                                        */
  /*                                                                     */
  /* So this detector counts payments, and a payment is a registered      */
  /* credit: wallet_credit_idempotency holds the key that was spent to    */
  /* move the chips. A row nobody spent a key for is a claim, not a       */
  /* payment, and it belongs to the detector added below - not to a       */
  /* critical that says players were overpaid when they were not.         */
  /* =================================================================== */
  CREATE OR REPLACE FUNCTION public.fn_tournament_double_paid_obligations(p_hours integer DEFAULT 24)
   RETURNS TABLE(tournament_id uuid, tournament_name text, player_id uuid, finish_position integer, amount numeric, payments bigint, sources text, excess_chips numeric, last_paid_at timestamp with time zone)
   LANGUAGE sql
   STABLE SECURITY DEFINER
   SET search_path TO 'public', 'pg_temp'
  AS $function$
    WITH prize_side AS (
      -- The prize ladder and the three paths that top it up. Bounty sources are
      -- deliberately absent: repeated equal bounty payments are correct.
      SELECT p.tournament_id, p.user_id, p.position, p.amount, p.source, p.paid_at
        FROM public.tournament_payouts p
        JOIN public.tournaments t ON t.id = p.tournament_id
       WHERE p.source IN ('structure', 'reconcile', 'overlay_backpay', 'spin_backpay')
         AND p.user_id IS NOT NULL
         AND t.ended_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))
         -- A PAYMENT IS A REGISTERED CREDIT. The key in wallet_credit_idempotency
         -- is what fn_credit_player_wallet_once spends to move the chips; a
         -- payout row without one records a payment that never happened, and
         -- counting it as a second payment accuses a player of being overpaid
         -- with money they never received.
         AND p.idempotency_key IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.wallet_credit_idempotency w
                      WHERE w.key = p.idempotency_key)
    )
    SELECT ps.tournament_id,
           t.name,
           ps.user_id,
           ps.position,
           ps.amount,
           count(*)                                              AS payments,
           string_agg(DISTINCT ps.source, '+' ORDER BY ps.source) AS sources,
           round(ps.amount * (count(*) - 1), 2)                  AS excess_chips,
           max(ps.paid_at)                                       AS last_paid_at
      FROM prize_side ps
      JOIN public.tournaments t ON t.id = ps.tournament_id
     GROUP BY ps.tournament_id, t.name, ps.user_id, ps.position, ps.amount
    HAVING count(*) > 1
       -- More than one DISTINCT source is what makes it two repairers rather
       -- than one path legitimately paying an amount that happens to repeat.
       AND count(DISTINCT ps.source) > 1
     ORDER BY 8 DESC;
  $function$;

  /* =================================================================== */
  /* THE QUESTION THE OLD DETECTOR WAS ACTUALLY ANSWERING GETS ITS OWN.  */
  /*                                                                     */
  /* Narrowing the detector above cannot mean nobody looks at the rows it */
  /* stopped counting. What is true about them is not "a player was paid  */
  /* twice" but "the authoritative record claims a payment the journal    */
  /* never made", and that is a different finding with a different fix.   */
  /*                                                                     */
  /* Current inventory, measured before writing this:                     */
  /*   overlay_backpay  173 rows  14,596.70 chips  all on 2026-09-02      */
  /*   structure      1,293 rows  14,863.11 chips  2026-04-14 onward,     */
  /*                             960 of them predating the credit register */
  /* satellite_seat is excluded: its prize is a seat, not chips, so no    */
  /* wallet credit is ever spent for one.                                 */
  /* =================================================================== */
  CREATE OR REPLACE FUNCTION public.fn_ca_payout_rows_without_money(p_days integer DEFAULT 30)
   RETURNS TABLE(tournament_id uuid, tournament_name text, player_id uuid, finish_position integer,
                 source text, amount numeric, paid_at timestamp with time zone, idempotency_key text)
   LANGUAGE sql
   STABLE SECURITY DEFINER
   SET search_path TO 'public', 'pg_temp'
  AS $function$
    SELECT p.tournament_id, t.name, p.user_id, p.position, p.source, p.amount, p.paid_at, p.idempotency_key
      FROM public.tournament_payouts p
      JOIN public.tournaments t ON t.id = p.tournament_id
     WHERE p.source IN ('structure', 'reconcile', 'overlay_backpay', 'spin_backpay',
                        'hu_shortfall', 'late_reg_adjustment', 'final_table_deal', 'bubble_protection')
       AND p.user_id IS NOT NULL
       AND p.amount > 0
       AND p.paid_at > now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 1))
       AND p.paid_at > (SELECT min(created_at) FROM public.wallet_credit_idempotency)
       AND (p.idempotency_key IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency w
                            WHERE w.key = p.idempotency_key))
     ORDER BY p.paid_at DESC;
  $function$;

  /* the sweep must run it, or it is a check nobody sees */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep';
  IF position($old$      ('fn_union_overload_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_overload_check() limit 20) t',
       'warning')$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'sweep anchor row not found';
  END IF;
  v_new := replace(v_src,
$old$      ('fn_union_overload_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_overload_check() limit 20) t',
       'warning')$old$,
$old$      ('fn_union_overload_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_overload_check() limit 20) t',
       'warning'),
      ('fn_ca_payout_rows_without_money',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_payout_rows_without_money(3) limit 20) t',
       'warning')$old$);
  EXECUTE v_new;

  /* -------- post-apply -------- */
  SELECT count(*) INTO v_n FROM public.fn_tournament_double_paid_obligations(240);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the double-paid detector still reports % finding(s) after counting registered credits only', v_n;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep';
  IF position('fn_ca_payout_rows_without_money' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the sweep did not learn the replacement check';
  END IF;
END
$mig$;
