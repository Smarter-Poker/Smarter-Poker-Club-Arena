-- Exercise the real settings trigger, original journal, reader and report.
SELECT assert_true((SELECT count(*)=0 FROM accounting_agreement_history WHERE entity_type='unions'),
 'installation does not convert current ECO settings into historical agreements');
SELECT assert_true(fn_union_eco_terms_evidence(u(80),'2026-09-07 07:00Z','2026-09-14 07:00Z')->>'status'='blocked',
 'the missing original week stays blocked despite explicit current settings');

UPDATE unions SET settings=jsonb_set(settings,'{eco_rate}','0.12') WHERE id=u(80);
SELECT observed_at AS eco_t1 FROM accounting_agreement_history WHERE union_id=u(80) ORDER BY id DESC LIMIT 1 \gset
SELECT assert_true((SELECT event_type='UPDATE' AND actor_id=u(99) AND union_id=u(80) AND club_id IS NULL
 AND before_terms->'eco_rate'='0.1'::jsonb AND after_terms->'eco_rate'='0.12'::jsonb
 AND NOT after_terms ? 'private_note' FROM accounting_agreement_history WHERE union_id=u(80)),
 'actual settings write captures actor, exact before/after terms and Union scope without private settings');
SELECT assert_true(fn_union_eco_terms_evidence(u(80),:'eco_t1',statement_timestamp())->>'status'='ready',
 'complete explicit terms qualify only from their original observed settings write');
SELECT assert_true(fn_union_eco_terms_evidence(u(80),:'eco_t1'::timestamptz-interval '1 microsecond',statement_timestamp())->>'status'='blocked',
 'one missing microsecond at the opening cannot be certified');
SELECT assert_true(NOT fn_union_pnl_evidence_report(u(80),:'eco_t1',statement_timestamp())->'issues' ? 'eco_commercial_basis_uncertified'
 AND fn_union_pnl_evidence_report(u(80),:'eco_t1',statement_timestamp())->'issues' ?& ARRAY[
 'canonical_pnl_coverage_manifest_missing','boundary_snapshot_provenance_missing','participant_earning_ownership_receipt_missing',
 'historical_game_asset_and_union_coverage_missing','tournament_earning_and_open_equity_basis_uncertified']
 AND fn_union_pnl_evidence_report(u(80),:'eco_t1',statement_timestamp())->'basis_certified'='false'::jsonb
 AND fn_union_pnl_evidence_report(u(80),:'eco_t1',statement_timestamp())->'payment_authorized'='false'::jsonb
 AND fn_union_pnl_evidence_report(u(80),:'eco_t1',statement_timestamp())->'all_players_included'='false'::jsonb,
 'connected report clears only proved ECO terms and retains all five other gaps, payment refusal and truthful population coverage');

UPDATE unions SET settings=settings WHERE id=u(80);
UPDATE unions SET settings=jsonb_set(settings,'{private_note}','"later"') WHERE id=u(80);
SELECT assert_true((SELECT count(*)=1 FROM accounting_agreement_history WHERE union_id=u(80)),
 'duplicate save and unrelated settings changes cannot manufacture agreement events');
UPDATE unions SET settings=jsonb_set(settings,'{eco_rate}','0.15') WHERE id=u(80);
SELECT observed_at AS eco_t2 FROM accounting_agreement_history WHERE union_id=u(80) ORDER BY id DESC LIMIT 1 \gset
SELECT assert_true(fn_union_eco_terms_evidence(u(80),:'eco_t1',:'eco_t2')->'segments'->0->'terms'->'eco_rate'='0.12'::jsonb
 AND jsonb_array_length(fn_union_eco_terms_evidence(u(80),:'eco_t1',:'eco_t2')->'segments')=1,
 'half-open closing boundary retains original rate and excludes the change at period end');
SELECT assert_true(fn_union_eco_terms_evidence(u(80),:'eco_t2',statement_timestamp())->'segments'->0->'terms'->'eco_rate'='0.15'::jsonb
 AND jsonb_array_length(fn_union_eco_terms_evidence(u(80),:'eco_t1',statement_timestamp())->'segments')=2,
 'an exact boundary selects the new rate and a changing interval retains both term segments');

DO $$DECLARE n bigint; old_settings jsonb;
BEGIN
 SELECT count(*) INTO n FROM accounting_agreement_history;
 SELECT settings INTO old_settings FROM unions WHERE id=u(80);
 BEGIN
  UPDATE unions SET settings=jsonb_set(settings,'{eco_rate}','0.19') WHERE id=u(80);
  RAISE EXCEPTION USING ERRCODE='ZX001',MESSAGE='rollback fixture';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
 PERFORM assert_true((SELECT count(*)=n FROM accounting_agreement_history)
  AND (SELECT settings=old_settings FROM unions WHERE id=u(80)),
  'rolled-back settings write leaves neither a changed commercial term nor a receipt');
END $$;

-- Normal writers cannot append, edit, remove or truncate the evidence.
SELECT assert_true(refuses('UPDATE accounting_agreement_history SET observed_at=observed_at-interval ''1 day'' WHERE union_id=u(80)','55000')
 AND refuses('DELETE FROM accounting_agreement_history WHERE union_id=u(80)','55000')
 AND refuses('TRUNCATE accounting_agreement_history','55000'),'Union history cannot be backdated, deleted or truncated');
SET ROLE service_role;
SELECT assert_true(fn_union_pnl_evidence_report(u(80),:'eco_t1',statement_timestamp())->'eco_commercial_terms_evidence'->>'status'='ready'
 AND fn_union_pnl_evidence_report(u(80),:'eco_t1',statement_timestamp())->>'status'='blocked',
 'the established service report exposes qualified commercial evidence without authorizing the incomplete close');
SELECT assert_true(refuses('INSERT INTO accounting_agreement_history(entity_type,entity_key,union_id,event_type,after_terms) VALUES(''unions'',u(80)::text,u(80),''INSERT'',''{}'')','42501'),
 'service caller cannot append a fabricated ECO agreement');
SELECT assert_true(refuses('SELECT fn_union_eco_terms_evidence(u(80),now()-interval ''1 day'',now())','42501'),
 'private ECO helper cannot be called directly by service callers');
RESET ROLE;
SET ROLE authenticated;
SELECT assert_true(refuses('SELECT * FROM accounting_agreement_history','42501')
 AND refuses('SELECT fn_union_pnl_evidence_report(u(80),now()-interval ''1 day'',now())','42501'),
 'an authenticated client cannot read private commercial terms or bypass the service report');
RESET ROLE;

-- Owner-only corrupt fixtures establish negative controls, never valid coverage.
BEGIN;
INSERT INTO accounting_agreement_history(entity_type,entity_key,union_id,event_type,observed_at,before_terms,after_terms)
 SELECT entity_type,entity_key,union_id,event_type,observed_at,before_terms,after_terms
 FROM accounting_agreement_history WHERE union_id=u(80) ORDER BY id DESC LIMIT 1;
SELECT assert_true(fn_union_eco_terms_evidence(u(80),:'eco_t2',statement_timestamp())->>'status'='blocked',
 'two observations with an identical effective timestamp are ambiguous, not last-row-wins');
ROLLBACK;
BEGIN;
INSERT INTO accounting_agreement_history(entity_type,entity_key,union_id,event_type,after_terms)
 VALUES('unions',u(80)::text,u(80),'baseline','{"eco_enabled":true,"eco_base_mode":"club_cash_profit","eco_rate":0.1,"eco_include_horses":true}');
SELECT assert_true(fn_union_eco_terms_evidence(u(80),:'eco_t1',statement_timestamp())->>'status'='blocked',
 'an observation baseline is never original settings-write authority');
ROLLBACK;
BEGIN;
INSERT INTO accounting_agreement_history(entity_type,entity_key,union_id,event_type,before_terms,after_terms)
 SELECT entity_type,entity_key,union_id,'UPDATE','{}',after_terms
 FROM accounting_agreement_history WHERE union_id=u(80) ORDER BY id DESC LIMIT 1;
SELECT assert_true(fn_union_eco_terms_evidence(u(80),:'eco_t1',statement_timestamp())->>'status'='blocked',
 'a discontinuous before/after history cannot qualify an interval');
ROLLBACK;

-- Each rejected policy is written through the real settings trigger.
DO $$DECLARE bad jsonb; n int:=0;
BEGIN
 FOR bad IN SELECT value FROM jsonb_array_elements('[
  {},{"eco_enabled":true,"eco_rate":0.1,"eco_include_horses":true},
  {"eco_enabled":"true","eco_base_mode":"club_cash_profit","eco_rate":0.1,"eco_include_horses":true},
  {"eco_enabled":true,"eco_base_mode":"guess","eco_rate":0.1,"eco_include_horses":true},
  {"eco_enabled":true,"eco_base_mode":"club_cash_profit","eco_rate":-0.1,"eco_include_horses":true},
  {"eco_enabled":true,"eco_base_mode":"club_cash_profit","eco_rate":1.01,"eco_include_horses":true},
  {"eco_enabled":true,"eco_base_mode":"club_cash_profit","eco_rate":"NaN","eco_include_horses":true},
  {"eco_enabled":true,"eco_base_mode":"club_cash_profit","eco_rate":0.1,"eco_include_horses":false}
 ]'::jsonb) LOOP
  n:=n+1;
  INSERT INTO unions VALUES(u(100+n),bad);
 END LOOP;
END $$;
SELECT assert_true((SELECT bool_and(public.fn_union_eco_terms_evidence(union_id,observed_at,statement_timestamp())->>'status'='blocked')
 FROM accounting_agreement_history WHERE union_id BETWEEN u(101) AND u(108)),
 'missing keys, invalid types or modes, negative or excessive rates, NaN and horse exclusion never qualify');

INSERT INTO unions VALUES(u(90),'{"eco_enabled":false,"eco_base_mode":"winnings_only","eco_rate":0,"eco_include_horses":true}');
SELECT assert_true((SELECT fn_union_eco_terms_evidence(union_id,observed_at,statement_timestamp())->>'status'='ready'
 FROM accounting_agreement_history WHERE union_id=u(90)),
 'explicit disabled ECO with complete terms is distinct from a default disabled setting');
INSERT INTO unions
 SELECT u(120+ordinality::int),jsonb_build_object('eco_enabled',true,'eco_base_mode',mode,'eco_rate',0.1,'eco_include_horses',true)
 FROM unnest(ARRAY['club_cash_profit','net_invoice_position','winnings_plus_rake','winnings_only']) WITH ORDINALITY AS modes(mode,ordinality);
SELECT assert_true((SELECT count(*)=4 AND bool_and(fn_union_eco_terms_evidence(union_id,observed_at,statement_timestamp())->>'status'='ready')
 FROM accounting_agreement_history WHERE union_id BETWEEN u(121) AND u(124)),
 'all four established formula modes retain their explicit identity without introducing a new ECO formula');
UPDATE unions SET id=u(91) WHERE id=u(90);
SELECT assert_true((SELECT after_terms IS NULL FROM accounting_agreement_history WHERE union_id=u(90) ORDER BY id DESC LIMIT 1)
 AND (SELECT event_type='INSERT' AND before_terms IS NULL FROM accounting_agreement_history WHERE union_id=u(91)),
 'a moved Union identity closes the original scope and starts new coverage without adopting its history');
DELETE FROM unions WHERE id=u(80);
SELECT assert_true(fn_union_eco_terms_evidence(u(80),:'eco_t1',statement_timestamp())->>'status'='blocked',
 'deletion inside the interval leaves an explicit coverage gap');
SELECT assert_true(fn_union_eco_terms_evidence(u(90),now(),now())->>'status'='blocked'
 AND fn_union_eco_terms_evidence(u(90),now(),now()+interval '1 second')->>'status'='blocked'
 AND fn_union_eco_terms_evidence(u(90),'-infinity',now())->>'status'='blocked',
 'empty, open and nonfinite accounting intervals refuse');
