-- Every claim scenario, with the verdict each body must give.
-- Columns: main = 20260918053310 (on main), live = 20260927231300 (production
-- 2026-09-28), post = 20260928032017.
\set ON_ERROR_STOP on
SELECT set_config('harness.stage', :'stage', false);
DO $scenarios$
DECLARE
  stage text := current_setting('harness.stage');
  T  constant uuid := '11111111-1111-4111-8111-111111111111';
  T2 constant uuid := '22222222-2222-4222-8222-222222222222';
  G  constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  G2 constant uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  O  constant uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  X  constant uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  stale constant interval := interval '31 seconds';
  c record;
  r record;
  row_after public.engine_tournament_leases;
  expected boolean;
  failures int := 0;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      -- name, row_instance, row_gen, row_age, row_protocol, claim_gen, transfer_tournament, transfer_completed, aborted, main, live, post
      ('open_successor_stale_other_instance',        'dead', G,    stale, 2, G,  T,    false, false, false, true,  true),
      ('same_gen_stale_other_instance_no_transfer',  'dead', G,    stale, 2, G,  NULL, false, false, false, true,  false),
      ('same_gen_stale_other_instance_completed',    'dead', G,    stale, 2, G,  T,    true,  false, false, true,  false),
      ('same_gen_stale_successor_of_other_event',    'dead', G,    stale, 2, G,  T2,   false, false, false, true,  false),
      ('open_successor_fresh_other_instance',        'live', G,    interval '0', 2, G, T, false, false, false, false, false),
      ('different_gen_stale',                        'dead', G2,   stale, 2, G,  NULL, false, false, true,  true,  true),
      ('different_gen_fresh',                        'live', G2,   interval '0', 2, G, NULL, false, false, false, false, false),
      ('same_instance_renewal_fresh',                'me',   G,    interval '0', 2, G, NULL, false, false, true,  true,  true),
      ('aborted_generation_open_successor_stale',    'dead', G,    stale, 2, G,  T,    false, true,  false, false, false),
      ('no_row',                                     NULL,   NULL, NULL,  2, G,  NULL, false, false, true,  true,  true),
      ('legacy_protocol_same_instance',              'me',   G2,   interval '0', 1, G, NULL, false, false, true,  true,  true)
    ) v(name, row_instance, row_gen, row_age, row_protocol, claim_gen, transfer_tournament,
        transfer_completed, aborted, main, live, post)
  LOOP
    DELETE FROM public.engine_tournament_leases WHERE true;
    DELETE FROM smarter_private.f06_manager_custody_completions WHERE true;
    DELETE FROM smarter_private.f06_manager_custody_transfers WHERE true;
    DELETE FROM smarter_private.harness_aborted WHERE true;
    IF c.row_instance IS NOT NULL THEN
      INSERT INTO public.engine_tournament_leases
        VALUES (T, c.row_instance, 'old', clock_timestamp() - interval '2 days',
                clock_timestamp() - c.row_age, c.row_gen, c.row_protocol);
    END IF;
    IF c.transfer_tournament IS NOT NULL THEN
      INSERT INTO smarter_private.f06_manager_custody_transfers
             (transfer_id, tournament_id, origin_generation, successor_generation)
      VALUES (X, c.transfer_tournament, O, c.claim_gen);
      IF c.transfer_completed THEN
        INSERT INTO smarter_private.f06_manager_custody_completions (transfer_id, tournament_id, generation)
        VALUES (X, c.transfer_tournament, c.claim_gen);
      END IF;
    END IF;
    IF c.aborted THEN
      INSERT INTO smarter_private.harness_aborted VALUES (T, c.claim_gen);
    END IF;

    SELECT * INTO r FROM public.claim_tournament_lease_v2(T, 'me', 'new', c.claim_gen, 30);
    SELECT * INTO row_after FROM public.engine_tournament_leases WHERE tournament_id = T;
    expected := CASE stage WHEN 'main' THEN c.main WHEN 'live' THEN c.live ELSE c.post END;

    IF r.granted IS DISTINCT FROM expected THEN
      failures := failures + 1;
      RAISE WARNING 'FAIL [%] %: granted=% expected=% holder=% gen=%',
        stage, c.name, r.granted, expected, r.holder, r.lease_generation;
      CONTINUE;
    END IF;
    IF r.granted THEN
      IF row_after.instance_id IS DISTINCT FROM 'me'
         OR row_after.lease_generation IS DISTINCT FROM c.claim_gen
         OR row_after.protocol_version IS DISTINCT FROM 2
         OR row_after.heartbeat_at < clock_timestamp() - interval '5 seconds' THEN
        failures := failures + 1;
        RAISE WARNING 'FAIL [%] %: granted but row is %', stage, c.name, to_jsonb(row_after);
      END IF;
      -- Renewal keeps acquired_at; every takeover restamps it.
      IF c.name = 'same_instance_renewal_fresh'
           AND row_after.acquired_at > clock_timestamp() - interval '1 day'
         OR c.name <> 'same_instance_renewal_fresh' AND c.row_instance IS NOT NULL
           AND row_after.acquired_at < clock_timestamp() - interval '1 day' THEN
        failures := failures + 1;
        RAISE WARNING 'FAIL [%] %: acquired_at rule broken (%)', stage, c.name, row_after.acquired_at;
      END IF;
    ELSE
      -- A refusal writes nothing and names the holder it could not displace.
      IF c.row_instance IS NOT NULL AND (
           row_after.instance_id IS DISTINCT FROM c.row_instance
        OR row_after.lease_generation IS DISTINCT FROM c.row_gen) THEN
        failures := failures + 1;
        RAISE WARNING 'FAIL [%] %: refused but row changed to %', stage, c.name, to_jsonb(row_after);
      END IF;
      IF NOT c.aborted AND c.row_instance IS NOT NULL AND r.holder IS DISTINCT FROM c.row_instance THEN
        failures := failures + 1;
        RAISE WARNING 'FAIL [%] %: refusal named holder % not %', stage, c.name, r.holder, c.row_instance;
      END IF;
    END IF;
    RAISE NOTICE 'ok [%] % granted=%', stage, c.name, r.granted;
  END LOOP;
  IF failures > 0 THEN
    RAISE EXCEPTION 'HARNESS_FAILED stage=% failures=%', stage, failures;
  END IF;
END
$scenarios$;
