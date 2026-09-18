DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT l.* FROM public.chip_ledger l JOIN sep8_spin_fixture.cases c ON c.tournament_id=l.from_entity_id
 WHERE l.from_type='prize_liability' AND l.to_type='union_wallet' AND l.to_label='union_wallets.rake_wallet' LOOP
  PERFORM sep8_spin_fixture.assert(public.fn_ca_legacy_fee_resolution_write_is_exact('chip_ledger','INSERT',NULL,to_jsonb(r)) IS DISTINCT FROM true,
   'Original Union journal cannot reuse expired transaction authority '||r.from_entity_id);
 END LOOP;
 PERFORM sep8_spin_fixture.assert((SELECT count(*) FROM public.chip_ledger l JOIN sep8_spin_fixture.cases c ON c.tournament_id=l.from_entity_id
 WHERE l.from_type='prize_liability' AND l.to_type='union_wallet' AND l.to_label='union_wallets.rake_wallet')=
 (SELECT count(*) FROM sep8_spin_fixture.cases WHERE union_id IS NOT NULL),
 'Exactly one original Union bank leg per resolved Union event');
END $$;
DROP TRIGGER a000_sep8_native_union_journal ON public.chip_ledger;
DROP TRIGGER zzzz_sep8_native_union_journal ON public.chip_ledger;
