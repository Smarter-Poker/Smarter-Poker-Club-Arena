-- A CERTIFICATION CLUB IS RETIRED TO THE MINT, AND THEN IT IS GONE.
--
-- 2026-09-03, Dan (binding): "THERE HAVE NOT BEEN 13 CLUBS CREATED IN 30 DAYS,
-- IF THEY WERE THEY WERE 'TEST CLUBS' THAT NEED TO BE DELETED. THE ONLY CLUB
-- ARENA CLUBS ARE 'MIDWAY UNION' WHICH IS A UNION, NOT A CLUB, CLUB JAQK,
-- SHARK CLUB, AND DEEP STACK SOCIETY. DELETE ANY OTHER CLUBS."
--
-- He is right, and the count came from a real leak. Club Create Certification
-- creates a throwaway club on every run and deletes it again in a finally
-- block. The delete has failed every single time, and the script only warns:
--
--     Fixture Hard Delete Skipped: UPDATE on chip_transactions is forbidden:
--     financial journals are append-only.
--
-- So every certification run since 2026-08-31 left a club behind, each holding
-- the 100,000-chip opening grant: 15 clubs, 1,300,000 chips.
--
-- Three guards stand between a club and deletion, and all three are correct:
--
--   1. clubs -> chip_transactions is ON DELETE SET NULL, an UPDATE on an
--      append-only journal, which the journal refuses;
--   2. chip_transactions.club_id is NOT NULL, so that SET NULL could never have
--      worked anyway - the FK and the column have disagreed since the journal
--      was made append-only;
--   3. removing the last member emits a management-access event that points at
--      the club, and game_management_events is append-only too.
--
-- Each has a sanctioned door, and this function takes all three by the front:
-- app.ledger_maintenance preserves every journal row whole in
-- ca_ledger_mutation_log with the reason attached and raises its own warning
-- incident; app.game_management_retention lets the fixture's own events go;
-- and the order of the deletes keeps every foreign key satisfied at the moment
-- it is checked.
--
-- fn_ca_retire_certification_club:
--
--   * refuses anything that is not a certification fixture - it must match the
--     certification naming AND have no union, no tables, no tournaments, no
--     agents, and no member who is not a @smarter-poker.invalid cert account;
--   * refuses the four real estates by id, whatever they are called, so a
--     rename can never point this at Club JAQK;
--   * retires every chip the fixture holds to chip_retirement with a declared
--     journal row, so the supply meter sees a burn and not a leak - the exact
--     mirror of the Mint issuance that opened the club;
--   * then removes the fixture and its own traces, in that order.
--
-- The 15 fixtures standing today are retired at the end of this migration, and
-- the certification script is pointed at this function in the same change so
-- the next run cleans up after itself.

CREATE OR REPLACE FUNCTION public.fn_ca_retire_certification_club(
  p_club_id uuid,
  p_reason  text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_club     public.clubs%ROWTYPE;
  v_reason   text := COALESCE(NULLIF(btrim(p_reason), ''), 'cert-cleanup');
  v_retired  numeric := 0;
  v_members  integer := 0;
  v_bad      integer := 0;
  v_tx       integer := 0;
  v_ev       integer := 0;
  v_protected uuid[] := ARRAY[
    'a0000000-0000-0000-0000-000000000001'::uuid,  -- Club JAQK
    'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,  -- SHARK CLUB
    '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,  -- Deep Stack Society
    'fade0000-0000-0000-0000-000000000001'::uuid   -- Midway Union
  ];
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role_only' USING ERRCODE = '42501';
  END IF;

  IF p_club_id = ANY (v_protected) THEN
    RETURN jsonb_build_object('success', false, 'error', 'that is a real Club Arena estate, not a fixture');
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id = p_club_id FOR UPDATE;
  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'already_gone', true, 'club_id', p_club_id);
  END IF;

  IF v_club.name NOT LIKE 'Crest Cert %' AND v_club.name NOT LIKE 'Preset Crest Cert %' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a certification fixture by name',
                              'name', v_club.name);
  END IF;
  IF v_club.union_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'a fixture never belongs to a union');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables t WHERE t.club_id = p_club_id)
     OR EXISTS (SELECT 1 FROM public.tournaments t WHERE t.club_id = p_club_id)
     OR EXISTS (SELECT 1 FROM public.agents a WHERE a.club_id = p_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'this club has played: it is not a fixture');
  END IF;

  SELECT count(*) INTO v_members FROM public.club_members m WHERE m.club_id = p_club_id;
  SELECT count(*) INTO v_bad
    FROM public.club_members m
    LEFT JOIN auth.users u ON u.id = m.user_id
   WHERE m.club_id = p_club_id
     AND COALESCE(u.email, '') NOT LIKE '%@smarter-poker.invalid';
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'a real member holds this club',
                              'non_cert_members', v_bad);
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members m
              WHERE m.club_id = p_club_id
                AND (COALESCE(m.chip_balance, 0) <> 0 OR COALESCE(m.promo_balance, 0) <> 0)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'a fixture member still holds chips');
  END IF;

  /* RETIRE THE CHIPS FIRST. chip_retirement is a non-circulating store, so the
     supply meter reads this as a burn and not as chips vanishing. */
  v_retired := round(COALESCE(v_club.chip_treasury, 0)
                   + COALESCE(v_club.chip_pool, 0)
                   + COALESCE(v_club.promo_balance, 0)
                   + COALESCE(v_club.insurance_balance, 0), 2);

  IF v_retired <> 0 THEN
    PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL,
                                        'cert-retire:' || p_club_id::text, NULL);
    UPDATE public.clubs
       SET chip_treasury     = 0,
           chip_pool         = 0,
           promo_balance     = 0,
           insurance_balance = 0,
           updated_at        = now()
     WHERE id = p_club_id;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
  END IF;

  /* Both append-only doors, opened by name and closed again below. */
  PERFORM set_config('app.ledger_maintenance', v_reason || ':' || p_club_id::text, true);
  PERFORM set_config('app.game_management_retention', 'on', true);

  /* Order matters. The journal rows go first (their club still exists, so the
     archive records a complete row). The members go next, while the club is
     still there for the event their removal emits. Then that event, and only
     then the club itself. */
  DELETE FROM public.chip_transactions WHERE club_id = p_club_id;
  GET DIAGNOSTICS v_tx = ROW_COUNT;

  DELETE FROM public.club_members WHERE club_id = p_club_id;

  DELETE FROM public.game_management_events WHERE club_id = p_club_id;
  GET DIAGNOSTICS v_ev = ROW_COUNT;

  DELETE FROM public.clubs WHERE id = p_club_id;

  PERFORM set_config('app.ledger_maintenance', '', true);
  PERFORM set_config('app.game_management_retention', '', true);

  RETURN jsonb_build_object('success', true, 'club_id', p_club_id, 'name', v_club.name,
                            'chips_retired', v_retired, 'members_removed', v_members,
                            'journal_rows_archived', v_tx, 'events_removed', v_ev);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_retire_certification_club(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_retire_certification_club(uuid, text) TO service_role;

COMMENT ON FUNCTION public.fn_ca_retire_certification_club(uuid, text) IS
  'Retires one Club Create Certification fixture: proves it is a fixture, retires its chips '
  'to chip_retirement with a declared journal row, then removes it through the append-only '
  'maintenance doors. Refuses the four real estates by id and anything that has played.';

-- Retire the fixtures standing today.
DO $sweep$
DECLARE
  r record;
  v_res jsonb;
  v_n integer := 0;
  v_chips numeric := 0;
  v_refused integer := 0;
BEGIN
  FOR r IN SELECT id, name FROM public.clubs
            WHERE name LIKE 'Crest Cert %' OR name LIKE 'Preset Crest Cert %'
            ORDER BY created_at
  LOOP
    v_res := public.fn_ca_retire_certification_club(r.id, 'cert-cleanup-backlog');
    IF COALESCE((v_res ->> 'success')::boolean, false) THEN
      v_n := v_n + 1;
      v_chips := v_chips + COALESCE((v_res ->> 'chips_retired')::numeric, 0);
    ELSE
      v_refused := v_refused + 1;
      RAISE NOTICE 'CERT_SWEEP refused % (%): %', r.name, r.id, v_res ->> 'error';
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.clubs
              WHERE name LIKE 'Crest Cert %' OR name LIKE 'Preset Crest Cert %') THEN
    RAISE EXCEPTION 'CERT_SWEEP: % fixture(s) still standing after the sweep', v_refused;
  END IF;

  /* The three real clubs and the union are still here, and nothing else is. */
  IF (SELECT count(*) FROM public.clubs) <> 4 THEN
    RAISE EXCEPTION 'CERT_SWEEP: expected exactly the four real estates to remain, found %',
      (SELECT count(*) FROM public.clubs);
  END IF;

  RAISE NOTICE 'CERT_SWEEP_OK: retired % fixtures holding % chips', v_n, v_chips;
END
$sweep$;