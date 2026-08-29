-- ════════════════════════════════════════════════════════════════════════
-- Overlays fund from the UNION BANK, and the guarantee guard reads the bank
-- that actually pays (Dan 2026-08-29, binding)
-- ════════════════════════════════════════════════════════════════════════
--
-- "ALL TOURNAMENTS THAT ARE SHORT OR HAVE OVERLAYS ARE FUNDED FROM THE UNION
--  BANK WALLET (OR FROM THE CLUB WALLET IF IT'S A STAND ALONE CLUB WITH NO
--  UNION AFFILIATION). THERE SHOULD NEVER BE ANYTHING PREVENTING NEW
--  TOURNAMENTS TO RUN, AS LONG AS THE BANK HOLDS ENOUGH CHIPS TO COVER. IF
--  THEY DON'T, A POP UP MUST APPEAR LETTING THE CLUB OR UNION KNOW THEY NEED
--  MORE CHIPS IN THE BANK TO COVER THE GUARANTEE."
--
-- ── WHAT WAS ACTUALLY LIVE, VERIFIED AGAINST THE DATABASE ──────────────
--
-- Migration 20260827f claims this rule was already applied via MCP. It was
-- not — or it was later overwritten. Read directly from production today:
--
--   * fn_apply_prize_guarantee debits clubs.chip_treasury UNCONDITIONALLY.
--     The bank_type / bank_entity_id / union_id columns 20260827f added to
--     tournament_guarantee_overlays exist and are never written. Half the
--     change shipped; the half that moves money did not.
--
--   * trg_tournaments_guarantee_affordable reads clubs.chip_treasury only.
--
-- The consequence was measured this morning: Midway Union's club treasury sat
-- at -7,161.10 (structurally negative for a union club — union clubs never
-- receive rake into chip_treasury; it returns at the weekly rakeback close),
-- so the guard refused ~570 scheduled tournament creations per hour — while
-- THE UNION BANK HELD 136,473.58 CHIPS, more than four times the total
-- guarantees promised on every live event. Tournaments were being blocked by
-- a wallet that was never supposed to be paying for them.
--
-- ── THE RULE, IMPLEMENTED ───────────────────────────────────────────────
--
-- One question decides everything: WHICH BANK PAYS THIS CLUB'S OVERLAYS?
--
--     clubs.union_id IS NOT NULL  ->  union_wallets.chip_balance  (the union bank)
--     clubs.union_id IS NULL      ->  clubs.chip_treasury         (standalone club)
--
-- The funder debits that bank. The guard reads that bank — same bank, same
-- arithmetic, or the guard blocks events the funder could pay (today's bug)
-- or waves through events the funder cannot (the opposite bug).
--
-- For a union bank, exposure is summed across EVERY club sharing it: three
-- clubs promising against one wallet must be counted together or the wallet
-- can be promised three times over.
--
-- The guard still exists — Dan's rule is "as long as the bank holds enough
-- chips to cover", so a bank that cannot cover still refuses, loudly. What
-- changes is that it reads the right bank, and that the refusal produces a
-- durable, owner-facing notification (fn_notify_guarantee_bank_short below)
-- instead of only an error string in a server log.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. The funder: union bank first ─────────────────────────────────────
create or replace function public.fn_apply_prize_guarantee(
  p_tournament_id uuid,
  p_source text default 'engine'
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_t record; v_overlay numeric; v_final numeric; v_claimed integer;
  v_union uuid; v_bank_type text; v_bank_entity uuid;
  v_balance_after numeric; v_bank_name text; v_updated integer;
  v_note text := 'Guarantees are funded daily; union rake returns at the '
              || 'weekly rakeback close, so a mid-week dip is usually timing. '
              || 'Escalate if it survives a close.';
begin
  select t.id, t.club_id, t.name, coalesce(t.prize_pool, 0) as pool,
         coalesce(t.guaranteed_prize, 0) as gtd, coalesce(t.prize_pool_finalized, false) as finalized
    into v_t from public.tournaments t where t.id = p_tournament_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_t.finalized then
    return jsonb_build_object('ok', true, 'already_finalized', true, 'prize_pool', v_t.pool);
  end if;

  v_final := greatest(v_t.pool, v_t.gtd);
  v_overlay := round(v_final - v_t.pool, 2);

  if v_overlay > 0 then
    -- WHICH BANK PAYS. The single decision the old function never made.
    select c.union_id into v_union from public.clubs c where c.id = v_t.club_id;
    if v_union is not null then
      v_bank_type := 'union';
      v_bank_entity := v_union;
    else
      v_bank_type := 'club';
      v_bank_entity := v_t.club_id;
    end if;

    -- Idempotency claim, unchanged: the PK on tournament_id means exactly one
    -- caller funds, and a re-entry adopts the earlier answer.
    insert into public.tournament_guarantee_overlays
      (tournament_id, club_id, amount, pool_before, pool_after, source,
       bank_type, bank_entity_id, union_id)
    values (p_tournament_id, v_t.club_id, v_overlay, v_t.pool, v_final,
            coalesce(p_source, 'engine'), v_bank_type, v_bank_entity, v_union)
    on conflict (tournament_id) do nothing;
    get diagnostics v_claimed = row_count;

    if v_claimed = 0 then
      update public.tournaments set prize_pool_finalized = true where id = p_tournament_id;
      return jsonb_build_object('ok', true, 'already_funded', true, 'prize_pool', v_t.pool);
    end if;

    if v_bank_type = 'union' then
      -- THE UNION BANK PAYS. FOR UPDATE serialises against every other union
      -- bank movement (sends, spin seeds, deposits).
      update public.union_wallets
         set chip_balance = coalesce(chip_balance, 0) - v_overlay,
             updated_at = now()
       where union_id = v_union
       returning chip_balance into v_balance_after;

      if v_balance_after is null then
        -- A union without a wallet row is a configuration wound; do not
        -- silently strand the overlay claimed above. Fall back to the club
        -- treasury and say so in the ledger.
        update public.tournament_guarantee_overlays
           set bank_type = 'club', bank_entity_id = v_t.club_id
         where tournament_id = p_tournament_id;
        update public.clubs
           set chip_treasury = coalesce(chip_treasury, 0) - v_overlay, updated_at = now()
         where id = v_t.club_id
         returning chip_treasury into v_balance_after;
        v_bank_type := 'club';
        v_bank_entity := v_t.club_id;
      else
        insert into public.union_wallet_transactions
          (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
        values
          (v_union, 'chip_balance', 'debit', v_overlay, v_balance_after,
           'guarantee_overlay', v_t.club_id,
           'Overlay for tournament ' || coalesce(v_t.name, p_tournament_id::text)
             || ' (' || p_tournament_id || '), pool ' || v_t.pool || ' -> ' || v_final);
      end if;
    else
      -- STANDALONE CLUB: its own treasury pays, exactly as before.
      update public.clubs
         set chip_treasury = coalesce(chip_treasury, 0) - v_overlay, updated_at = now()
       where id = v_t.club_id
       returning chip_treasury into v_balance_after;
    end if;

    update public.tournament_guarantee_overlays
       set treasury_after = v_balance_after
     where tournament_id = p_tournament_id;

    select case when v_bank_type = 'union'
                then (select u.name from public.unions u where u.id = v_union)
                else (select c.name from public.clubs c where c.id = v_t.club_id) end
      into v_bank_name;

    if v_balance_after is not null and v_balance_after < 0 then
      -- One open alert per BANK (not per club): three clubs sharing one
      -- overdrawn union bank is one problem, not three.
      update public.financial_alerts
         set severity = 'critical',
             message = 'Bank is negative from funding advertised guarantees: '
                       || coalesce(v_bank_name, v_bank_entity::text),
             context = jsonb_build_object(
                         'bank_type', v_bank_type,
                         'bank_entity_id', v_bank_entity,
                         'club_id', v_t.club_id,
                         'balance_after', v_balance_after,
                         'shortfall', round(-v_balance_after, 2),
                         'latest_tournament_id', p_tournament_id,
                         'latest_overlay', v_overlay,
                         'note', v_note),
             created_at = now()
       where source = 'fn_apply_prize_guarantee'
         and resolved is not true
         and context->>'bank_entity_id' = v_bank_entity::text;
      get diagnostics v_updated = row_count;

      if v_updated = 0 then
        insert into public.financial_alerts (severity, source, message, context)
        values ('critical', 'fn_apply_prize_guarantee',
                'Bank is negative from funding advertised guarantees: '
                  || coalesce(v_bank_name, v_bank_entity::text),
                jsonb_build_object(
                  'bank_type', v_bank_type,
                  'bank_entity_id', v_bank_entity,
                  'club_id', v_t.club_id,
                  'balance_after', v_balance_after,
                  'shortfall', round(-v_balance_after, 2),
                  'latest_tournament_id', p_tournament_id,
                  'latest_overlay', v_overlay,
                  'note', v_note));
      end if;
    end if;
  end if;

  update public.tournaments
     set prize_pool = v_final, prize_pool_finalized = true
   where id = p_tournament_id;

  return jsonb_build_object('ok', true, 'prize_pool', v_final,
    'overlay', coalesce(v_overlay, 0),
    'bank_type', v_bank_type, 'bank_entity_id', v_bank_entity,
    'treasury_after', v_balance_after);
end;
$$;

-- ONLY THE ENGINE FUNDS GUARANTEES. This is a SECURITY DEFINER writer that
-- moves chips on a caller-supplied tournament id; a browser role reaching it
-- could finalize pools at will. The engine connects as service_role.
revoke all on function public.fn_apply_prize_guarantee(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_apply_prize_guarantee(uuid, text) to service_role;

comment on function public.fn_apply_prize_guarantee(uuid, text) is
  'Fund a tournament overlay (guarantee minus pool) from the bank that owns the club: the UNION bank (union_wallets.chip_balance) for a union-affiliated club, the club''s own chip_treasury for a standalone club. Idempotent via the PK claim on tournament_guarantee_overlays; every union debit writes union_wallet_transactions; a negative bank raises one deduped critical alert per bank. The 2026-08-27f migration claimed this rule was already live - it was not, and Midway Union events were blocked by a club treasury that was never supposed to pay while the union bank held 136k.';

-- ── 2. The guard: read the bank that pays ───────────────────────────────
create or replace function public.trg_tournaments_guarantee_affordable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_union uuid; v_enforce boolean; v_club_name text;
  v_bank numeric; v_floor numeric; v_bank_label text;
  v_exposure numeric; v_this numeric; v_headroom numeric;
begin
  if coalesce(new.guaranteed_prize, 0) <= 0 or new.club_id is null then
    return new;
  end if;

  select c.union_id, coalesce(c.guarantee_enforcement_enabled, true), c.name,
         coalesce(c.guarantee_treasury_floor, 0)
    into v_union, v_enforce, v_club_name, v_floor
    from public.clubs c where c.id = new.club_id;
  if not found then return new; end if;

  if v_union is not null then
    -- UNION CLUB: the union bank pays, so the union bank is what must cover.
    -- Exposure sums over EVERY club sharing the bank - one wallet cannot be
    -- promised once per club.
    select coalesce(uw.chip_balance, 0) into v_bank
      from public.union_wallets uw where uw.union_id = v_union;
    v_bank := coalesce(v_bank, 0);
    v_bank_label := 'union bank';
    -- The per-club treasury floor is a club-treasury concept; the union bank
    -- has no floor column, and inventing one silently would re-create today's
    -- bug with a different constant.
    v_floor := 0;

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
      join public.clubs c2 on c2.id = t.club_id
     where c2.union_id = v_union
       and t.id <> new.id
       and coalesce(t.guaranteed_prize, 0) > 0
       and coalesce(t.prize_pool_finalized, false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');
  else
    -- STANDALONE CLUB: unchanged - its own treasury pays and must cover.
    select coalesce(c.chip_treasury, 0) into v_bank
      from public.clubs c where c.id = new.club_id;
    v_bank_label := 'club bank';

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
     where t.club_id = new.club_id
       and t.id <> new.id
       and coalesce(t.guaranteed_prize, 0) > 0
       and coalesce(t.prize_pool_finalized, false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');
  end if;

  v_this     := greatest(coalesce(new.guaranteed_prize,0) - coalesce(new.prize_pool,0), 0);
  v_headroom := v_bank - v_floor - v_exposure - v_this;

  if v_headroom < 0 then
    if v_enforce then
      raise exception
        'Club % cannot guarantee % chips: % holds %, floor %, already promised % on live events — short by %. Add chips to the bank to cover the guarantee.',
        coalesce(v_club_name, new.club_id::text), new.guaranteed_prize,
        v_bank_label, round(v_bank,2), round(v_floor,2), round(v_exposure,2), round(-v_headroom,2)
        using errcode = '55000';
    else
      insert into public.financial_alerts (severity, source, message, context)
      values ('critical', 'trg_tournaments_guarantee_affordable',
              'Guaranteed tournament announced that the ' || v_bank_label || ' cannot cover: '
                || coalesce(v_club_name, new.club_id::text),
              jsonb_build_object('club_id', new.club_id, 'union_id', v_union,
                                 'tournament_id', new.id,
                                 'guaranteed_prize', new.guaranteed_prize,
                                 'bank', v_bank, 'bank_label', v_bank_label,
                                 'floor', v_floor,
                                 'live_exposure', v_exposure, 'short_by', -v_headroom,
                                 'note', 'enforcement disabled for this club; no money was blocked'));
    end if;
  end if;

  return new;
end;
$$;

comment on function public.trg_tournaments_guarantee_affordable() is
  'Refuse a guaranteed tournament only when the bank that actually FUNDS overlays cannot cover it: the union bank for a union-affiliated club (exposure summed across every club sharing it), the club treasury for a standalone club. Before 2026-08-29 it read the club treasury unconditionally, and Midway Union - structurally negative because union rake returns weekly - was refused ~570 spawns/hour while its union bank held 136k against 31k of promises.';

-- ── 3. The pop-up: a durable owner-facing notification ──────────────────
--
-- A BEFORE INSERT trigger that raises rolls back everything in its own
-- transaction, including any notification it might write. So the refusal
-- cannot notify from inside the guard; callers invoke this AFTER catching the
-- 55000. The UI already shows the raise verbatim as a toast; this writes the
-- durable bell-icon notification to the club owner (and the union owner when
-- the union bank is what is short), deduped on unread.
create or replace function public.fn_notify_guarantee_bank_short(
  p_club_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t join public.clubs c2 on c2.id = t.club_id
     where c2.union_id = v_union
       and coalesce(t.guaranteed_prize,0) > 0
       and coalesce(t.prize_pool_finalized,false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');

    -- Both owners hear about a short union bank: the union owner funds it,
    -- the club owner is the one whose events are not spawning.
    select array_agg(distinct uid) into v_recipients from (
      select u.owner_id as uid from public.unions u where u.id = v_union and u.owner_id is not null
      union
      select c.owner_id from public.clubs c where c.id = p_club_id and c.owner_id is not null
    ) o;
  else
    select coalesce(c.chip_treasury, 0) into v_bank
      from public.clubs c where c.id = p_club_id;
    v_bank_label := 'club bank';

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
     where t.club_id = p_club_id
       and coalesce(t.guaranteed_prize,0) > 0
       and coalesce(t.prize_pool_finalized,false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');

    select array_agg(c.owner_id) into v_recipients
      from public.clubs c where c.id = p_club_id and c.owner_id is not null;
  end if;

  -- Popup style per CLAUDE.md rule 7: First Letter Of Every Word Capitalized,
  -- no em dashes.
  v_title := 'More Chips Needed To Cover Guarantees';
  v_message := 'The ' || v_bank_label || ' for '
            || coalesce(case when v_union is not null then v_union_name end, v_club_name, 'your club')
            || ' holds ' || round(v_bank, 2)
            || ' chips against ' || round(v_exposure, 2)
            || ' promised in live guarantees. New guaranteed tournaments cannot start until more chips are added to the bank.';

  foreach v_uid in array coalesce(v_recipients, '{}'::uuid[]) loop
    -- Dedupe on unread: one standing notification per recipient per bank.
    -- Once they read it, the next refusal may raise it again.
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
$$;

comment on function public.fn_notify_guarantee_bank_short(uuid) is
  'Write the durable owner-facing "More Chips Needed To Cover Guarantees" notification for a club whose funding bank cannot cover its promises. Called by the app AFTER catching the guard''s 55000 refusal, because a raising trigger rolls back anything it writes itself. Notifies the club owner, and the union owner too when the short bank is the union''s. Deduped on unread per recipient per bank.';

revoke all on function public.fn_notify_guarantee_bank_short(uuid) from public, anon, authenticated;
grant execute on function public.fn_notify_guarantee_bank_short(uuid) to service_role;

-- ── assertions ──────────────────────────────────────────────────────────
do $$
declare
  v_def text;
begin
  -- The funder must branch on the union, and the guard must read the union
  -- bank. String assertions on the LIVE definitions, because this exact
  -- migration is replacing a function whose repo copy and live copy disagreed.
  select prosrc into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_apply_prize_guarantee';
  if v_def not like '%union_wallets%' or v_def not like '%guarantee_overlay%' then
    raise exception 'fn_apply_prize_guarantee does not fund from the union bank after this migration';
  end if;

  select prosrc into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='trg_tournaments_guarantee_affordable';
  if v_def not like '%union_wallets%' then
    raise exception 'the guarantee guard still reads only the club treasury';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='fn_notify_guarantee_bank_short'
  ) then
    raise exception 'fn_notify_guarantee_bank_short was not created';
  end if;
end;
$$;
