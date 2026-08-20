-- Mirror of the live catalog (applied 2026-08-20 via mcp apply_migration).
-- ═══════════════════════════════════════════════════════════════════════════════
-- fn_relink_rake_record_to_hand — attach a late hand_history row to its rake row
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- hand_history writes go to zero platform-wide for 30-120 seconds at a time
-- under load while the much smaller atomic_distribute_rake RPC still gets
-- through, so a hand can have its rake banked with p_hand_id = NULL and no
-- history row at all. Measured over 3 days: 320 such rake rows, 315 of them with
-- no hand_history row in existence.
--
-- The engine now holds the failed payload and re-inserts it when the window
-- passes (server/src/services/supabase/handHistory.ts). Once that late insert
-- lands, the rake row still has to be pointed at it or the money stays
-- unattributable — which is the financial_alerts signal that started this.
--
-- atomic_distribute_rake stamps metadata->>'hand_number', so the link is exact.
-- This is an RPC rather than a PostgREST update for three reasons: the
-- uniqueness guard on hand_id has to be checked and the update skipped rather
-- than failed, it must touch exactly ONE row, and it can then be tested.
--
-- Verified live inside a rolled-back transaction against a real unlinked row
-- (table 8142974f, hand_number 1383473): first call returned 1 and attached the
-- row, second call with the same hand id returned 0 (uniqueness guard), a call
-- for a hand number with no unlinked row returned 0 without erroring.
create or replace function public.fn_relink_rake_record_to_hand(
  p_table_id uuid,
  p_hand_number bigint,
  p_hand_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
begin
  if p_table_id is null or p_hand_number is null or p_hand_id is null then
    return 0;
  end if;

  -- uq_rake_records_hand_id is UNIQUE on hand_id WHERE hand_id IS NOT NULL, so
  -- refuse rather than error if this hand id is already attached somewhere.
  if exists (select 1 from rake_records where hand_id = p_hand_id) then
    return 0;
  end if;

  select id into v_target
  from rake_records
  where table_id = p_table_id
    and hand_id is null
    and metadata->>'hand_number' = p_hand_number::text
  order by created_at
  limit 1;

  if v_target is null then
    return 0;
  end if;

  update rake_records
     set hand_id = p_hand_id
   where id = v_target
     and hand_id is null;

  return 1;
end;
$$;

comment on function public.fn_relink_rake_record_to_hand(uuid, bigint, uuid) is
  'Attach a hand_history row written late (after a transient write outage) to the rake_records row banked for the same hand. Matches on (table_id, metadata->>hand_number). Returns 1 if a row was relinked, 0 otherwise. Added 2026-08-20.';

revoke all on function public.fn_relink_rake_record_to_hand(uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.fn_relink_rake_record_to_hand(uuid, bigint, uuid) to service_role;
