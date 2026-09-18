-- Observe the actual Union autoledger input inside its original transaction.
-- Faults use only altered JSON passed to the private predicate, never writes.
CREATE FUNCTION sep8_spin_fixture.assert_union_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE patch jsonb;kind text;document jsonb;BEGIN
 IF NEW.to_type<>'union_wallet' OR NEW.to_label IS DISTINCT FROM 'union_wallets.rake_wallet'
  OR NOT EXISTS(SELECT 1 FROM sep8_spin_fixture.cases WHERE tournament_id=NEW.from_entity_id) THEN RETURN NEW; END IF;
 document:=to_jsonb(NEW);
 IF TG_WHEN='AFTER' THEN
  PERFORM sep8_spin_fixture.assert(public.fn_ca_legacy_fee_resolution_write_is_exact('chip_ledger','INSERT',NULL,document) IS DISTINCT FROM true,
   'Duplicate original Union bank journal refuses '||NEW.from_entity_id);
  RETURN NEW;
 END IF;
 PERFORM sep8_spin_fixture.assert(public.fn_ca_legacy_fee_resolution_write_is_exact('chip_ledger','INSERT',NULL,document) IS TRUE,
  'Actual original Union bank journal passes exact private authority '||NEW.from_entity_id);
 FOR kind,patch IN SELECT * FROM(VALUES
  ('union',jsonb_build_object('union_id',gen_random_uuid())),
  ('wallet',jsonb_build_object('to_entity_id',gen_random_uuid())),
  ('amount',jsonb_build_object('amount',NEW.amount+0.01)),
  ('delta',jsonb_build_object('post_to_balance',NEW.post_to_balance+0.01)),
  ('prior_balance',jsonb_build_object('pre_to_balance',-1)),
  ('event',jsonb_build_object('tournament_id',gen_random_uuid())),
  ('source',jsonb_build_object('from_entity_id',gen_random_uuid())),
  ('category',jsonb_build_object('category','transfer')),
  ('metadata',jsonb_build_object('metadata',jsonb_build_object('satellite_id',gen_random_uuid()))),
  ('target_bank',jsonb_build_object('to_type','union_bank')),
  ('target_label',jsonb_build_object('to_label','union_wallets.chip_balance'))
 )q(label,value) LOOP
  PERFORM sep8_spin_fixture.assert(public.fn_ca_legacy_fee_resolution_write_is_exact('chip_ledger','INSERT',NULL,document||patch) IS DISTINCT FROM true,
   'Altered original Union journal '||kind||' refuses '||NEW.from_entity_id);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER a000_sep8_native_union_journal BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION sep8_spin_fixture.assert_union_journal();
CREATE TRIGGER zzzz_sep8_native_union_journal AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION sep8_spin_fixture.assert_union_journal();
