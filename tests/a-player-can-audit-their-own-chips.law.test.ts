/**
 * A PLAYER CAN AUDIT THEIR OWN CHIPS (phase 7, roadmap 9.5).
 *
 * chip_ledger's RLS let a player read their own legs and no surface showed
 * them properly: the wallet page's feed asked for performed_by and
 * to_entity_id only, so every chip that LEFT the player was invisible, and
 * it carried no balance and nothing to check one against. What this pins:
 *
 *   1. fn_ca_chip_statement exists, binds scope=player to auth.uid() (never
 *      a parameter), gates scope=club_treasury on ca_can_view_club_finances,
 *      and has no horse branch (CLAUDE.md 10.5);
 *   2. it returns BOTH directions and an audit block whose status is one of
 *      the stated shapes, read from the nightly ca_account_snapshots reading;
 *   3. the wallet page renders the statement, not the one-sided feed, and
 *      the feed that remains asks for from_entity_id too;
 *   4. the component never reads an error as "no movements".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .find((f) => f.includes('a_player_can_audit_their_own_chips'));
const sql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';
/** The function body alone - the migration's own DO block and header talk ABOUT horses. */
const fnBody = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_chip_statement('),
  sql.indexOf('END $fn$;')
);
const component = readFileSync(join(ROOT, 'src/components/wallet/ChipStatement.tsx'), 'utf8');
const wallet = readFileSync(join(ROOT, 'src/pages/PlayerWalletPage.tsx'), 'utf8');
const financials = readFileSync(join(ROOT, 'src/pages/ClubFinancialsPage.tsx'), 'utf8');
const feed = readFileSync(join(ROOT, 'src/components/common/TransactionLedgerView.tsx'), 'utf8');

describe('a player can audit their own chips', () => {
  it('the migration exists', () => {
    expect(file, 'the statement migration must not be deleted').toBeTruthy();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_chip_statement(');
  });

  it("a player statement is always the caller's own, and a horse is a player", () => {
    expect(sql).toMatch(/v_entity := v_caller;/);
    expect(fnBody).not.toMatch(/p_entity|p_user_id|p_player_id/);
    expect(fnBody).not.toMatch(/is_horse/i);
    expect(component).not.toMatch(/is_horse/i);
    expect(sql).toMatch(
      /VERIFY FAILED: the player statement does not bind the entity to auth\.uid\(\)/
    );
    expect(sql).toMatch(/VERIFY FAILED: the statement treats horses differently/);
  });

  it('the treasury statement is behind the club-finance gate', () => {
    expect(sql).toMatch(/IF NOT public\.ca_can_view_club_finances\(p_club_id\) THEN/);
    expect(sql).toMatch(
      /VERIFY FAILED: the club treasury statement is not behind ca_can_view_club_finances/
    );
  });

  it("both directions, from the account's point of view, one index range per side", () => {
    expect(sql).toMatch(/'in'::text AS direction/);
    expect(sql).toMatch(/'out'::text, l\.to_type, l\.to_label, l\.to_entity_id/);
    expect(sql).toMatch(/UNION ALL/);
    expect(sql).toMatch(/VERIFY FAILED: only one direction in the page/);
  });

  it('the audit block has stated shapes and comes from the nightly reading', () => {
    for (const s of ["'reconciles'", "'does_not_reconcile'", "'no_reading_yet'", "'no_balance'"])
      expect(sql).toContain(s);
    expect(sql).toMatch(/FROM public\.ca_account_snapshots s/);
    expect(sql).toMatch(/'expected_now', v_expected/);
    expect(sql).toMatch(/'unexplained'/);
    expect(sql).toMatch(/VERIFY FAILED: the audit block has no stated shape/);
  });

  it('anon cannot call it; authenticated can', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_chip_statement\(text, uuid, timestamptz, integer\) FROM PUBLIC, anon;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_chip_statement\(text, uuid, timestamptz, integer\) TO authenticated, service_role;/
    );
    expect(sql).toMatch(/VERIFY FAILED: anon can call the statement/);
  });

  it('the wallet page shows the statement, and the feed that remains shows both directions', () => {
    expect(wallet).toMatch(/<ChipStatement scope="player" \/>/);
    expect(wallet).not.toMatch(/TransactionLedgerView/);
    expect(financials).toMatch(
      /<ChipStatement\s+scope="club_treasury"\s+clubId=\{resolvedClubId\}/
    );
    expect(feed).toMatch(/from_entity_id\.eq\.\$\{userId\}/);
  });

  it('the component asks the RPC and never guesses', () => {
    expect(component).toMatch(/supabase\.rpc\('fn_ca_chip_statement'/);
    expect(component).toMatch(/The Statement Could Not Be Loaded/);
    expect(component).toMatch(/does_not_reconcile/);
    expect(component).toMatch(/no_reading_yet/);
    expect(component).not.toContain('—');
  });
});
