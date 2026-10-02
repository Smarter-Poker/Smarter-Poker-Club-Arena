-- 20261002034240_a_guarantee_bank_pop_up_counts_the_satellite_seats_the_publi.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 2026-10-02 03:00-03:33Z the scheduler's insert of Midway Union's Sunday
-- Funday High Roller PKO (schedule 76c70c53, 3,500 GTD) was refused 30 times by
-- trg_tournaments_publish_readiness: "guarantee is short by 373.47 .. 1034.97".
-- Every promise behind the refusal was genuine (34 live REGISTERING/RUNNING
-- Midway events, none terminal, none already funded by an overlay row,
-- including the guaranteed seats of the Sunday Deep Stack satellites). The
-- insert went through at 03:33:57Z once registrations lifted the pools.
--
-- The defect: the refusal was silent. The engine fix (same PR series) makes
-- every refusal site recognise the publish guard's message, so it now calls
-- fn_notify_guarantee_bank_short. But that function summed only
-- guaranteed_prize, so for a refusal caused by guaranteed satellite seats it
-- would tell the owner the bank holds MORE than is promised (short_by 0).
-- This makes its exposure the publish guard's exposure: guaranteed prizes and
-- guaranteed satellite seats, net of collected pools, scoped exactly as
-- fn_tournament_management_readiness_for_row scopes them (union events by
-- tournaments.union_id and not private; club events by club_id when private or
-- union-less). Nothing else changes: signature, SECURITY DEFINER, VOLATILE,
-- search_path, recipients, dedupe, texts, return shape and ACL are the live ones.

BEGIN;

DO $pre$
DECLARE r record;
BEGIN
  SELECT md5(p.prosrc) AS h, pg_get_userbyid(p.proowner) AS own, p.proacl::text AS acl,
         p.proconfig::text AS cfg, p.prosecdef AS sd, p.provolatile AS vol
    INTO r
    FROM pg_proc p
   WHERE p.oid = 'public.fn_notify_guarantee_bank_short(uuid)'::regprocedure;
  IF r.h IS DISTINCT FROM '8bf3f5910f30ab5ff9b0924a2c42c431'
     OR r.own IS DISTINCT FROM 'postgres'
     OR r.acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR r.cfg IS DISTINCT FROM '{"search_path=public, pg_temp"}'
     OR r.sd IS DISTINCT FROM true
     OR r.vol IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'guarantee_bank_notify_preimage_mismatch: % % % % % %', r.h, r.own, r.acl, r.cfg, r.sd, r.vol;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_notify_guarantee_bank_short(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_union uuid; v_club_name text; v_union_name text;
  v_bank numeric; v_bank_label text; v_exposure numeric;
  v_recipients uuid[]; v_uid uuid; v_inserted integer := 0;
  v_title text; v_message text;
begin
  select c.union_id, c.name into v_union, v_club_name
    from public.clubs c where c.id = p_club_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'club_not_found');
  end if;

  if v_union is not null then
    select coalesce(uw.chip_balance, 0), u.name
      into v_bank, v_union_name
      from public.unions u
      left join public.union_wallets uw on uw.union_id = u.id
     where u.id = v_union;
    v_bank_label := 'union bank';

    -- The promises the publish guard (fn_tournament_management_readiness_for_row)
    -- counts against this bank, read the same way: guaranteed prizes AND
    -- guaranteed satellite seats, net of the pool already collected.
    select coalesce(sum(greatest(
             greatest(
               coalesce(t.guaranteed_prize, 0),
               case
                 when coalesce(t.satellite_seats, 0) > 0
                      and (
                        lower(coalesce(t.variant, '')) = 'satellite'
                        or upper(coalesce(t.tournament_type, '')) = 'SATELLITE'
                        or coalesce(t.satellite_target_id, t.satellite_target) is not null
                      )
                 then coalesce(
                   (coalesce(target.buy_in_amount, 0) + coalesce(target.buy_in_fee, 0))
                   * t.satellite_seats,
                   0
                 )
                 else 0
               end
             ) - coalesce(t.prize_pool, 0),
             0
           )), 0)
      into v_exposure
      from public.tournaments t
      left join public.tournaments target
        on target.id = coalesce(t.satellite_target_id, t.satellite_target)
     where t.union_id = v_union
       and not coalesce(t.is_private, false)
       and coalesce(t.prize_pool_finalized,false) = false
       and upper(t.status::text) in ('ANNOUNCED','REGISTERING','RUNNING');

    select array_agg(distinct uid) into v_recipients from (
      select u.owner_id as uid from public.unions u where u.id = v_union and u.owner_id is not null
      union
      select c.owner_id from public.clubs c where c.id = p_club_id and c.owner_id is not null
    ) o;
  else
    select coalesce(c.chip_treasury, 0) into v_bank
      from public.clubs c where c.id = p_club_id;
    v_bank_label := 'club bank';

    select coalesce(sum(greatest(
             greatest(
               coalesce(t.guaranteed_prize, 0),
               case
                 when coalesce(t.satellite_seats, 0) > 0
                      and (
                        lower(coalesce(t.variant, '')) = 'satellite'
                        or upper(coalesce(t.tournament_type, '')) = 'SATELLITE'
                        or coalesce(t.satellite_target_id, t.satellite_target) is not null
                      )
                 then coalesce(
                   (coalesce(target.buy_in_amount, 0) + coalesce(target.buy_in_fee, 0))
                   * t.satellite_seats,
                   0
                 )
                 else 0
               end
             ) - coalesce(t.prize_pool, 0),
             0
           )), 0)
      into v_exposure
      from public.tournaments t
      left join public.tournaments target
        on target.id = coalesce(t.satellite_target_id, t.satellite_target)
     where t.club_id = p_club_id
       and (coalesce(t.is_private, false) or t.union_id is null)
       and coalesce(t.prize_pool_finalized,false) = false
       and upper(t.status::text) in ('ANNOUNCED','REGISTERING','RUNNING');

    select array_agg(c.owner_id) into v_recipients
      from public.clubs c where c.id = p_club_id and c.owner_id is not null;
  end if;

  v_title := 'More Chips Needed To Cover Guarantees';
  v_message := 'The ' || v_bank_label || ' for '
            || coalesce(case when v_union is not null then v_union_name end, v_club_name, 'your club')
            || ' holds ' || round(v_bank, 2)
            || ' chips against ' || round(v_exposure, 2)
            || ' promised in live guarantees. New guaranteed tournaments cannot start until more chips are added to the bank.';

  foreach v_uid in array coalesce(v_recipients, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.notifications n
       where n.user_id = v_uid
         and n.type = 'guarantee_bank_short'
         and coalesce(n.is_read, false) = false
         and n.data->>'bank_entity_id' = coalesce(v_union, p_club_id)::text
    ) then
      insert into public.notifications (user_id, type, title, message, data, is_read)
      values (v_uid, 'guarantee_bank_short', v_title, v_message,
              jsonb_build_object(
                'bank_type', case when v_union is not null then 'union' else 'club' end,
                'bank_entity_id', coalesce(v_union, p_club_id),
                'club_id', p_club_id, 'union_id', v_union,
                'bank_balance', v_bank, 'live_exposure', v_exposure,
                'short_by', round(greatest(v_exposure - v_bank, 0), 2)),
              false);
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'notified', v_inserted,
    'bank', v_bank, 'exposure', v_exposure,
    'recipients', coalesce(array_length(v_recipients, 1), 0));
end;
$function$;

REVOKE ALL ON FUNCTION public.fn_notify_guarantee_bank_short(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_notify_guarantee_bank_short(uuid) TO service_role;

DO $post$
DECLARE r record;
BEGIN
  SELECT p.prosrc AS src, pg_get_userbyid(p.proowner) AS own, p.proacl::text AS acl,
         p.proconfig::text AS cfg, p.prosecdef AS sd, p.provolatile AS vol
    INTO r
    FROM pg_proc p
   WHERE p.oid = 'public.fn_notify_guarantee_bank_short(uuid)'::regprocedure;
  IF position('target.buy_in_amount' in r.src) = 0
     OR position('t.union_id = v_union' in r.src) = 0
     OR position('c2.union_id' in r.src) > 0
     OR r.own IS DISTINCT FROM 'postgres'
     OR r.acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR r.cfg IS DISTINCT FROM '{"search_path=public, pg_temp"}'
     OR r.sd IS DISTINCT FROM true
     OR r.vol IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'guarantee_bank_notify_postimage_mismatch: % % % % %', r.own, r.acl, r.cfg, r.sd, r.vol;
  END IF;
END
$post$;

COMMIT;
