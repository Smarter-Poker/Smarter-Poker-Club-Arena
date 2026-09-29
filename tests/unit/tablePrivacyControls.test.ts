/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ANONYMOUS TABLE, BAN CHAT, RESTRICT OBSERVERS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three switches from the audit's "does nothing" column, wired 2026-08-25.
 * Each had a working control, a real column, and no reader anywhere.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  sliceMethod,
  sliceEnclosingBlock,
  sliceSqlStatement,
  sliceDollarQuoted,
} from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const ENGINE = read('server/src/engine/ServerTableEngine.ts');
const WS = read('server/src/transport/EngineWebSocketServer.ts');
const CHAT = read('src/hooks/useTableChat.ts');
const SELECT = read('server/src/services/supabase/tables.ts');

describe('Anonymous Table', () => {
  it('is reachable by the engine at all', () => {
    expect(SELECT).toContain('is_anonymous');
  });

  it('scrubs the two fields that are a name on screen, and only those', () => {
    const fn = sliceMethod(ENGINE, 'protected seatIdentity(');
    expect(fn).toContain('username');
    expect(fn).toContain('avatar_url');
    // user_id must survive: the client keys the hero seat, current_player,
    // winner_ids and disconnect_states off it. Scrubbing it breaks the table
    // rather than anonymising it.
    expect(fn).not.toMatch(/user_id:\s*''/);
  });

  it('is applied by EVERY serializer, not three of four', () => {
    // getTableState, broadcastCurrentState, the second broadcast block and
    // publishIdleState are byte-identical seat maps; this file already carries
    // a comment about a reveal gate that was missed in one of them.
    const uses = ENGINE.match(/\.\.\.this\.seatIdentity\(p\)/g) ?? [];
    expect(uses.length).toBe(4);
    /* The ONE remaining raw read is inside seatIdentity itself, which is the
       point of the helper. Anywhere else means a serializer was missed. */
    const outsideHelper =
      ENGINE.slice(0, ENGINE.indexOf('protected seatIdentity(')) +
      ENGINE.slice(ENGINE.indexOf('private bettingStructureFields('));
    expect(outsideHelper).not.toContain('username: p.username');
    expect(outsideHelper).not.toContain('avatar_url: p.avatar_url');
  });

  it('is uniform, not per-viewer', () => {
    // TableStateHub publishes ONE payload to every subscriber. A hero
    // exception would mean a payload per seat.
    const fn = sliceMethod(ENGINE, 'protected seatIdentity(');
    expect(fn).not.toContain('requestingUserId');
  });
});

describe('Restrict Observers', () => {
  it('is reachable by the engine at all', () => {
    expect(SELECT).toContain('restrict_observers');
  });

  it('gates both the upgrade and mux paths through the complete authority', () => {
    expect(WS.match(/await this\.authorizeConnection\(tableId,/g)).toHaveLength(2);
    expect(WS).toContain('OBSERVERS_RESTRICTED');
  });

  it('reads the current seat and observer setting from one uncached SQL snapshot', () => {
    const sql = read(
      'supabase/migrations/20260911195214_engine_table_connection_one_snapshot_verdict.sql'
    );
    expect(sql).toContain('s.left_at IS NULL');
    expect(sql).toContain("WHEN f.seated THEN 'seated'");
    expect(sql).toContain("WHEN f.restrict_observers IS TRUE THEN 'observers_restricted'");
    expect(WS).not.toContain('observerRestrictionCache');
  });

  it('cannot grant access when the complete authority read fails', () => {
    const gate = read('server/src/services/TableConnectionAccess.ts');
    expect(gate).toContain('allowed: false');
    expect(gate).toContain("reason: 'check_failed'");
    expect(gate).toMatch(/catch\s*\{\s*return refused;/);
  });
});

describe('Ban Chat', () => {
  it('stops the send in the client so the box does not swallow a message', () => {
    expect(CHAT).toContain('isChatBannedRef.current) return;');
    expect(CHAT).toContain('isChatBanned');
  });

  /* 2026-08-26: this used to assert `select('ban_chat')`. That read is gone
     ON PURPOSE, not by accident. `tables.ban_chat` is one of THREE ways a
     player can be silenced and the only one the browser can see for itself:
     a tournament's ban_chat never reached the table row, and
     `table_chat_mutes` is admin-read-only, so a muted player selecting their
     own mute gets zero rows and concludes they are not muted. The composer
     now asks the same SECURITY DEFINER function the RLS policy calls, so the
     two cannot disagree. */
  it('asks the same function the policy asks, not one of the three flags', () => {
    expect(CHAT).toContain("supabase.rpc('fn_table_chat_is_silenced'");
    expect(CHAT).not.toContain("select('ban_chat')");
  });

  it('leaves chat ENABLED when the read fails', () => {
    // The RLS policy is the enforcement; a failed read must not silence a
    // table nobody muted.
    const eff = sliceEnclosingBlock(CHAT, "supabase.rpc('fn_table_chat_is_silenced'");
    expect(eff).toContain('the policy is the enforcement');
  });

  /* A mute arrives mid-session and there is no realtime feed for one, so the
     mount read cannot catch it. Without this the player watches every message
     fail with no reason given. */
  it('adopts the policy verdict when a send is refused with 42501', () => {
    const send = CHAT.slice(CHAT.indexOf('const handleSendChatMessage'));
    expect(send).toContain("=== '42501'");
    expect(send).toContain('setIsChatBanned(true)');
  });

  /* The hook has computed isChatBanned since 2026-08-25 and TablePage never
     destructured it, so the courtesy never reached a single player: the
     composer stayed enabled, TableChat cleared the input, and the hook dropped
     the message in silence. A value nothing consumes is not a hint. */
  it('is actually consumed by the page, not just returned by the hook', () => {
    const PAGE = read('src/pages/TablePage.tsx');
    const destructure = PAGE.slice(
      PAGE.indexOf('} = useTableChat(') - 1500,
      PAGE.indexOf('} = useTableChat(')
    );
    expect(destructure).toContain('isChatBanned');
    expect(PAGE).toContain('isDisabled={isChatBanned || !canChatAsObserver}');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CLUB CHAT BANS
   A blacklisted member cannot read their own `blacklists` row, so the refusal
   itself is the only channel that can tell them.
   ═══════════════════════════════════════════════════════════════════════════ */
describe('Club Chat Ban', () => {
  const CLUB = read('src/components/club/ClubChat.tsx');

  it('recognises the RLS refusal instead of calling it a network failure', () => {
    expect(CLUB).toContain("=== '42501'");
    expect(CLUB).toContain('setIsBannedFromChat(true)');
  });

  it('closes the composer once refused, rather than looping on failure', () => {
    expect(CLUB).toContain('sending || isBannedFromChat) return;');
    expect(CLUB).toContain('You Cannot Post In This Club Chat');
  });

  it('leaves an ordinary send failure saying exactly what it said before', () => {
    // Only 42501 changes the wording. A dropped connection is still just a
    // dropped connection.
    expect(CLUB).toContain('Failed To Send');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   MULTI-DAY MTT
   The legacy flag columns are refused rather than promised: nothing writes
   flight_end_chips_snapshot and no flight merge exists. Day 2 itself (single
   flight) is built on new stage tables and gated by the capability registry.
   ═══════════════════════════════════════════════════════════════════════════ */
describe('Multi-Day MTT is refused, not faked', () => {
  const BUILD = read('src/lib/tournamentFromTableConfig.ts');
  const CONFIG = read('src/pages/TableConfigPage.tsx');

  it('never composes the flag, whatever the config asks for', () => {
    const tail = BUILD.slice(BUILD.indexOf('isMultiDay:'));
    expect(tail).toContain('isMultiDay: false');
    expect(tail).toContain('totalDays: undefined');
    // The old mapping read the config. If either of these comes back, the
    // database trigger will refuse the write and the create will simply fail.
    expect(sliceEnclosingBlock(BUILD, 'isMultiDay:')).not.toContain('config.multiDayMtt');
  });

  /* 2026-09-24: replaced deliberately, not broken. Day 2 is built (single
     flight), so the form offers the switch again, but ONLY while the
     capability registry says tournament.multi_day.single_flight is available,
     and what it drives is a Day Schedule sealed into the stage tables, never
     the flag above (the first test here still pins that refusal). Everywhere
     else the honest NOT AVAILABLE YET stays. Full pins:
     theCreateTableFormOffersOnlyLiveSwitches.test.ts section 5e. */
  it('offers the control only behind the capability, and says so otherwise', () => {
    const gate = CONFIG.indexOf("{multiDayGate === 'available' ? (");
    expect(gate).toBeGreaterThan(0);
    const control = CONFIG.indexOf("updateConfig('multiDayMtt'");
    expect(control).toBeGreaterThan(gate);
    expect(CONFIG.indexOf("updateConfig('multiDayMtt'", control + 1)).toBe(-1);
    expect(CONFIG.indexOf('NOT AVAILABLE YET', gate)).toBeGreaterThan(control);
    expect(CONFIG).toContain('usePlatformCapability(MULTI_DAY_CAPABILITY)');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE ENFORCEMENT ITSELF
   These are the lines that make the two features above real rather than
   advisory. There is no Postgres in this suite, so what is pinned here is the
   shape of the migration; the predicates themselves were probed both ways
   against production inside transactions that were rolled back.
   ═══════════════════════════════════════════════════════════════════════════ */
describe('Chat ban enforcement lives in the database', () => {
  const MIG = read(
    'supabase/migrations/20260826_chat_bans_are_enforced_where_rls_can_see_them.sql'
  );

  /* THE WHOLE POINT. A subquery inside an RLS policy runs as the CALLER, so
     the caller's own RLS applies to it. `table_chat_mutes` is admin-read-only
     and `blacklists_select` is owner/admin/agent only, which means an inline
     NOT EXISTS over either one returns TRUE for exactly the people it is meant
     to stop. If SECURITY DEFINER is ever dropped from these helpers the guards
     silently become no-ops that still read as correct. */
  it('reads the ban through SECURITY DEFINER, or it is blind to the banned', () => {
    for (const fn of ['fn_table_chat_is_silenced', 'fn_club_chat_is_silenced']) {
      const body = sliceSqlStatement(MIG, `CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(body).toContain('SECURITY DEFINER');
      // A SECURITY DEFINER function with a caller-controlled search_path is
      // how you hand out postgres.
      expect(body).toContain('SET search_path = public, pg_temp');
    }
  });

  it('covers all three ways a player is silenced at a table', () => {
    const fn = MIG.slice(
      MIG.indexOf('CREATE OR REPLACE FUNCTION public.fn_table_chat_is_silenced'),
      MIG.indexOf('COMMENT ON FUNCTION public.fn_table_chat_is_silenced')
    );
    expect(fn).toContain('t.ban_chat IS TRUE'); // the table's own switch
    expect(fn).toContain('tr.ban_chat IS TRUE'); // the parent tournament's
    expect(fn).toContain('table_chat_mutes'); // this player's own mute
    expect(fn).toContain('m.expires_at > now()'); // an expired mute is not a mute
  });

  it('treats a club ban with no expiry as permanent, not as expired', () => {
    const fn = sliceSqlStatement(MIG, 'CREATE OR REPLACE FUNCTION public.fn_club_chat_is_silenced');
    expect(fn).toContain('b.expires_at IS NULL OR b.expires_at > now()');
  });

  it('keeps the rules the old policies already enforced', () => {
    const pol = sliceSqlStatement(MIG, 'CREATE POLICY "table_chat_insert"');
    expect(pol).toContain('user_id = auth.uid()');
    expect(pol).toContain("message_type = 'player'");
    // The club membership predicate is carried over byte for byte; widening it
    // is a separate change with a separate risk profile.
    const club = sliceSqlStatement(MIG, 'CREATE POLICY "Members can insert club chat"');
    expect(club).toContain("club_members.status = 'active'");
  });

  it('ships a rollback', () => {
    expect(MIG).toContain('-- ROLLBACK');
    expect(MIG).toContain('DROP FUNCTION IF EXISTS public.fn_table_chat_is_silenced(uuid);');
  });
});

describe('Multi-Day MTT enforcement lives in the database', () => {
  const MIG = read(
    'supabase/migrations/20260826_multi_day_mtt_refuses_to_be_set_until_it_is_built.sql'
  );

  /* A trigger and not a CHECK constraint, because the error text is the point:
     a club owner has to be told WHY, or the refusal is just a different lie. */
  it('refuses both columns, for every writer, with a reason', () => {
    expect(MIG).toContain('BEFORE INSERT OR UPDATE OF is_multi_day, total_days');
    expect(MIG).toContain('COALESCE(NEW.is_multi_day, false) IS TRUE');
    expect(MIG).toContain('COALESCE(NEW.total_days, 1) > 1');
    expect(MIG).toContain('no Day 2 resume and no flight merge');
  });

  it('refuses to install itself if any tournament already carries the flag', () => {
    const pre = sliceDollarQuoted(MIG, '$preflight$');
    expect(pre).toContain('refusing to install the guard');
  });

  it('ships a rollback', () => {
    expect(MIG).toContain('-- ROLLBACK');
    expect(MIG).toContain('DROP TRIGGER IF EXISTS trg_tournaments_refuse_unbuilt_multi_day');
  });
});
