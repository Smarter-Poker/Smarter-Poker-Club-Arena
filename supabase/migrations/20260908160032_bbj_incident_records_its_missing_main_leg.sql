-- The 0.50 contribution from hand 7882379 allocated 0.25 main, 0.12 backup,
-- and 0.13 promo. Failure 871 and both surviving legs share its exact timestamp.
-- The main balance movement committed under the old swallowed-error trigger,
-- but its journal leg did not. The trigger now rethrows (20260908024909).
-- This one-time, source-bound journal insertion moves NO balance. created_at
-- retains the witnessed event time for existing temporal accounting; metadata
-- records the actual append time, source IDs, and the prior incident diagnosis.
-- It changes no rate, payout, wallet, bank, existing journal row, or schedule.
DO $correction$
DECLARE
  i public.ca_drift_incidents%ROWTYPE;
  c public.bbj_contributions%ROWTYPE;
  f public.ca_ledger_write_failures%ROWTYPE;
  b public.chip_ledger%ROWTYPE;
  p public.chip_ledger%ROWTYPE;
  existing public.chip_ledger%ROWTYPE;
  leg_id uuid;
  operation_key text;
  appended_at timestamptz := clock_timestamp();
  snapshot_row public.ca_bbj_pool_snapshots%ROWTYPE;
  previous_row public.ca_bbj_pool_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO i FROM public.ca_drift_incidents
    WHERE id='ca15a882-0066-425f-94a7-2a6cf636840e' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF; -- This historical event is absent in new databases.
  SELECT * INTO STRICT c FROM public.bbj_contributions
    WHERE id='f390afc0-7cb4-432f-9ef7-9bc8a00245dc' FOR UPDATE;
  operation_key := 'bbj-source-main-leg:' || c.id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(operation_key,0));
  IF c.amount IS DISTINCT FROM 0.50 OR c.main_portion IS DISTINCT FROM 0.25
     OR c.backup_portion IS DISTINCT FROM 0.12 OR c.promo_portion IS DISTINCT FROM 0.13
     OR c.amount IS DISTINCT FROM c.main_portion+c.backup_portion+c.promo_portion
     OR c.hand_number IS DISTINCT FROM 7882379
     OR c.created_at IS DISTINCT FROM '2026-09-08 02:18:10.791319+00'::timestamptz
     OR c.pool_id IS DISTINCT FROM i.entity_id OR c.club_id IS DISTINCT FROM i.club_id
     OR i.source IS DISTINCT FROM 'fn_bbj_reconcile'
     OR i.metadata->>'snapshot_id' IS DISTINCT FROM '249'
     OR (i.metadata->>'unexplained_main')::numeric IS DISTINCT FROM c.main_portion
     OR NOT EXISTS(SELECT 1 FROM public.hand_history h
        WHERE h.id=c.hand_id AND h.table_id=c.table_id AND h.hand_number=c.hand_number)
  THEN RAISE EXCEPTION 'BBJ correction source identity or allocation changed'; END IF;
  SELECT * INTO STRICT snapshot_row FROM public.ca_bbj_pool_snapshots WHERE id=249;
  SELECT * INTO STRICT previous_row FROM public.ca_bbj_pool_snapshots WHERE id=snapshot_row.prev_id;
  IF snapshot_row.pool_id IS DISTINCT FROM c.pool_id OR previous_row.pool_id IS DISTINCT FROM c.pool_id
     OR NOT (c.created_at>previous_row.taken_at AND c.created_at<=snapshot_row.taken_at)
     OR snapshot_row.unexplained_main IS DISTINCT FROM c.main_portion
     OR snapshot_row.unexplained_backup IS DISTINCT FROM 0
     OR snapshot_row.unexplained_promo IS DISTINCT FROM 0
     OR snapshot_row.write_failures IS DISTINCT FROM 1
  THEN RAISE EXCEPTION 'BBJ correction snapshot does not identify the missing main leg'; END IF;
  SELECT * INTO STRICT f FROM public.ca_ledger_write_failures WHERE id=871;
  IF f.delta IS DISTINCT FROM c.main_portion OR f.club_id IS DISTINCT FROM c.club_id
     OR f.user_id IS DISTINCT FROM c.pool_id OR f.occurred_at IS DISTINCT FROM c.created_at
     OR f.sqlstate IS DISTINCT FROM '55P03'
     OR f.message IS DISTINCT FROM 'fn_ca_autoledger bbj_pools.main_balance: canceling statement due to lock timeout'
  THEN RAISE EXCEPTION 'BBJ correction write-failure evidence changed'; END IF;
  SELECT * INTO STRICT b FROM public.chip_ledger WHERE id='ab13105c-6ef3-4381-8cae-e061f70c93c2';
  SELECT * INTO STRICT p FROM public.chip_ledger WHERE id='e6b81927-1f96-411e-bfe8-7e568b310809';
  IF b.amount IS DISTINCT FROM c.backup_portion OR p.amount IS DISTINCT FROM c.promo_portion
     OR b.description IS DISTINCT FROM 'auto-ledgered bbj_pools.backup_balance delta 0.12'
     OR p.description IS DISTINCT FROM 'auto-ledgered bbj_pools.promo_balance delta 0.13'
     OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id IN(b.id,p.id)
       AND (l.from_type IS DISTINCT FROM 'table_stack' OR l.from_entity_id IS DISTINCT FROM c.table_id
         OR l.to_type IS DISTINCT FROM 'bbj_pool' OR l.to_entity_id IS DISTINCT FROM c.pool_id
         OR l.category IS DISTINCT FROM 'bbj_contribution' OR l.club_id IS DISTINCT FROM c.club_id
         OR l.table_id IS DISTINCT FROM c.table_id OR l.hand_id IS DISTINCT FROM c.hand_id
         OR l.created_at IS DISTINCT FROM c.created_at))
     OR b.performed_by IS DISTINCT FROM p.performed_by
  THEN RAISE EXCEPTION 'BBJ correction surviving legs changed'; END IF;
  SELECT * INTO existing FROM public.chip_ledger WHERE idempotency_key=operation_key;
  IF FOUND THEN
    IF existing.amount IS DISTINCT FROM c.main_portion
       OR existing.from_type IS DISTINCT FROM 'table_stack' OR existing.from_entity_id IS DISTINCT FROM c.table_id
       OR existing.to_type IS DISTINCT FROM 'bbj_pool' OR existing.to_entity_id IS DISTINCT FROM c.pool_id
       OR existing.category IS DISTINCT FROM 'bbj_contribution' OR existing.hand_id IS DISTINCT FROM c.hand_id
       OR existing.club_id IS DISTINCT FROM c.club_id OR existing.table_id IS DISTINCT FROM c.table_id
       OR existing.to_label IS DISTINCT FROM 'bbj_pools.main_balance'
       OR existing.created_at IS DISTINCT FROM c.created_at
       OR existing.metadata->>'source_contribution_id' IS DISTINCT FROM c.id::text
       OR i.correction_ref IS DISTINCT FROM 'chip_ledger:' || existing.id::text
       OR i.metadata->'source_main_leg_correction'->>'leg_id' IS DISTINCT FROM existing.id::text
    THEN RAISE EXCEPTION 'BBJ correction replay does not match its receipt'; END IF;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM public.chip_ledger l
    WHERE l.hand_id=c.hand_id AND l.category='bbj_contribution' AND l.id NOT IN(b.id,p.id))
  THEN RAISE EXCEPTION 'BBJ correction refused: another hand contribution leg exists'; END IF;
  INSERT INTO public.chip_ledger
    (performed_by,from_type,from_entity_id,to_type,to_entity_id,to_label,
     amount,category,description,notes,club_id,table_id,hand_id,settlement_id,
     idempotency_key,created_at,actor_service,metadata)
  VALUES
    (b.performed_by,'table_stack',c.table_id,'bbj_pool',c.pool_id,'bbj_pools.main_balance',
     c.main_portion,'bbj_contribution',
     'Historical main BBJ contribution, hand #7882379: omitted journal leg only',
     'No balance movement. Event time retained; actual append time is metadata.recorded_at.',
     c.club_id,c.table_id,c.hand_id,'bbj:'||c.hand_id::text,
     operation_key,c.created_at,'bbj-source-correction',
     jsonb_build_object('source_contribution_id',c.id,'write_failure_id',f.id,
       'incident_id',i.id,'bank','main','recorded_at',appended_at,'occurred_at',c.created_at,
       'journal_only',true,'original_actor',b.performed_by,'correction_db_role',current_user))
  RETURNING id INTO leg_id;
  IF (SELECT sum(amount) FROM public.chip_ledger
      WHERE hand_id=c.hand_id AND category='bbj_contribution') IS DISTINCT FROM c.amount
  THEN RAISE EXCEPTION 'BBJ correction does not conserve the recorded contribution'; END IF;
  UPDATE public.ca_drift_incidents SET
    hand_id=c.hand_id,table_id=c.table_id,status='resolved',resolved_at=appended_at,
    ledger_balanced=true,auto_repair_status='not_applicable',
    root_cause='Hand #7882379: the 0.50 BBJ contribution split correctly into 0.25 main, 0.12 backup and 0.13 promo. The old autoledger swallowed a main-leg lock timeout (failure 871), allowing the balance movement without its 0.25 journal entry. This was an omitted leg, not journal lag.',
    resolution='Appended the proven missing 0.25 main journal entry only. The three BBJ legs now total the original 0.50 contribution. No player, table, main, backup or promo balance was changed. The source trigger was previously hardened to abort the entire movement on a journal failure. This resolves this identified omission, not a certification of every pool or incident.',
    correction_ref='chip_ledger:'||leg_id::text,
    metadata=COALESCE(i.metadata,'{}'::jsonb)||jsonb_build_object('source_main_leg_correction',
      jsonb_build_object('leg_id',leg_id,'source_contribution_id',c.id,'write_failure_id',f.id,
        'recorded_at',appended_at,'previous_incident',to_jsonb(i)))
  WHERE id=i.id;
END
$correction$;
