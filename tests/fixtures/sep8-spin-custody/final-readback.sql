SELECT jsonb_agg(jsonb_build_object(
 'tournament_id',c.tournament_id,'tournament',(SELECT to_jsonb(t) FROM public.tournaments t WHERE id=c.tournament_id),
 'players',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_players p WHERE tournament_id=c.tournament_id),
 'winner_wallet',(SELECT to_jsonb(m) FROM public.club_members m WHERE club_id=c.winner_club_id AND user_id=c.winner_id),
 'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id=c.tournament_id),
 'payouts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p WHERE tournament_id=c.tournament_id),
 'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.chip_ledger l WHERE tournament_id=c.tournament_id OR from_entity_id=c.tournament_id OR to_entity_id=c.tournament_id),
 'tables',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tables t WHERE tournament_id=c.tournament_id),
 'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id=c.tournament_id),
 'table_leases',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.table_id),'[]') FROM public.engine_table_leases l JOIN public.tables t ON t.id=l.table_id WHERE t.tournament_id=c.tournament_id),
 'manager_lease',(SELECT to_jsonb(l) FROM public.engine_tournament_leases l WHERE tournament_id=c.tournament_id),
 'standings',(SELECT to_jsonb(w) FROM smarter_private.spin_original_standings w WHERE tournament_id=c.tournament_id),
 'original_funding',public.fn_ca_sep8_spin_original_fee_proof(c.tournament_id),
 'raw_fee_count',(SELECT count(*) FROM public.rake_records WHERE tournament_id=c.tournament_id),
 'raw_fee_fingerprint',(SELECT md5(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id)) FROM public.rake_records r WHERE tournament_id=c.tournament_id),
 'fee_sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.accounting_tournament_fee_sources s WHERE tournament_id=c.tournament_id),
 'header',(SELECT to_jsonb(t) FROM public.tournament_terminal_settlements t WHERE tournament_id=c.tournament_id),
 'receipt',public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id)) ORDER BY c.tournament_id)
FROM sep8_spin_fixture.cases c;
