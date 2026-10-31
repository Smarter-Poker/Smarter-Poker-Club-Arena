# The stock isolation tester starts two genuine PostgreSQL sessions. The
# second request is blocked on the first owner's uncommitted ticket use;
# only the separately executed wait proof releases the first transaction.
session "first"
# The retained private transaction owner is postgres-only; use its actual ACL
# exactly as the existing funded scene, never widen it for qualification.
setup { SET application_name='value-ticket-first'; SET statement_timeout='25s'; SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,false); }
step "first_begin" { BEGIN; }
step "first_entry" {
 DO $first$ DECLARE c jsonb; r jsonb; BEGIN
  SELECT data INTO STRICT c FROM public.native_value_ticket_race_context WHERE asset='@ASSET@';
  r:=public.fn_ca_register_for_tournament_with_ticket_for((c->>'dest')::uuid,(c->>'ticket')::uuid,(c->>'holder')::uuid);
  IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'replayed' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'first entry differs: %',r; END IF;
  RAISE NOTICE 'VALUE_TICKET_FIRST_ENTRY';
 END $first$;
}
step "wait_proven" {
 RESET ROLE;
 DO $wait$ DECLARE waiting record; BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.application_name='value-ticket-second'
    AND a.pid<>pg_backend_pid() AND a.datname=current_database() AND a.state='active'
    AND a.wait_event_type='Lock' AND a.wait_event IN ('transactionid','tuple')
    AND pg_backend_pid()=ANY(pg_blocking_pids(a.pid))) THEN
   RAISE EXCEPTION 'VALUE_TICKET_ACTUAL_WAIT_MISSING';
  END IF;
  SELECT pid,wait_event,pg_blocking_pids(pid) blockers INTO STRICT waiting FROM pg_stat_activity WHERE application_name='value-ticket-second' AND datname=current_database();
  RAISE NOTICE 'VALUE_TICKET_WAIT_EVIDENCE=%',jsonb_build_object('first_pid',pg_backend_pid(),'second_pid',waiting.pid,'wait_event',waiting.wait_event,'blocking_pids',waiting.blockers);
  RAISE NOTICE 'VALUE_TICKET_DISTINCT_BACKEND_WAIT_PROVEN';
 END $wait$;
}
step "first_commit" { COMMIT; }
step "first_rollback" { ROLLBACK; }

session "second"
setup { SET application_name='value-ticket-second'; SET statement_timeout='25s'; SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,false); }
step "second_entry" {
 DO $second$ DECLARE c jsonb; r jsonb; BEGIN
  SELECT data INTO STRICT c FROM public.native_value_ticket_race_context WHERE asset='@ASSET@';
  r:=public.fn_ca_register_for_tournament_with_ticket_for((c->>'other')::uuid,(c->>'ticket')::uuid,(c->>'holder')::uuid);
  IF '@RELEASE@'='commit' THEN
   IF r->>'ok' IS DISTINCT FROM 'false' OR r->>'reason' IS DISTINCT FROM 'ticket_already_used' THEN RAISE EXCEPTION 'loser lacks authoritative prior consumption: %',r; END IF;
   RAISE NOTICE 'VALUE_TICKET_SECOND_REFUSED';
  ELSE
   IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'replayed' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'rollback successor differs: %',r; END IF;
   RAISE NOTICE 'VALUE_TICKET_SECOND_ENTRY';
  END IF;
 END $second$;
}
step "verify_effects" {
 RESET ROLE;
 DO $verify$ DECLARE c jsonb; winner uuid; loser uuid; tk uuid; holder uuid; registration uuid; r jsonb; BEGIN
  SELECT data INTO STRICT c FROM public.native_value_ticket_race_context WHERE asset='@ASSET@';
  winner:=(c->>CASE WHEN '@RELEASE@'='commit' THEN 'dest' ELSE 'other' END)::uuid;
  loser:=(c->>CASE WHEN '@RELEASE@'='commit' THEN 'other' ELSE 'dest' END)::uuid;
  tk:=(c->>'ticket')::uuid; holder:=(c->>'holder')::uuid;
  IF winner=loser OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id IN(winner,loser) AND user_id=holder)<>1
    OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=loser)
    OR NOT EXISTS(SELECT 1 FROM public.tournament_tickets WHERE id=tk AND status='redeemed') THEN RAISE EXCEPTION 'not exactly one destination consumption'; END IF;
  SELECT id INTO STRICT registration FROM public.tournament_players WHERE tournament_id=winner AND user_id=holder;
  -- Replay first, then validate every final wallet/entry/backing assertion so
  -- even an extra side effect during this replay fails the same exact proof.
  r:=public.fn_ca_register_for_tournament_with_ticket_for(winner,tk,holder);
  IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'replayed' IS DISTINCT FROM 'true' OR r->>'registration_id' IS DISTINCT FROM registration::text THEN RAISE EXCEPTION 'original operation replay differs'; END IF;
  IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id IN(winner,loser) AND user_id=holder)<>1 THEN RAISE EXCEPTION 'replay added entry'; END IF;
  IF (SELECT jsonb_agg(jsonb_build_array(club_id,user_id,chip_balance) ORDER BY club_id,user_id) FROM public.club_members) IS DISTINCT FROM c->'wallets'
    OR (SELECT jsonb_agg(jsonb_build_array(id,diamonds) ORDER BY id) FROM public.profiles) IS DISTINCT FROM c->'diamonds' THEN RAISE EXCEPTION 'race changed wallets'; END IF;
  IF '@ASSET@'='chips' THEN
   IF (SELECT count(*) FROM public.tournament_refund_entitlements WHERE source_ticket_id=tk)<>1
     OR NOT EXISTS(SELECT 1 FROM public.tournament_refund_entitlements WHERE source_ticket_id=tk AND registration_id=registration AND tournament_id=winner AND gross=50 AND refund_prize=35 AND refund_bounty=10 AND refund_fee=5)
     OR (SELECT count(*) FROM public.chip_transactions WHERE transaction_type='tournament_ticket_entry' AND metadata->>'ticket_id'=tk::text)<>1
     OR (SELECT count(*) FROM public.chip_ledger WHERE category='ticket_redeem' AND from_entity_id=tk)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chip_ledger WHERE category='ticket_redeem' AND from_entity_id=tk AND to_entity_id=winner AND tournament_id=winner AND amount=50 AND metadata->>'registration_id'=registration::text)
     OR (SELECT count(*) FROM public.rake_records WHERE metadata->>'ticket_id'=tk::text)<>1
     OR NOT EXISTS(SELECT 1 FROM public.rake_records WHERE metadata->>'ticket_id'=tk::text AND tournament_id=winner AND rake_amount=5 AND metadata->>'registration_id'=registration::text)
     OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=winner AND prize_balance=35 AND bounty_balance=10 AND fee_balance=5)
     OR EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=loser AND prize_balance+bounty_balance+fee_balance<>0) THEN RAISE EXCEPTION 'Chip race funding differs'; END IF;
  ELSE
   IF (SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE request->>'ticket_id'=tk::text AND kind='entry')<>1
     OR NOT EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger WHERE request->>'ticket_id'=tk::text AND kind='entry' AND registration_id=registration AND tournament_id=winner AND amount=50 AND prize_part=46 AND fee_part=4 AND wallet_journal_id IS NULL)
     OR (SELECT count(*) FROM public.poker_diamond_movements WHERE request->>'ticket_id'=tk::text AND action='reserve')<>1
     OR NOT EXISTS(SELECT 1 FROM public.poker_diamond_movements WHERE request->>'ticket_id'=tk::text AND action='reserve' AND amount=50 AND wallet_journal_id IS NULL)
     OR public.fn_poker_diamond_tournament_custody(winner)<>50 OR public.fn_poker_diamond_tournament_custody(loser)<>0
     OR public.fn_ca_diamond_value_ticket_float(NULL)<>50
     OR (SELECT sum(diamonds)+public.fn_ca_arena_diamonds() FROM public.profiles)<>(c->>'diamond_total')::numeric
     OR EXISTS(SELECT 1 FROM public.diamond_transactions WHERE reference_id IN('poker-value-ticket-issue:'||tk::text,'poker-value-ticket-entry:'||tk::text))
     OR EXISTS(SELECT 1 FROM public.ca_mint_ledger WHERE op_id IN('poker-value-ticket-issue:'||tk::text,'poker-value-ticket-entry:'||tk::text)) THEN RAISE EXCEPTION 'Diamond race funding differs'; END IF;
  END IF;
  PERFORM public.fn_ca_assert_satellite_value_ticket(tk);
  IF public.fn_ca_satellite_cohort_receipt((c->>'source')::uuid,ARRAY(SELECT user_id FROM public.tournament_satellite_awards WHERE tournament_id=(c->>'source')::uuid ORDER BY user_id)) IS DISTINCT FROM c->'receipt' THEN RAISE EXCEPTION 'source immutable receipt changed'; END IF;
  RAISE NOTICE 'VALUE_TICKET_EXACT_EFFECTS_PROVEN';
 END $verify$;
}
permutation "first_begin" "first_entry" "second_entry" "wait_proven" "first_@RELEASE@" "verify_effects"
