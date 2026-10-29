-- Project exact claim-authorized chairs without rewriting the original hand.
-- The unchanged identity/funding predicate and authorized stack share one statement.
-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)') AND md5(p.prosrc)='3559c5f8827038de5a8be56a30ee44ac' AND md5(pg_get_functiondef(p.oid))='dd354c3443d359b21a9839f27582dc60' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $chairs$ DECLARE f regprocedure:='public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure;d text;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(p.prosrc)='a083d06d4906dc350350b847faf1c73f' AND md5(pg_get_functiondef(p.oid))='b92400fc1ddc2908cdd42866f547ede6' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHAIR_PREIMAGE_CHANGED' USING ERRCODE='55000';END IF;
 d:=pg_get_functiondef(f);
 IF length(d)-length(replace(d,'DECLARE c smarter_private.hand_continuations; h smarter_private.f06_hand_permits;',''))<>length('DECLARE c smarter_private.hand_continuations; h smarter_private.f06_hand_permits;') THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHAIR_SHAPE_CHANGED';END IF;
 d:=replace(d,'DECLARE c smarter_private.hand_continuations; h smarter_private.f06_hand_permits;','DECLARE c smarter_private.hand_continuations; h smarter_private.f06_hand_permits;
  chair_seats jsonb;');
 IF length(d)-length(replace(d,'  IF EXISTS (SELECT 1 FROM jsonb_array_elements(c.payload::jsonb->''seats'') x
              WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s
                WHERE s.id::text = x->>''seat_id'' AND s.table_id = p_table_id
                  AND s.user_id::text = x->>''user_id'' AND s.left_at IS NULL
                  AND s.joined_at = (x->>''seat_joined_at'')::timestamptz
                  AND (s.stack = (x->>''stack_before'')::numeric
                  OR EXISTS (
                    -- An add-on bought after this original was retained is
                    -- outside the hand. Its immutable funded receipt proves
                    -- the exact credit; delta settlement preserves it.
                    SELECT 1 FROM public.tournament_players tp
                    JOIN public.tournament_participant_funding_receipts r
                      ON r.registration_id=tp.id AND r.tournament_id=tp.tournament_id
                     AND r.user_id=tp.user_id
                    WHERE tp.tournament_id=p_tournament_id AND tp.user_id=s.user_id
                      AND tp.table_id=s.table_id AND tp.seat_number=s.seat_number
                      AND tp.add_on IS TRUE AND tp.chips=s.stack
                      AND r.operation=''addon'' AND r.observed_at>c.created_at
                      AND r.purchase_key=''tourney:''||p_tournament_id::text||'':addon:''||s.user_id::text
                      AND ((r.asset=''diamonds'' AND r.custody_result->>''success''=''true'')
                        OR (r.asset=''chips'' AND r.amount>0 AND r.custody_result IS NULL
                          AND r.entitlement_id IS NOT NULL AND r.ledger_id IS NOT NULL
                          AND r.wallet_transaction_id IS NOT NULL AND r.funding_club_id IS NOT NULL
                          AND r.entitlement_snapshot->>''id''=r.entitlement_id::text
                          AND r.entitlement_snapshot->>''entitlement_kind''=''wallet_charge''
                          AND r.entitlement_snapshot->>''charge_category''=''addon''
                          AND r.entitlement_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.entitlement_snapshot->>''user_id''=r.user_id::text
                          AND (r.entitlement_snapshot->>''gross'')::numeric=r.amount
                          AND r.entitlement_snapshot->>''source_ledger_id''=r.ledger_id::text
                          AND r.entitlement_snapshot->>''refund_wallet_club_id''=r.funding_club_id::text
                          AND r.ledger_snapshot->>''id''=r.ledger_id::text
                          AND r.ledger_snapshot->>''status''=''posted''
                          AND r.ledger_snapshot->>''from_type''=''player_wallet''
                          AND r.ledger_snapshot->>''to_type''=''prize_liability''
                          AND r.ledger_snapshot->>''category''=''addon''
                          AND r.ledger_snapshot->>''from_entity_id''=r.user_id::text
                          AND r.ledger_snapshot->>''to_entity_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''club_id''=r.funding_club_id::text
                          AND (r.ledger_snapshot->>''amount'')::numeric=r.amount
                          AND r.wallet_snapshot->>''id''=r.wallet_transaction_id::text
                          AND r.wallet_snapshot->>''type''=''debit''
                          AND r.wallet_snapshot->>''category''=''addon''
                          AND r.wallet_snapshot->>''user_id''=r.user_id::text
                          AND r.wallet_snapshot->>''related_entity_id''=r.tournament_id::text
                          AND (r.wallet_snapshot->>''amount'')::numeric=r.amount))
                      AND r.registration_snapshot->>''id''=tp.id::text
                      AND r.registration_snapshot->>''tournament_id''=p_tournament_id::text
                      AND r.registration_snapshot->>''user_id''=s.user_id::text
                      AND r.registration_snapshot->>''table_id''=s.table_id::text
                      AND (r.registration_snapshot->>''seat_number'')::integer=s.seat_number
                      AND r.registration_snapshot->>''add_on''=''true''
                      AND (r.registration_snapshot->>''chips'')::numeric=s.stack
                      AND r.tournament_snapshot->>''id''=p_tournament_id::text
                      AND (r.tournament_snapshot->>''addon_chips'')::numeric>0
                      AND r.amount=(r.tournament_snapshot->>''addon_cost'')::numeric
                      AND s.stack=(x->>''stack_before'')::numeric
                        +(r.tournament_snapshot->>''addon_chips'')::numeric)))) THEN
',''))<>length('  IF EXISTS (SELECT 1 FROM jsonb_array_elements(c.payload::jsonb->''seats'') x
              WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s
                WHERE s.id::text = x->>''seat_id'' AND s.table_id = p_table_id
                  AND s.user_id::text = x->>''user_id'' AND s.left_at IS NULL
                  AND s.joined_at = (x->>''seat_joined_at'')::timestamptz
                  AND (s.stack = (x->>''stack_before'')::numeric
                  OR EXISTS (
                    -- An add-on bought after this original was retained is
                    -- outside the hand. Its immutable funded receipt proves
                    -- the exact credit; delta settlement preserves it.
                    SELECT 1 FROM public.tournament_players tp
                    JOIN public.tournament_participant_funding_receipts r
                      ON r.registration_id=tp.id AND r.tournament_id=tp.tournament_id
                     AND r.user_id=tp.user_id
                    WHERE tp.tournament_id=p_tournament_id AND tp.user_id=s.user_id
                      AND tp.table_id=s.table_id AND tp.seat_number=s.seat_number
                      AND tp.add_on IS TRUE AND tp.chips=s.stack
                      AND r.operation=''addon'' AND r.observed_at>c.created_at
                      AND r.purchase_key=''tourney:''||p_tournament_id::text||'':addon:''||s.user_id::text
                      AND ((r.asset=''diamonds'' AND r.custody_result->>''success''=''true'')
                        OR (r.asset=''chips'' AND r.amount>0 AND r.custody_result IS NULL
                          AND r.entitlement_id IS NOT NULL AND r.ledger_id IS NOT NULL
                          AND r.wallet_transaction_id IS NOT NULL AND r.funding_club_id IS NOT NULL
                          AND r.entitlement_snapshot->>''id''=r.entitlement_id::text
                          AND r.entitlement_snapshot->>''entitlement_kind''=''wallet_charge''
                          AND r.entitlement_snapshot->>''charge_category''=''addon''
                          AND r.entitlement_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.entitlement_snapshot->>''user_id''=r.user_id::text
                          AND (r.entitlement_snapshot->>''gross'')::numeric=r.amount
                          AND r.entitlement_snapshot->>''source_ledger_id''=r.ledger_id::text
                          AND r.entitlement_snapshot->>''refund_wallet_club_id''=r.funding_club_id::text
                          AND r.ledger_snapshot->>''id''=r.ledger_id::text
                          AND r.ledger_snapshot->>''status''=''posted''
                          AND r.ledger_snapshot->>''from_type''=''player_wallet''
                          AND r.ledger_snapshot->>''to_type''=''prize_liability''
                          AND r.ledger_snapshot->>''category''=''addon''
                          AND r.ledger_snapshot->>''from_entity_id''=r.user_id::text
                          AND r.ledger_snapshot->>''to_entity_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''club_id''=r.funding_club_id::text
                          AND (r.ledger_snapshot->>''amount'')::numeric=r.amount
                          AND r.wallet_snapshot->>''id''=r.wallet_transaction_id::text
                          AND r.wallet_snapshot->>''type''=''debit''
                          AND r.wallet_snapshot->>''category''=''addon''
                          AND r.wallet_snapshot->>''user_id''=r.user_id::text
                          AND r.wallet_snapshot->>''related_entity_id''=r.tournament_id::text
                          AND (r.wallet_snapshot->>''amount'')::numeric=r.amount))
                      AND r.registration_snapshot->>''id''=tp.id::text
                      AND r.registration_snapshot->>''tournament_id''=p_tournament_id::text
                      AND r.registration_snapshot->>''user_id''=s.user_id::text
                      AND r.registration_snapshot->>''table_id''=s.table_id::text
                      AND (r.registration_snapshot->>''seat_number'')::integer=s.seat_number
                      AND r.registration_snapshot->>''add_on''=''true''
                      AND (r.registration_snapshot->>''chips'')::numeric=s.stack
                      AND r.tournament_snapshot->>''id''=p_tournament_id::text
                      AND (r.tournament_snapshot->>''addon_chips'')::numeric>0
                      AND r.amount=(r.tournament_snapshot->>''addon_cost'')::numeric
                      AND s.stack=(x->>''stack_before'')::numeric
                        +(r.tournament_snapshot->>''addon_chips'')::numeric)))) THEN
') THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHAIR_SHAPE_CHANGED';END IF;
 d:=replace(d,'  IF EXISTS (SELECT 1 FROM jsonb_array_elements(c.payload::jsonb->''seats'') x
              WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s
                WHERE s.id::text = x->>''seat_id'' AND s.table_id = p_table_id
                  AND s.user_id::text = x->>''user_id'' AND s.left_at IS NULL
                  AND s.joined_at = (x->>''seat_joined_at'')::timestamptz
                  AND (s.stack = (x->>''stack_before'')::numeric
                  OR EXISTS (
                    -- An add-on bought after this original was retained is
                    -- outside the hand. Its immutable funded receipt proves
                    -- the exact credit; delta settlement preserves it.
                    SELECT 1 FROM public.tournament_players tp
                    JOIN public.tournament_participant_funding_receipts r
                      ON r.registration_id=tp.id AND r.tournament_id=tp.tournament_id
                     AND r.user_id=tp.user_id
                    WHERE tp.tournament_id=p_tournament_id AND tp.user_id=s.user_id
                      AND tp.table_id=s.table_id AND tp.seat_number=s.seat_number
                      AND tp.add_on IS TRUE AND tp.chips=s.stack
                      AND r.operation=''addon'' AND r.observed_at>c.created_at
                      AND r.purchase_key=''tourney:''||p_tournament_id::text||'':addon:''||s.user_id::text
                      AND ((r.asset=''diamonds'' AND r.custody_result->>''success''=''true'')
                        OR (r.asset=''chips'' AND r.amount>0 AND r.custody_result IS NULL
                          AND r.entitlement_id IS NOT NULL AND r.ledger_id IS NOT NULL
                          AND r.wallet_transaction_id IS NOT NULL AND r.funding_club_id IS NOT NULL
                          AND r.entitlement_snapshot->>''id''=r.entitlement_id::text
                          AND r.entitlement_snapshot->>''entitlement_kind''=''wallet_charge''
                          AND r.entitlement_snapshot->>''charge_category''=''addon''
                          AND r.entitlement_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.entitlement_snapshot->>''user_id''=r.user_id::text
                          AND (r.entitlement_snapshot->>''gross'')::numeric=r.amount
                          AND r.entitlement_snapshot->>''source_ledger_id''=r.ledger_id::text
                          AND r.entitlement_snapshot->>''refund_wallet_club_id''=r.funding_club_id::text
                          AND r.ledger_snapshot->>''id''=r.ledger_id::text
                          AND r.ledger_snapshot->>''status''=''posted''
                          AND r.ledger_snapshot->>''from_type''=''player_wallet''
                          AND r.ledger_snapshot->>''to_type''=''prize_liability''
                          AND r.ledger_snapshot->>''category''=''addon''
                          AND r.ledger_snapshot->>''from_entity_id''=r.user_id::text
                          AND r.ledger_snapshot->>''to_entity_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''club_id''=r.funding_club_id::text
                          AND (r.ledger_snapshot->>''amount'')::numeric=r.amount
                          AND r.wallet_snapshot->>''id''=r.wallet_transaction_id::text
                          AND r.wallet_snapshot->>''type''=''debit''
                          AND r.wallet_snapshot->>''category''=''addon''
                          AND r.wallet_snapshot->>''user_id''=r.user_id::text
                          AND r.wallet_snapshot->>''related_entity_id''=r.tournament_id::text
                          AND (r.wallet_snapshot->>''amount'')::numeric=r.amount))
                      AND r.registration_snapshot->>''id''=tp.id::text
                      AND r.registration_snapshot->>''tournament_id''=p_tournament_id::text
                      AND r.registration_snapshot->>''user_id''=s.user_id::text
                      AND r.registration_snapshot->>''table_id''=s.table_id::text
                      AND (r.registration_snapshot->>''seat_number'')::integer=s.seat_number
                      AND r.registration_snapshot->>''add_on''=''true''
                      AND (r.registration_snapshot->>''chips'')::numeric=s.stack
                      AND r.tournament_snapshot->>''id''=p_tournament_id::text
                      AND (r.tournament_snapshot->>''addon_chips'')::numeric>0
                      AND r.amount=(r.tournament_snapshot->>''addon_cost'')::numeric
                      AND s.stack=(x->>''stack_before'')::numeric
                        +(r.tournament_snapshot->>''addon_chips'')::numeric)))) THEN
','  IF jsonb_typeof(c.payload::jsonb->''seats'') IS DISTINCT FROM ''array''
     OR jsonb_array_length(c.payload::jsonb->''seats'') = 0 THEN
    RAISE EXCEPTION ''HAND_CONTINUATION_ROSTER_CHANGED'' USING ERRCODE = ''55000'';
  END IF;
  SELECT CASE
    WHEN count(*) = jsonb_array_length(c.payload::jsonb->''seats'')
      AND count(DISTINCT x->>''user_id'') = count(*)
      AND count(DISTINCT x->>''seat_id'') = count(*)
    THEN jsonb_agg(jsonb_build_object(
      ''user_id'', x->>''user_id'', ''seat_id'', x->>''seat_id'',
      ''seat_joined_at'', x->>''seat_joined_at'',
      ''stack_before'', (x->>''stack_before'')::numeric,
      ''authorized_stack'', s.stack) ORDER BY ordinal)
    ELSE NULL END INTO chair_seats
  FROM jsonb_array_elements(c.payload::jsonb->''seats'') WITH ORDINALITY AS roster(x, ordinal)
  JOIN public.table_seats s ON s.id::text = x->>''seat_id'' AND s.table_id = p_table_id
                  AND s.user_id::text = x->>''user_id'' AND s.left_at IS NULL
                  AND s.joined_at = (x->>''seat_joined_at'')::timestamptz
                  AND (s.stack = (x->>''stack_before'')::numeric
                  OR EXISTS (
                    -- An add-on bought after this original was retained is
                    -- outside the hand. Its immutable funded receipt proves
                    -- the exact credit; delta settlement preserves it.
                    SELECT 1 FROM public.tournament_players tp
                    JOIN public.tournament_participant_funding_receipts r
                      ON r.registration_id=tp.id AND r.tournament_id=tp.tournament_id
                     AND r.user_id=tp.user_id
                    WHERE tp.tournament_id=p_tournament_id AND tp.user_id=s.user_id
                      AND tp.table_id=s.table_id AND tp.seat_number=s.seat_number
                      AND tp.add_on IS TRUE AND tp.chips=s.stack
                      AND r.operation=''addon'' AND r.observed_at>c.created_at
                      AND r.purchase_key=''tourney:''||p_tournament_id::text||'':addon:''||s.user_id::text
                      AND ((r.asset=''diamonds'' AND r.custody_result->>''success''=''true'')
                        OR (r.asset=''chips'' AND r.amount>0 AND r.custody_result IS NULL
                          AND r.entitlement_id IS NOT NULL AND r.ledger_id IS NOT NULL
                          AND r.wallet_transaction_id IS NOT NULL AND r.funding_club_id IS NOT NULL
                          AND r.entitlement_snapshot->>''id''=r.entitlement_id::text
                          AND r.entitlement_snapshot->>''entitlement_kind''=''wallet_charge''
                          AND r.entitlement_snapshot->>''charge_category''=''addon''
                          AND r.entitlement_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.entitlement_snapshot->>''user_id''=r.user_id::text
                          AND (r.entitlement_snapshot->>''gross'')::numeric=r.amount
                          AND r.entitlement_snapshot->>''source_ledger_id''=r.ledger_id::text
                          AND r.entitlement_snapshot->>''refund_wallet_club_id''=r.funding_club_id::text
                          AND r.ledger_snapshot->>''id''=r.ledger_id::text
                          AND r.ledger_snapshot->>''status''=''posted''
                          AND r.ledger_snapshot->>''from_type''=''player_wallet''
                          AND r.ledger_snapshot->>''to_type''=''prize_liability''
                          AND r.ledger_snapshot->>''category''=''addon''
                          AND r.ledger_snapshot->>''from_entity_id''=r.user_id::text
                          AND r.ledger_snapshot->>''to_entity_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''tournament_id''=r.tournament_id::text
                          AND r.ledger_snapshot->>''club_id''=r.funding_club_id::text
                          AND (r.ledger_snapshot->>''amount'')::numeric=r.amount
                          AND r.wallet_snapshot->>''id''=r.wallet_transaction_id::text
                          AND r.wallet_snapshot->>''type''=''debit''
                          AND r.wallet_snapshot->>''category''=''addon''
                          AND r.wallet_snapshot->>''user_id''=r.user_id::text
                          AND r.wallet_snapshot->>''related_entity_id''=r.tournament_id::text
                          AND (r.wallet_snapshot->>''amount'')::numeric=r.amount))
                      AND r.registration_snapshot->>''id''=tp.id::text
                      AND r.registration_snapshot->>''tournament_id''=p_tournament_id::text
                      AND r.registration_snapshot->>''user_id''=s.user_id::text
                      AND r.registration_snapshot->>''table_id''=s.table_id::text
                      AND (r.registration_snapshot->>''seat_number'')::integer=s.seat_number
                      AND r.registration_snapshot->>''add_on''=''true''
                      AND (r.registration_snapshot->>''chips'')::numeric=s.stack
                      AND r.tournament_snapshot->>''id''=p_tournament_id::text
                      AND (r.tournament_snapshot->>''addon_chips'')::numeric>0
                      AND r.amount=(r.tournament_snapshot->>''addon_cost'')::numeric
                      AND s.stack=(x->>''stack_before'')::numeric
                        +(r.tournament_snapshot->>''addon_chips'')::numeric));
  IF chair_seats IS NULL THEN
');
 IF length(d)-length(replace(d,'    ''continuation'', jsonb_build_object(''payload'', c.payload, ''sha256'', c.payload_sha256,',''))<>length('    ''continuation'', jsonb_build_object(''payload'', c.payload, ''sha256'', c.payload_sha256,') THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHAIR_SHAPE_CHANGED';END IF;
 d:=replace(d,'    ''continuation'', jsonb_build_object(''payload'', c.payload, ''sha256'', c.payload_sha256,','    ''chair_admission'', jsonb_build_object(
      ''version'', 1, ''tournament_id'', p_tournament_id, ''table_id'', p_table_id,
      ''writer_generation'', p_lease_generation, ''original_generation'', c.original_generation,
      ''hand_number'', c.hand_number::text, ''sequence'', c.sequence::text,
      ''payload_sha256'', c.payload_sha256, ''seats'', chair_seats),
    ''continuation'', jsonb_build_object(''payload'', c.payload, ''sha256'', c.payload_sha256,');
 EXECUTE d;
 IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)') AND md5(p.prosrc)='3559c5f8827038de5a8be56a30ee44ac' AND md5(pg_get_functiondef(p.oid))='dd354c3443d359b21a9839f27582dc60' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])) THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHAIR_POSTIMAGE_CHANGED';END IF;
END $chairs$;
COMMIT;
