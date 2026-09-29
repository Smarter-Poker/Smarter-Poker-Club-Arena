/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN ACCOUNT CLOSES WITHOUT TOUCHING THE BOOKS (2026-09-29, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Nobody could delete their account. The World Hub's DELETE
 * /api/auth/delete-account - called by this app's Settings, Close Account, and
 * by the World Hub's own settings page - hard-deleted rows and then the Auth
 * user, and it failed for EVERY account: 42501 on its first write
 * (service_role holds no write privilege on cashout_requests), and past that
 * P0403, because every account is born with a journal row (The Mint's signup
 * grant in diamond_transactions), the journals are append-only, and a hard
 * delete of profiles or auth.users cascades into them. App Review 5.1.1(v) and
 * Google Play both require that an account made in the app can be deleted in
 * the app.
 *
 * public.fn_close_account now closes the account in one transaction and the
 * World Hub soft-deletes the Auth user. THE LAW, for the definition in force:
 *
 *   1. It refuses before it writes. Every settlement check - the club's own
 *      departure rules applied to every club, then the platform's financial
 *      precheck - comes before the first INSERT, UPDATE or DELETE, so a refusal
 *      changes nothing.
 *   2. It never removes the rows the journals hang from (profiles, users,
 *      auth.users), never writes a balance column, and never names a journal.
 *   3. It leaves clubs through the lifecycle door
 *      (app.club_membership_lifecycle_write = 'depart') and keeps the rows: a
 *      membership is part of the club's operating record.
 *   4. Only service_role may call it, and the money guard knows it moves no
 *      money ('system', registered above the CREATE).
 *   5. Its refusal reasons are exactly the ones the World Hub endpoint has an
 *      instruction for (pinned there by delete-account-closes-the-account).
 *   6. The person's pictures go with them (added 2026-09-29, migration
 *      20260929070440): the profile's picture links are cleared, and the
 *      avatar record (a custom avatar's image link and the words that
 *      described them) and the profile editor's media library are deleted.
 *      All three tables reference auth.users ON DELETE CASCADE - they were
 *      meant to go with the person - and the soft delete never cascades. The
 *      World Hub endpoint removes the files through the Storage API
 *      (pinned there by delete-account-closes-the-account).
 *
 * Registry: docs/laws.d/an-account-closes-without-touching-the-books.md
 */
import { describe, expect, it } from 'vitest';
import { latestDeclaring } from './helpers/migrations';

const FN = 'fn_close_account';
const { name: MIGRATION, sql: SQL } = latestDeclaring(FN);

function functionBody(sql: string): string {
  const open = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${FN}(`);
  const start = sql.indexOf('AS $function$', open);
  const end = sql.indexOf('$function$;', start + 'AS $function$'.length);
  if (open < 0 || start < 0 || end < 0)
    throw new Error(`cannot read the body of ${FN} in ${MIGRATION}`);
  return sql.slice(start + 'AS $function$'.length, end);
}

const BODY = functionBody(SQL);
/** Code only: a comment that mentions a table is not a read of it. */
const CODE = BODY.replace(/--[^\n]*/g, '');

const FIRST_WRITE = (() => {
  const m = /\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i.exec(CODE);
  if (!m) throw new Error(`${FN} writes nothing - the law cannot find its first write`);
  return m.index;
})();

const BALANCE_COLUMNS = [
  'chip_balance',
  'held_chips',
  'locked_chips',
  'promo_balance',
  'credit_used',
  'diamonds',
];

const SETTLEMENT_CHECKS: Array<[string, RegExp]> = [
  [
    'a seat not yet left',
    /FROM public\.table_seats ts\s+WHERE ts\.user_id = p_user_id AND ts\.left_at IS NULL/,
  ],
  ['a live tournament entry', /FROM public\.tournament_players tp/],
  ['a cashout in flight', /FROM public\.cashout_requests cr/],
  ['an unreleased escrow', /FROM public\.chip_escrow ce/],
  ['a held escrow hold', /FROM public\.chip_escrow_holds h/],
  ['a pending chip request', /FROM public\.chip_requests r/],
  ['a wallet balance', /FROM public\.wallets w/],
  ['an issued ticket', /FROM public\.tournament_tickets t/],
  ['an agent row', /FROM public\.agents a WHERE a\.user_id = p_user_id/],
  ['a downline', /cm\.agent_id = p_user_id OR cm\.parent_agent_id = p_user_id/],
  ['an owned club', /FROM public\.clubs c\s+WHERE c\.owner_id = p_user_id/],
  ['an owned union', /FROM public\.unions u WHERE u\.owner_id = p_user_id/],
  ['the platform financial precheck', /public\.fn_ca_gdpr_financial_precheck\(p_user_id\)/],
];

// The reasons the World Hub endpoint answers with an instruction
// (pages/api/auth/delete-account.js REFUSALS), plus the two that mean the call
// itself was wrong and answer 500.
const WORLD_HUB_REASONS = [
  'seated',
  'tournament_entry',
  'pending_cashout',
  'escrow',
  'chip_request',
  'club_chips',
  'wallet_balance',
  'open_ticket',
  'club_agent',
  'downline',
  'club_owner',
  'club_staff',
  'union_owner',
  'financial',
];

describe(`${FN} (in force: ${MIGRATION})`, () => {
  it('refuses before it writes: every settlement check precedes the first write', () => {
    for (const [what, probe] of SETTLEMENT_CHECKS) {
      const m = probe.exec(CODE);
      expect(m, `${FN} no longer checks ${what}`).not.toBeNull();
      expect(m!.index, `${FN} checks ${what} after it has started writing`).toBeLessThan(
        FIRST_WRITE
      );
    }
    for (const column of BALANCE_COLUMNS) {
      const at = CODE.search(new RegExp(`abs\\(COALESCE\\(cm\\.${column}, 0\\)\\)`));
      expect(at, `${FN} no longer refuses on club_members.${column}`).toBeGreaterThan(-1);
      expect(at).toBeLessThan(FIRST_WRITE);
    }
  });

  it('keeps the rows the journals hang from, and never writes a balance or a journal', () => {
    expect(CODE).not.toMatch(/DELETE\s+FROM\s+public\.(profiles|users|club_members)\b/i);
    expect(CODE).not.toMatch(/\bauth\.users\b/i);
    expect(CODE).not.toMatch(
      /\b(diamond_transactions|chip_ledger|chip_transactions|club_ledger)\b/i
    );
    const updates = CODE.match(/UPDATE\s+public\.\w+[\s\S]*?;/gi) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const statement of updates) {
      const setClause = statement.slice(
        statement.search(/\bSET\b/i),
        statement.search(/\bWHERE\b/i)
      );
      for (const column of [
        ...BALANCE_COLUMNS,
        'diamond_balance',
        'balance',
        'locked_balance',
        'stack',
      ]) {
        expect(setClause, `${FN} writes ${column}: ${statement.slice(0, 60)}`).not.toMatch(
          new RegExp(`\\b${column}\\s*=`, 'i')
        );
      }
    }
  });

  it('leaves clubs through the lifecycle door and keeps the membership rows', () => {
    const open = CODE.indexOf("set_config('app.club_membership_lifecycle_write', 'depart', true)");
    const depart = CODE.search(
      /UPDATE public\.club_members cm\s+SET status = CASE WHEN c\.asset = 'diamonds'/
    );
    const close = CODE.indexOf("set_config('app.club_membership_lifecycle_write', '', true)");
    expect(open).toBeGreaterThan(-1);
    expect(depart).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(depart);
    expect(CODE).toMatch(/membership_lifecycle_status = 'departed'/);
    expect(CODE).toMatch(/departure_reason = 'Account Closed'/);
  });

  it('is callable by service_role only, and registered as moving no money', () => {
    expect(SQL).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_close_account\(uuid\) FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_close_account\(uuid\) TO service_role;/
    );
    expect(SQL).not.toMatch(
      /GRANT[^;]*fn_close_account[^;]*TO[^;]*\b(anon|authenticated|PUBLIC)\b/i
    );
    const registry = SQL.search(
      /INSERT INTO public\.ca_money_rpc_registry[\s\S]*?'fn_close_account', 'system'/
    );
    expect(
      registry,
      'the money guard refuses a balance-reading function it has not been told about'
    ).toBeGreaterThan(-1);
    expect(registry).toBeLessThan(SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${FN}(`));
  });

  it("takes the person's pictures with them: the links, the avatar record and the media library", () => {
    const scrub = CODE.search(/UPDATE public\.profiles SET/);
    expect(scrub, `${FN} no longer scrubs the profile`).toBeGreaterThan(-1);
    const scrubStatement = CODE.slice(scrub, CODE.indexOf(';', scrub));
    for (const column of ['avatar_url', 'cover_photo_url', 'arena_avatar_url']) {
      expect(scrubStatement, `${FN} no longer clears profiles.${column}`).toMatch(
        new RegExp(`\\b${column} = NULL`)
      );
    }
    for (const table of ['user_avatars', 'user_media', 'user_albums']) {
      expect(CODE, `${FN} no longer deletes the person's ${table} rows`).toMatch(
        new RegExp(`DELETE FROM public\\.${table} \\w+ WHERE \\w+\\.user_id = p_user_id;`)
      );
    }
  });

  it('refuses with exactly the reasons the World Hub has an instruction for', () => {
    const reasons = new Set([...CODE.matchAll(/'reason', '([a-z_]+)'/g)].map((m) => m[1]));
    reasons.delete('no_user');
    reasons.delete('profile_not_found');
    expect([...reasons].sort()).toEqual([...WORLD_HUB_REASONS].sort());
  });
});
