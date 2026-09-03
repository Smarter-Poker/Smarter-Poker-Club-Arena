-- ═══════════════════════════════════════════════════════════════════════════
--  A CYCLE IN THE AGENT HIERARCHY MUST BE IMPOSSIBLE TO CREATE (2026-08-25)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- club_members.agent_id holds the UPLINE'S USER ID and is the single edge every
-- downline query in this platform walks: fn_club_cashier_members,
-- fn_club_is_in_downline, ca_club_my_downline, the cashier's refusal check
-- (fn_club_cashier_can_transact) and therefore fn_agent_wallet_send itself.
--
-- Nothing stopped that edge forming a loop. A uplines B while B uplines A makes
-- the hierarchy unwalkable: "who is above this player" has no answer, and a
-- recursion over it does not terminate on its own.
--
-- WHAT THIS IS NOT: a repair. Every recursive query in the codebase is already
-- cycle-SAFE - each carries a visited-path array and a depth cap, which is why
-- a loop degrades into a truncated answer rather than a hung request - and
-- production holds ZERO cycles right now (verified before this was written).
-- This is the guard that keeps it that way, placed where no caller can route
-- around it: the write itself.
--
-- THE TWO RULES
--   1. agent_id = user_id is refused. A member cannot be their own upline;
--      every walker in the codebase special-cases that row already
--      (fn_club_cashier_members: `cm.agent_id <> cm.user_id`), which is the
--      shape of a defect nobody wanted to fix at the source.
--   2. The proposed parent may not sit BENEATH the row being edited. The
--      trigger walks up from NEW.agent_id and raises if it arrives back at
--      NEW.user_id.
--
-- CHEAP BY CONSTRUCTION
--   - `UPDATE OF agent_id` plus a WHEN clause, so it fires only when that one
--     column actually changes. A balance update, a role change, a status
--     change, a joined_at touch - none of them pay for this.
--   - The walk is a plain loop over an indexed lookup
--     (club_id, user_id), bounded at 64 hops, and stops the moment it reaches
--     a member with no upline. A real hierarchy is a handful of levels deep;
--     the cap exists so a pre-existing loop (there are none, but a restore or a
--     direct write could make one) cannot spin the trigger forever.
--   - It is scoped to ONE club. agent_id is meaningless across clubs and a
--     cross-club walk would both be wrong and cost more.
--
-- WHY TWO TRIGGERS AND NOT ONE
--   Postgres refuses `when (... old.agent_id)` on a trigger that also covers
--   INSERT - 42P17, "INSERT trigger's WHEN condition cannot reference OLD
--   values" - because there is no OLD row to read. Writing one trigger for both
--   events therefore means dropping the WHEN clause and paying for the walk on
--   every club_members UPDATE, which is the opposite of cheap. Two triggers,
--   one condition each, one shared function.
--
-- ROLLBACK:
--   drop trigger if exists trg_club_members_no_agent_cycle_ins on public.club_members;
--   drop trigger if exists trg_club_members_no_agent_cycle_upd on public.club_members;
--   drop function if exists public.fn_club_members_no_agent_cycle();

create or replace function public.fn_club_members_no_agent_cycle()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_cursor uuid;
  v_hops   int := 0;
begin
  -- Clearing the upline can never create a cycle.
  if new.agent_id is null then
    return new;
  end if;

  -- 1. Self parenting.
  if new.agent_id = new.user_id then
    raise exception
      'club_members.agent_id: a member cannot be their own upline (club %, member %)',
      new.club_id, new.user_id
      using errcode = '23514';
  end if;

  -- 2. Walk UP from the proposed parent. If the walk arrives back at the row
  --    being written, the edge would close a loop.
  v_cursor := new.agent_id;
  while v_cursor is not null and v_hops < 64 loop
    if v_cursor = new.user_id then
      raise exception
        'club_members.agent_id: % cannot sit under % - that would close a cycle in club %',
        new.user_id, new.agent_id, new.club_id
        using errcode = '23514';
    end if;
    select cm.agent_id
      into v_cursor
      from public.club_members cm
     where cm.club_id = new.club_id
       and cm.user_id = v_cursor;
    -- No row: the chain leaves the club's membership. Nothing above it to walk.
    if not found then
      exit;
    end if;
    v_hops := v_hops + 1;
  end loop;

  -- The cap is a safety net for a graph that is ALREADY malformed, not a
  -- verdict on this write. Refuse rather than let an unverifiable edge land.
  if v_hops >= 64 then
    raise exception
      'club_members.agent_id: the upline chain above % is deeper than 64 levels or already loops',
      new.agent_id
      using errcode = '23514';
  end if;

  return new;
end
$function$;

comment on function public.fn_club_members_no_agent_cycle() is
  'Refuses a club_members.agent_id write that would make a member their own upline or close a cycle. Walks up from the proposed parent, club scoped, capped at 64 hops.';

drop trigger if exists trg_club_members_no_agent_cycle on public.club_members;
drop trigger if exists trg_club_members_no_agent_cycle_ins on public.club_members;
drop trigger if exists trg_club_members_no_agent_cycle_upd on public.club_members;

create trigger trg_club_members_no_agent_cycle_ins
  before insert on public.club_members
  for each row
  when (new.agent_id is not null)
  execute function public.fn_club_members_no_agent_cycle();

create trigger trg_club_members_no_agent_cycle_upd
  before update of agent_id on public.club_members
  for each row
  -- Only when the edge ACTUALLY changes. A balance update, a role change, a
  -- status change - none of them pay for the walk.
  when (new.agent_id is not null and new.agent_id is distinct from old.agent_id)
  execute function public.fn_club_members_no_agent_cycle();

-- ── POST CHECKS ────────────────────────────────────────────────────────────
-- A migration that silently created nothing is the failure mode this repo has
-- paid for before, so it says so itself.
do $$
declare c int;
begin
  select count(*) into c
    from pg_trigger t
    join pg_class rel on rel.oid = t.tgrelid
   where rel.relname = 'club_members'
     and t.tgname in ('trg_club_members_no_agent_cycle_ins',
                      'trg_club_members_no_agent_cycle_upd')
     and not t.tgisinternal;
  if c <> 2 then
    raise exception 'post-check: expected 2 cycle guard triggers on club_members, found %', c;
  end if;
end $$;

-- And that each is armed BEFORE the write, on a ROW, for the right event. A
-- guard created AFTER, or one that lost its UPDATE OF clause, looks identical
-- from the outside until a cycle lands.
do $$
declare
  v_ins int;
  v_upd int;
begin
  select t.tgtype into v_ins from pg_trigger t join pg_class rel on rel.oid = t.tgrelid
   where rel.relname = 'club_members' and t.tgname = 'trg_club_members_no_agent_cycle_ins';
  select t.tgtype into v_upd from pg_trigger t join pg_class rel on rel.oid = t.tgrelid
   where rel.relname = 'club_members' and t.tgname = 'trg_club_members_no_agent_cycle_upd';
  -- 1 = ROW, 2 = BEFORE, 4 = INSERT, 16 = UPDATE
  if (v_ins & 7) <> 7 then
    raise exception 'post-check: insert guard is not BEFORE INSERT FOR EACH ROW (tgtype %)', v_ins;
  end if;
  if (v_upd & 19) <> 19 then
    raise exception 'post-check: update guard is not BEFORE UPDATE FOR EACH ROW (tgtype %)', v_upd;
  end if;
end $$;
