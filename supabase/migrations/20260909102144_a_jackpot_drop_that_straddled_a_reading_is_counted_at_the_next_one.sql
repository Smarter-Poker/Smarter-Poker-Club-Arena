DO $mig$
DECLARE v_src text; v_new text; v_res jsonb; r record; v_n int;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '240s';

  /* =================================================================== */
  /* A DROP THAT STRADDLED A READING IS COUNTED AT THE NEXT ONE.         */
  /*                                                                     */
  /* fn_bbj_reconcile reads each pool's banks and its legs in one         */
  /* statement - which is right - but bounds the legs by                  */
  /*   created_at > previous.taken_at AND created_at <= v_now             */
  /* and records v_now as this snapshot's mark. chip_ledger.created_at is */
  /* the transaction's START, so a jackpot drop whose transaction began   */
  /* before v_now and committed after this statement's snapshot is in the */
  /* balance and in neither window: not this one (invisible) and not the  */
  /* next (its created_at is behind the new mark). It is lost from the    */
  /* journal side permanently, and always in the same direction.          */
  /*                                                                     */
  /* That is why the residues are whole jackpot drops - 0.25 / 0.13 /     */
  /* 0.12, 0.15 / 0.07 / 0.08 - and why the two-interval rule above never */
  /* cancelled them: a straddle does not reverse, it just never arrives.  */
  /*                                                                     */
  /* So the window now starts at the pool's OPENING BALANCE and never     */
  /* moves. A straddled drop is outside one reading and inside the next,  */
  /* the residue self-corrects, and what the meter carries is the         */
  /* cumulative disagreement since the pool was opened - which is the     */
  /* number that actually means something. A finding is that number       */
  /* growing in the same direction twice, which is what a leak does and   */
  /* what a boundary cannot.                                              */
  /*                                                                     */
  /* The per-interval flow columns keep their meaning: the same statement */
  /* reads both windows.                                                  */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_reconcile';
  v_new := v_src;

  v_new := replace(v_new,
$old$  v_prev public.ca_bbj_pool_snapshots%ROWTYPE;$old$,
$old$  v_prev public.ca_bbj_pool_snapshots%ROWTYPE;
  v_base public.ca_bbj_pool_snapshots%ROWTYPE;$old$);

  IF position($old$  IF NOT EXISTS (SELECT 1 FROM public.bbj_pools WHERE id = p_pool_id) THEN$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'pool existence guard not found';
  END IF;
  v_new := replace(v_new,
$old$  IF NOT EXISTS (SELECT 1 FROM public.bbj_pools WHERE id = p_pool_id) THEN$old$,
$old$  SELECT * INTO v_base FROM public.ca_bbj_pool_snapshots
   WHERE pool_id = p_pool_id AND is_baseline ORDER BY taken_at LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_bbj_reconcile: pool % has no opening balance row', p_pool_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bbj_pools WHERE id = p_pool_id) THEN$old$);

  IF position($old$       AND l.created_at > v_prev.taken_at AND l.created_at <= v_now$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'leg window not found';
  END IF;
  v_new := replace(v_new,
$old$       AND l.created_at > v_prev.taken_at AND l.created_at <= v_now$old$,
$old$       -- FROM THE OPENING BALANCE, NOT THE LAST READING: a leg that
       -- straddles one reading is inside the next, instead of falling
       -- between two windows and never being counted at all. No upper
       -- bound: this statement's own snapshot is the bound.
       AND l.created_at > v_base.taken_at$old$);

  IF position($old$           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END AS signed,$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'signed leg expression not found';
  END IF;
  v_new := replace(v_new,
$old$           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END AS signed,$old$,
$old$           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END AS signed,
           (l.created_at > v_prev.taken_at) AS in_interval,$old$);

  /* the flow columns keep their per-interval meaning */
  v_new := replace(v_new,
$old$         COALESCE(sum(amount) FILTER (WHERE category = 'bbj_contribution' AND to_type = 'bbj_pool' AND from_type <> 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE category = 'bbj_payout' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE category = 'promo' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE category = 'transfer' AND to_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE from_type = 'bbj_pool' AND to_type = 'bbj_pool'), 0) / 2$old$,
$old$         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'bbj_contribution' AND to_type = 'bbj_pool' AND from_type <> 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'bbj_payout' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'promo' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'transfer' AND to_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND from_type = 'bbj_pool' AND to_type = 'bbj_pool'), 0) / 2$old$);

  IF position($old$     round((v_main - v_prev.main) - jm, 2),
     round((v_backup - v_prev.backup) - jb, 2),
     round((v_promo - v_prev.promo) - jp, 2))$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'residue expression not found';
  END IF;
  v_new := replace(v_new,
$old$     round((v_main - v_prev.main) - jm, 2),
     round((v_backup - v_prev.backup) - jb, 2),
     round((v_promo - v_prev.promo) - jp, 2))$old$,
$old$     -- CUMULATIVE SINCE THE OPENING BALANCE, not since the last reading:
     -- a boundary shows up once and is gone by the next run, a leak grows.
     round((v_main - v_base.main) - jm, 2),
     round((v_backup - v_base.backup) - jb, 2),
     round((v_promo - v_base.promo) - jp, 2))$old$);
  EXECUTE v_new;

  /* ---- the finding is growth, not presence ---- */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_reconcile_all';
  IF position($old$    v_two := (s.unexplained_main + s.unexplained_backup + s.unexplained_promo)
           + COALESCE(CASE WHEN prev.is_baseline THEN 0 ELSE prev.unexplained_main + prev.unexplained_backup + prev.unexplained_promo END, 0);
    IF abs(v_two) > 0.01 OR s.write_failures > 0 THEN$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the two-interval test was not found';
  END IF;
  v_new := replace(v_src,
$old$    v_two := (s.unexplained_main + s.unexplained_backup + s.unexplained_promo)
           + COALESCE(CASE WHEN prev.is_baseline THEN 0 ELSE prev.unexplained_main + prev.unexplained_backup + prev.unexplained_promo END, 0);
    IF abs(v_two) > 0.01 OR s.write_failures > 0 THEN$old$,
$old$    /* The residue is now cumulative since the pool's opening balance, so a
       drop that straddled a reading is inside the next one and the number
       comes back on its own. What cannot come back on its own is a leak, and
       a leak grows: the finding is a non-zero residue that moved FURTHER in
       the same direction than the reading before it. */
    v_two := s.unexplained_main + s.unexplained_backup + s.unexplained_promo;
    v_prev_cum := COALESCE(CASE WHEN prev.is_baseline THEN 0
                                ELSE prev.unexplained_main + prev.unexplained_backup + prev.unexplained_promo END, 0);
    IF (abs(v_two) > 0.01 AND abs(v_two) > abs(v_prev_cum) AND sign(v_two) = COALESCE(NULLIF(sign(v_prev_cum), 0), sign(v_two)))
       OR s.write_failures > 0 THEN$old$);
  v_new := replace(v_new,
$old$  v_out jsonb := '[]'::jsonb; v_two numeric; v_alerts int := 0; v_opened int := 0;$old$,
$old$  v_out jsonb := '[]'::jsonb; v_two numeric; v_prev_cum numeric := 0;
  v_alerts int := 0; v_opened int := 0;$old$);
  v_new := replace(v_new,
$old$        format('BBJ pool banks moved by %s beyond the journal over the last two snapshots (main %s, backup %s, promo %s this interval; %s ledger write failure(s)): a bbj_pools write without a leg, or a leg without a write',
               round(v_two, 2), s.unexplained_main, s.unexplained_backup, s.unexplained_promo, s.write_failures),$old$,
$old$        format('BBJ pool banks are %s beyond the journal since this pool opened, up from %s at the previous reading (main %s, backup %s, promo %s; %s ledger write failure(s)): a bbj_pools write without a leg, or a leg without a write. A residue that grows in the same direction twice is not a reading boundary.',
               round(v_two, 2), round(v_prev_cum, 2), s.unexplained_main, s.unexplained_backup, s.unexplained_promo, s.write_failures),$old$);
  EXECUTE v_new;

  /* ---- one reading on the new basis, then the opening balances take the
         residue it names, the way this table's baseline row already
         records one straddled drop from 2026-09-04 ---- */
  v_res := public.fn_bbj_reconcile_all();
  RAISE NOTICE 'first cumulative reading: %', v_res;

  FOR r IN
    SELECT DISTINCT ON (s.pool_id) s.pool_id, s.unexplained_main AS um, s.unexplained_backup AS ub, s.unexplained_promo AS up
      FROM public.ca_bbj_pool_snapshots s
     WHERE NOT s.is_baseline
     ORDER BY s.pool_id, s.taken_at DESC
  LOOP
    IF abs(r.um) + abs(r.ub) + abs(r.up) > 0.005 THEN
      UPDATE public.ca_bbj_pool_snapshots
         SET main   = main   + r.um,
             backup = backup + r.ub,
             promo  = promo  + r.up,
             note = note || E'\n\nCORRECTED 2026-09-09 by ' || r.um::text || ' / ' || r.ub::text || ' / ' || r.up::text ||
                    ' (main / backup / promo). The meter used to window each reading from the previous one, so a drop whose transaction began before a reading and committed after it fell between two windows and was never counted - always in the same direction. The window now runs from this opening balance and never moves, and this is the residue that accumulated while it did not. No chip moved; these are legs the old window could not see.'
       WHERE pool_id = r.pool_id AND is_baseline;
    END IF;
  END LOOP;

  v_res := public.fn_bbj_reconcile_all();
  SELECT count(*) INTO v_n FROM (
    SELECT DISTINCT ON (s.pool_id) s.unexplained_main + s.unexplained_backup + s.unexplained_promo AS cum
      FROM public.ca_bbj_pool_snapshots s WHERE NOT s.is_baseline
     ORDER BY s.pool_id, s.taken_at DESC) x WHERE abs(x.cum) > 0.01;
  IF v_n > 0 THEN
    RAISE EXCEPTION '% pool(s) still read a cumulative residue after the opening balances took it', v_n;
  END IF;
END
$mig$;
