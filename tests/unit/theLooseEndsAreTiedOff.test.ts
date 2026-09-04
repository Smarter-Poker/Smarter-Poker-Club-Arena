/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE LOOSE ENDS FROM PHASES 1-5 ARE TIED OFF
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04)
 *
 * Every phase of the club operations upgrade left one or two items "for one
 * release" or "for the next batch". Dan asked for all of them closed before
 * phase 6, and this pins each one so it cannot quietly come back:
 *
 *   - the payables estimate (phase 3) and the legacy payload keys (phases 4
 *     and 5) are off the live functions;
 *   - the roster summary counts the club the directory lists;
 *   - the engine no longer maintains a rollup nothing reads;
 *   - the agent console's exclusion carries a reason and an expiry;
 *   - the agent dashboard pages its ledgers from the server and its cache no
 *     longer truncates the arrays the stat cards sum;
 *   - the rake channel is shared, not one per subscriber;
 *   - three dead AgentService methods are gone, the one that UPDATEd a table
 *     with no UPDATE policy and returned true included;
 *   - the empty icon wrappers left when emoji were stripped are gone;
 *   - all-gates.sh runs the entry-chunk gate, which it had not.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sliceDollarQuoted, sliceMethod } from '../helpers/sourceWindow';

const MIGRATION = readFileSync(
  'supabase/migrations/20260904200000_the_estimates_and_the_old_keys_come_down.sql',
  'utf8'
);
const NETWORK = readFileSync('src/pages/AgentManagementPage.tsx', 'utf8');
const DASH = readFileSync('src/pages/AgentDashboardPage.tsx', 'utf8');
const SERVICE = readFileSync('src/services/AgentService.ts', 'utf8');
const RAKE = readFileSync('src/services/AgentRakeService.ts', 'utf8');
const ROSTER_SERVICE = readFileSync('src/services/ClubRosterService.ts', 'utf8');
const ENGINE = readFileSync('server/src/index.ts', 'utf8');
const GATES = readFileSync('scripts/ci/all-gates.sh', 'utf8');

const fn = (name: string) => {
  const start = MIGRATION.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sliceDollarQuoted(MIGRATION.slice(start), '$function$');
};

describe('the migration', () => {
  it('is one transaction and asserts each key is gone before it commits', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
    const block = sliceDollarQuoted(MIGRATION.slice(MIGRATION.lastIndexOf('DO $$')), '$$');
    for (const key of ['estimate', 'completed_30d', 'total_games']) {
      expect(block).toContain(`'%${key}%'`);
    }
  });

  it('takes the estimate off the payables read and raises the cap now the rollup pays for it', () => {
    const body = fn('fn_ca_agent_payables');
    expect(body).not.toContain('estimate');
    expect(body).toContain('v_cap constant integer := 500;');
    expect(body).toContain('LEFT JOIN agent_commission_unsettled_rollup o');
  });

  it('takes the legacy keys off tournaments and statistics', () => {
    expect(fn('ca_club_tournaments')).not.toContain('completed_30d');
    expect(fn('ca_club_tournaments')).toContain("'completed_in_window'");
    const stats = fn('ca_club_member_statistics');
    for (const key of ['total_games', 'total_hands', "'wins'", "'winner'"]) {
      expect(stats).not.toContain(key);
    }
    expect(stats).toContain("'hands_won'");
  });

  it('counts the club the directory lists, and still resolves the viewer across the scope', () => {
    const body = fn('ca_club_members_summary');
    expect(body).toContain('WHERE cm.club_id = p_club_id');
    expect(body).toContain('AND ts.club_id = p_club_id');
    expect(body).toContain('AND t.club_id = p_club_id');
    // The viewer's own role is still looked up across the union scope.
    expect(body).toContain('cm.club_id = ANY(v_scope)');
  });

  it('restates every grant for the definer gate', () => {
    for (const sig of [
      'fn_ca_agent_payables(uuid)',
      'ca_club_tournaments(uuid, integer, integer)',
      'ca_club_member_statistics(uuid, uuid, text, date, date)',
      'ca_club_members_summary(uuid)',
    ]) {
      expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
    }
  });
});

describe('the clients no longer read what came down', () => {
  it('the payouts tab has no estimate line and no estimate field', () => {
    expect(NETWORK).not.toContain('The Previous Estimate');
    expect(NETWORK).not.toContain('total_estimate');
    expect(NETWORK).not.toMatch(/^\s*estimate: number;/m);
  });

  it('the roster service reads the new statistics keys only', () => {
    expect(ROSTER_SERVICE).toContain('hands: num(d.hands),');
    expect(ROSTER_SERVICE).toContain('hands_won: num(d.hands_won),');
    expect(ROSTER_SERVICE).not.toContain('d.total_hands');
    expect(ROSTER_SERVICE).not.toContain('touchFeeRollup');
  });
});

describe('the engine stops maintaining a rollup nothing reads', () => {
  it('has no fee rollup loop', () => {
    expect(ENGINE).not.toContain('fn_refresh_member_fee_rollup');
    expect(ENGINE).not.toContain('startMemberFeeRollup()');
    expect(ENGINE).not.toContain('stopMemberFeeRollup()');
    expect(ENGINE).toContain('MEMBER FEE ROLLUP - RETIRED');
  });
});

describe('the agent console exclusion carries a reason and an expiry', () => {
  it('sends what the operator wrote, never a hardcoded sentence', () => {
    const ban = sliceMethod(NETWORK, 'const executeBan = async');
    expect(ban).toContain('p_reason: reason,');
    expect(ban).toContain('p_expires_at: expiresAt,');
    expect(ban).toContain('if (reason.length < 3) {');
    expect(NETWORK).not.toContain("p_reason: 'Banned from the agent network console'");
  });

  it('is a labelled dialog whose Confirm waits for a reason', () => {
    expect(NETWORK).toContain('aria-labelledby="ban-dialog-title"');
    expect(NETWORK).toContain('disabled={banBusy || banReason.trim().length < 3}');
    expect(NETWORK).toContain('<option value="">Never</option>');
    expect(NETWORK).toContain('<option value="90">In 90 Days</option>');
  });
});

describe('the agent dashboard', () => {
  it('pages transactions and commissions from the server', () => {
    expect(DASH).toContain('.range(recentTx.length, recentTx.length + TX_PAGE - 1)');
    expect(DASH).toContain('.range(commissions.length, commissions.length + COMMISSION_PAGE - 1)');
    expect(DASH).not.toContain('paginatedTx');
    expect(DASH).not.toMatch(/\.limit\(100\)/);
    expect(DASH).not.toMatch(/\.limit\(50\)/);
  });

  it('says when a list is complete and when the cache is the whole picture', () => {
    expect(DASH).toContain('All {fmt(recentTx.length)} Transactions Loaded');
    expect(DASH).toContain('All {fmt(commissions.length)} Commission Rows Loaded');
    // The SWR cache used to slice players to 30 and commissions to 20, and
    // the stat cards summed the slices.
    expect(DASH).toContain('players: enrichedPlayers,');
    expect(DASH).not.toContain('enrichedPlayers.slice(0, 30)');
    expect(DASH).not.toContain('(comms || []).slice(0, 20)');
  });

  it('shows a bus-driven refresh instead of setting a flag nobody reads', () => {
    expect(DASH).toMatch(/\{isRefreshing && \(/);
  });
});

describe('the agent console', () => {
  it('names each wallet balance and says when the agent list is capped', () => {
    expect(NETWORK).toContain('className={styles.walletLabel}>Agent<');
    expect(NETWORK).toContain('className={styles.walletLabel}>Player<');
    expect(NETWORK).toContain('className={styles.walletLabel}>Promo<');
    expect(NETWORK).not.toMatch(/className=\{styles\.(summaryIcon|walletIcon|roleIcon)\}><\/span>/);
    expect(NETWORK).toContain('agents.length >= QUERY_LIMITS.MODERATE');
  });
});

describe('the services', () => {
  it('AgentService no longer carries the three dead methods', () => {
    for (const name of ['promoteToAgent', 'assignPlayerToAgent(', 'selfTransfer(']) {
      expect(SERVICE).not.toMatch(new RegExp(`async ${name.replace('(', '\\(')}`));
    }
  });

  it('the rake channel is one per club and shared', () => {
    expect(RAKE).toContain('const rakeChannels = new Map<');
    expect(RAKE).toContain('.channel(`downline-rake-${key}`)');
    expect(RAKE).not.toContain('Math.random()');
    expect(RAKE).toContain('if (current.listeners.size === 0) {');
  });
});

describe('the local gate set', () => {
  it('runs entry-chunk-delta after the build', () => {
    expect(GATES).toContain("step 'entry-chunk-delta' node scripts/ci/entry-chunk-delta.mjs dist");
  });
});
