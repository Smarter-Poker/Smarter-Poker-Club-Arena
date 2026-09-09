DO $mig$
DECLARE v_src text; v_new text; v_n int; v_detail text;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* 1. A CLOSED EPISODE AGES OUT.                                       */
  /*                                                                     */
  /* fn_chip_integrity_report's ledger_write_failures arm counted         */
  /* ca_ledger_write_failures with NO time bound, so once a row landed    */
  /* the check was critical forever. It reported 122; six of those are    */
  /* from the last 48 hours and the rest span 2026-09-01 to 2026-09-08.   */
  /* 104 of them are the autoledger's own journal write being refused     */
  /* during the :55-:00 maintenance freeze - and fn_ca_autoledger         */
  /* re-raises, which aborts the enclosing chip movement, so those are    */
  /* attempts that failed whole rather than balance changes left          */
  /* unaudited. The six that remain are 0.68, 0.25, -3.00, 0.15, 0.15 and */
  /* 2.10 chips of lock-timeout and freeze refusals. The rows stay in     */
  /* ca_ledger_write_failures for good; what changes is that the check    */
  /* can now read ok again once an episode stops.                         */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_chip_integrity_report';
  IF position($old$    FROM public.ca_ledger_write_failures f
   WHERE NOT ($old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'ledger_write_failures arm not found';
  END IF;
  v_new := replace(v_src,
$old$    FROM public.ca_ledger_write_failures f
   WHERE NOT ($old$,
$old$    FROM public.ca_ledger_write_failures f
   WHERE f.occurred_at > now() - interval '48 hours'
     AND NOT ($old$);
  v_new := replace(v_new,
$old$  detail     := format('%s swallowed ledger write(s) (idempotency refusals of an already-posted grant excluded).', v_fail);$old$,
$old$  detail     := format('%s swallowed ledger write(s) in the last 48 hours (idempotency refusals of an already-posted grant excluded). Older ones stay in ca_ledger_write_failures; a closed episode must be able to age out or this check can never read ok again.', v_fail);$old$);
  EXECUTE v_new;

  /* =================================================================== */
  /* 2. A PLAYER WHO NEVER SAT DOWN HOLDS NO CHIPS.                      */
  /*                                                                     */
  /* fn_tournament_chip_conservation_check multiplies EVERY registrant by */
  /* the starting stack and compares against the chips on open seats. The */
  /* 06:00 freeroll has 391 registrants and 116 of them never took a      */
  /* seat - 30% no-shows - so the expected figure was inflated by         */
  /* 580,000 chips that were never dealt. Counting only players who have  */
  /* actually been seated in this event asks the question the check       */
  /* means to ask.                                                        */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_tournament_chip_conservation_check';
  IF position($old$           (SELECT count(*) FROM tournament_players tp
             WHERE tp.tournament_id = t.id) AS players,$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'players subquery not found';
  END IF;
  v_new := replace(v_src,
$old$           (SELECT count(*) FROM tournament_players tp
             WHERE tp.tournament_id = t.id) AS players,$old$,
$old$           /* SEATED, NOT MERELY REGISTERED (2026-09-09). A no-show was
              never dealt a stack, so counting them multiplies the expected
              chips by people who are not at the table. */
           (SELECT count(*) FROM tournament_players tp
             WHERE tp.tournament_id = t.id
               AND EXISTS (SELECT 1 FROM table_seats ts2
                             JOIN tables tb2 ON tb2.id = ts2.table_id
                            WHERE tb2.tournament_id = t.id
                              AND ts2.user_id = tp.user_id)) AS players,$old$);
  EXECUTE v_new;

  /* =================================================================== */
  /* 3. A FUNCTION THAT TOUCHES NO TABLE CANNOT LEAK MONEY.              */
  /*                                                                     */
  /* fn_anon_exposure_check matches every function whose NAME looks       */
  /* financial and calls it critically exposed. Three qualify today and   */
  /* none can move or read a chip: fn_union_prev_week_start is IMMUTABLE  */
  /* date arithmetic and the sibling of fn_union_week_start, already on   */
  /* the list; fn_union_slugify is IMMUTABLE string transformation;       */
  /* fn_union_active_player_counts is a STABLE lobby headcount, not       */
  /* SECURITY DEFINER, showing what the signed-out lobby already shows.   */
  /* A critical that fires on a name rather than a capability is one      */
  /* people learn to skip.                                                */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_anon_exposure_check';
  IF position($old$           'fn_union_oversees_club',
           'fn_tournament_entry_split',
           'fn_union_week_start')$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'anon allowlist not found';
  END IF;
  v_new := replace(v_src,
$old$           'fn_union_oversees_club',
           'fn_tournament_entry_split',
           'fn_union_week_start')$old$,
$old$           'fn_union_oversees_club',
           'fn_tournament_entry_split',
           'fn_union_week_start',
           -- IMMUTABLE date arithmetic, the sibling of fn_union_week_start
           'fn_union_prev_week_start',
           -- IMMUTABLE string transformation, reads nothing
           'fn_union_slugify',
           -- STABLE lobby headcount, not SECURITY DEFINER; the same numbers
           -- the signed-out lobby already shows
           'fn_union_active_player_counts')$old$);
  EXECUTE v_new;

  /* =================================================================== */
  /* 4. A MAINTENANCE THE PLATFORM SCHEDULES FOR ITSELF IS NOT A BYPASS. */
  /*                                                                     */
  /* fn_ca_journal_append_only files a warning every time a permitted     */
  /* maintenance touches a journal. The certification fleet clears its    */
  /* own diamond journal hourly under app.ledger_maintenance =            */
  /* 'cert-cleanup:<id>', the rows are preserved whole in                 */
  /* ca_ledger_mutation_log and archived in ca_diamond_journal_archive,   */
  /* and the warning has now fired 70 times for a thing working as        */
  /* designed. Severity comes from a table, so a new kind of routine      */
  /* maintenance is a row rather than a code change - and anything not in */
  /* that table is still a warning.                                       */
  /* =================================================================== */
  CREATE TABLE IF NOT EXISTS public.ca_ledger_maintenance_kinds (
    kind        text PRIMARY KEY,
    severity    text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
    note        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO public.ca_ledger_maintenance_kinds (kind, severity, note)
  VALUES ('cert-cleanup', 'info',
          'The certification fleet clears its own diamond journal on an hourly cadence. Every row is preserved whole in ca_ledger_mutation_log and archived in ca_diamond_journal_archive before it goes. Expected, scheduled and reversible: recorded, not alarming.')
  ON CONFLICT (kind) DO NOTHING;
  GRANT SELECT ON public.ca_ledger_maintenance_kinds TO authenticated;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_journal_append_only';
  IF position($old$  v_kind text;
  v_j jsonb;$old$ IN v_src) = 0
     OR position($old$      v_kind := split_part(v_reason, ':', 1);$old$ IN v_src) = 0
     OR position($old$        'fn_ca_journal_append_only', 'unauthorized_adjustment', 'warning',$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'journal append-only anchors not found';
  END IF;
  v_new := replace(v_src,
$old$  v_kind text;
  v_j jsonb;$old$,
$old$  v_kind text;
  v_sev text;
  v_j jsonb;$old$);
  v_new := replace(v_new,
$old$      v_kind := split_part(v_reason, ':', 1);$old$,
$old$      v_kind := split_part(v_reason, ':', 1);
      -- a routine, recorded maintenance is filed, not shouted about
      SELECT k.severity INTO v_sev
        FROM public.ca_ledger_maintenance_kinds k WHERE k.kind = v_kind;
      v_sev := COALESCE(v_sev, 'warning');$old$);
  v_new := replace(v_new,
$old$        'fn_ca_journal_append_only', 'unauthorized_adjustment', 'warning',$old$,
$old$        'fn_ca_journal_append_only', 'unauthorized_adjustment', v_sev,$old$);
  EXECUTE v_new;

  /* =================================================================== */
  /* 5. A GUARD NOTICE CLOSES WHEN THE NEXT ONE OPENS.                   */
  /*                                                                     */
  /* fn_ca_guard_defs_watch keys its notice on the NEW definition hash    */
  /* and updates its baseline in the same breath, so a notice can never   */
  /* match itself again and stays open forever. Four are open right now,  */
  /* for four functions legitimately edited today, and all four already   */
  /* agree with their stored baseline. A newer notice for the same guard  */
  /* supersedes the older one.                                            */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_guard_defs_watch';
  IF position($old$      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_guard_defs_watch', 'unknown', 'info',
        'guard-def-drift:' || v_name || ':' || left(v_hash, 12),$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'guard drift raise call not found';
  END IF;
  v_new := replace(v_src,
$old$      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_guard_defs_watch', 'unknown', 'info',
        'guard-def-drift:' || v_name || ':' || left(v_hash, 12),$old$,
$old$      /* A newer notice for the same guard supersedes the older one: the
         key carries the new hash, so an old notice can never be matched
         again and would sit open forever. */
      UPDATE public.ca_drift_incidents
         SET status = 'resolved', resolved_at = now(),
             resolution = 'superseded: ' || v_name || ' was redefined again, and the newer notice carries the current definition'
       WHERE source = 'fn_ca_guard_defs_watch'
         AND status <> 'resolved'
         AND dedupe_key LIKE 'guard-def-drift:' || v_name || ':%';

      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_guard_defs_watch', 'unknown', 'info',
        'guard-def-drift:' || v_name || ':' || left(v_hash, 12),$old$);
  EXECUTE v_new;

  /* -------- post-apply -------- */
  SELECT detail INTO v_detail FROM public.fn_chip_integrity_report() WHERE check_name = 'ledger_write_failures';
  IF v_detail NOT LIKE '%last 48 hours%' OR v_detail NOT LIKE '6 %' THEN
    RAISE EXCEPTION 'the write-failure arm did not take the window: %', v_detail;
  END IF;

  SELECT count(*) INTO v_n FROM public.fn_anon_exposure_check();
  IF v_n <> 0 THEN RAISE EXCEPTION 'anon exposure check still reports a finding'; END IF;

  SELECT count(*) INTO v_n FROM public.fn_tournament_chip_conservation_check(0.01);
  RAISE NOTICE 'tournament chip conservation now reports % finding(s)', v_n;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_journal_append_only';
  IF position('ca_ledger_maintenance_kinds' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the append-only guard did not learn the maintenance kinds';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_guard_defs_watch';
  IF position('superseded: ' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the guard watcher did not take the supersede rule';
  END IF;
END
$mig$;
