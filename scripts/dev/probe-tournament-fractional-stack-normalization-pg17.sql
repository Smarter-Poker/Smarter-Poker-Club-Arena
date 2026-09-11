\set ON_ERROR_STOP on

DO $proof$
DECLARE
  v_before numeric;
  v_after numeric;
BEGIN
  IF format_type(
       (SELECT atttypid FROM pg_attribute
         WHERE attrelid = 'public.tournament_players'::regclass
           AND attname = 'chips' AND NOT attisdropped),
       (SELECT atttypmod FROM pg_attribute
         WHERE attrelid = 'public.tournament_players'::regclass
           AND attname = 'chips' AND NOT attisdropped)
     ) <> 'bigint'
     OR format_type(
       (SELECT atttypid FROM pg_attribute
         WHERE attrelid = 'public.tournament_flights'::regclass
           AND attname = 'bagged_chips' AND NOT attisdropped),
       (SELECT atttypmod FROM pg_attribute
         WHERE attrelid = 'public.tournament_flights'::regclass
           AND attname = 'bagged_chips' AND NOT attisdropped)
     ) <> 'bigint' THEN
    RAISE EXCEPTION 'PROBE_BIGINT_CONTRACT_MISSING: roster and flight chips must both be bigint';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('20000000-0000-0000-0000-000000000001'::uuid, 34::numeric),
        ('20000000-0000-0000-0000-000000000002'::uuid, 33::numeric),
        ('20000000-0000-0000-0000-000000000003'::uuid, 33::numeric),
        ('20000000-0000-0000-0000-000000000004'::uuid, 51::numeric),
        ('20000000-0000-0000-0000-000000000005'::uuid, 49::numeric)
      ) expected(id, stack)
      LEFT JOIN public.table_seats s ON s.id = expected.id
     WHERE s.stack IS DISTINCT FROM expected.stack
        OR s.stack <> trunc(s.stack)
  ) THEN
    RAISE EXCEPTION 'PROBE_NORMALIZATION_MISMATCH: stable largest-remainder result changed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
      JOIN public.tournament_players tp
        ON tp.tournament_id = tb.tournament_id
       AND tp.user_id = s.user_id
     WHERE tb.tournament_id IN (
       '00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-000000000002'
     )
       AND s.left_at IS NULL
       AND tp.chips::numeric IS DISTINCT FROM s.stack
  ) THEN
    RAISE EXCEPTION 'PROBE_MIRROR_MISMATCH: seat and tournament-player chips diverged';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE tb.tournament_id IN (
       '00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-000000000002'
     )
       AND s.left_at IS NULL
     GROUP BY tb.tournament_id
    HAVING sum(s.stack) IS DISTINCT FROM 100::numeric
  ) THEN
    RAISE EXCEPTION 'PROBE_CONSERVATION_MISMATCH: a tournament did not retain 100 chips';
  END IF;

  IF (SELECT status FROM public.tournaments
       WHERE id = '00000000-0000-0000-0000-000000000002') <> 'REGISTERING'
     OR EXISTS (
       SELECT 1 FROM public.tournament_players
        WHERE tournament_id = '00000000-0000-0000-0000-000000000002'
          AND status <> 'registered'
     ) THEN
    RAISE EXCEPTION 'PROBE_REGISTERING_COHORT_MUTATED: lifecycle status changed';
  END IF;

  IF (SELECT stack FROM public.table_seats
       WHERE id = '20000000-0000-0000-0000-000000000006')
       IS DISTINCT FROM 9.50::numeric
     OR (SELECT stack FROM public.table_seats
       WHERE id = '20000000-0000-0000-0000-000000000007')
       IS DISTINCT FROM 8.75::numeric
     OR (SELECT stack FROM public.table_seats
       WHERE id = '20000000-0000-0000-0000-000000000009')
       IS DISTINCT FROM 7.25::numeric
     OR (SELECT left_at FROM public.table_seats
       WHERE id = '20000000-0000-0000-0000-000000000009') IS NULL THEN
    RAISE EXCEPTION 'PROBE_HISTORY_MUTATED: terminal/departed testimony changed';
  END IF;
  IF (SELECT bomb_pot_ante_fixed FROM public.tables
       WHERE id = '10000000-0000-0000-0000-000000000004')
       IS DISTINCT FROM 0.75::numeric THEN
    RAISE EXCEPTION 'PROBE_HISTORY_MUTATED: terminal bomb-pot testimony changed';
  END IF;

  IF (SELECT stack FROM public.table_seats
       WHERE id = '20000000-0000-0000-0000-000000000008')
       IS DISTINCT FROM 12.34::numeric
     OR (SELECT bomb_pot_ante_fixed FROM public.tables
       WHERE id = '10000000-0000-0000-0000-000000000006')
       IS DISTINCT FROM 0.25::numeric THEN
    RAISE EXCEPTION 'PROBE_CASH_MUTATED: cash cents changed during cutover';
  END IF;

  IF (SELECT count(*) FROM pg_trigger g
       WHERE g.tgname = 'a1_require_whole_tournament_chips'
         AND g.tgrelid IN (
           'public.tournaments'::regclass,
           'public.tournament_players'::regclass,
           'public.tables'::regclass,
           'public.table_seats'::regclass
         )
         AND NOT g.tgisinternal
         AND g.tgenabled = 'O') <> 4 THEN
    RAISE EXCEPTION 'PROBE_GUARD_MISSING: four permanent triggers are required';
  END IF;

  SELECT sum(s.stack) INTO v_before
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id IN (
     '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000002'
   ) AND s.left_at IS NULL;
  SELECT sum(tp.chips::numeric) INTO v_after
    FROM public.tournament_players tp
   WHERE tp.tournament_id IN (
     '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000002'
   );
  IF v_before IS DISTINCT FROM 200 OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'PROBE_GLOBAL_CONSERVATION_MISMATCH: expected exact 200/200 supply';
  END IF;
END;
$proof$;

/* Cash remains cent-denominated after the permanent guards are installed. */
UPDATE public.tables
   SET small_blind = 0.30,
       big_blind = 0.60,
       ante = 0.15,
       bomb_pot_enabled = true,
       bomb_pot_ante_fixed = 0.35
 WHERE id = '10000000-0000-0000-0000-000000000006';
UPDATE public.table_seats
   SET stack = 12.45
 WHERE id = '20000000-0000-0000-0000-000000000008';

/* All supported blind-key spellings remain accepted when their values are
   whole. Break metadata is deliberately not a chip source. */
INSERT INTO public.tournaments(
  id, name, status, starting_chips, rebuy_chips, addon_chips,
  blind_structure, created_at
) VALUES (
  '00000000-0000-0000-0000-000000000099',
  'Guard key spellings', 'REGISTERING', 100, 100, 100,
  '[{"smallBlind":1,"bigBlind":2,"ante":0},
    {"small_blind":2,"big_blind":4,"ante":1},
    {"small":3,"big":6,"ante":1},
    {"sb":4,"bb":8,"ante":2},
    {"isBreak":true,"smallBlind":0.25,"bigBlind":0.50,"ante":0.10}]',
  '2026-09-08 17:00:00+00'
);

/* An orphan engine-classified tournament table still receives every guard. */
INSERT INTO public.tables(
  id, tournament_id, game_type, status, small_blind, big_blind, ante,
  bomb_pot_enabled, bomb_pot_ante_fixed, created_at
) VALUES (
  '10000000-0000-0000-0000-000000000099', NULL, 'tournament',
  'running', 1, 2, 0, true, 3, '2026-09-08 17:01:00+00'
);
INSERT INTO public.table_seats(
  id, table_id, seat_number, user_id, stack, joined_at, left_at
) VALUES (
  '20000000-0000-0000-0000-000000000099',
  '10000000-0000-0000-0000-000000000099', 1,
  '30000000-0000-0000-0000-000000000099', 100,
  '2026-09-08 17:02:00+00', NULL
);

DO $allowed_postconditions$
BEGIN
  IF (SELECT ROW(small_blind, big_blind, ante, bomb_pot_ante_fixed)
        FROM public.tables
       WHERE id = '10000000-0000-0000-0000-000000000006')
       IS DISTINCT FROM ROW(0.30::numeric, 0.60::numeric, 0.15::numeric, 0.35::numeric)
     OR (SELECT stack FROM public.table_seats
          WHERE id = '20000000-0000-0000-0000-000000000008')
          IS DISTINCT FROM 12.45::numeric THEN
    RAISE EXCEPTION 'PROBE_CASH_GUARD_REGRESSION: legal cash cents were rejected or changed';
  END IF;
END;
$allowed_postconditions$;
