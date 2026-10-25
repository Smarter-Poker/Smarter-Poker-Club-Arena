/**
 * A CORRECTION INTO PRIZE_LIABILITY IS HOUSE FUNDING TOO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_tournament_conservation_delta's funded_overlay term recognises a
 * chip_ledger leg as house funding only when category='overlay'. On
 * 2026-09-09 a CLAUDE.md 10.9 backpay correctly funded two Sunday $200 Deep
 * Stack winners' bubble-protection shortfall from club_treasury/union_bank
 * into prize_liability - the identical shape an overlay funds a guarantee -
 * but tagged category='correction', because it was a backpay, not a
 * guarantee. The delta never looked for 'correction', so it re-flagged both
 * already fully-settled tournaments as "paid out money it never collected"
 * (delta -180.00, to the penny, on every run of fn_tournament_money_conservation
 * since) - 14+ false financial_alerts rows for money that was already paid
 * correctly, once, in full.
 *
 * IF THIS TEST IS FAILING you have narrowed the funded_overlay term back to
 * category='overlay' alone. A correction paid from a house treasury bank
 * (club_treasury or union_bank) into a tournament's prize_liability is the
 * same house funding an overlay is; the delta must count it or it will flag
 * the very act of honouring CLAUDE.md 10.9 as an unexplained shortfall,
 * forever, every day the sweep runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // 14-digit version prefix: lexical order is chronological order

const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

/** The body of the newest migration that restates this function. */
function newestDefinition(fn: string): { file: string; body: string } {
  let found = { file: '', body: '' };
  const open = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, 'i');
  for (const f of files) {
    const sql = read(f);
    const at = sql.search(open);
    if (at === -1) continue;
    const rest = sql.slice(at);
    const end = rest.indexOf('$function$;');
    found = { file: f, body: end === -1 ? rest : rest.slice(0, end) };
  }
  return found;
}

const delta = newestDefinition('fn_tournament_conservation_delta');

/**
 * Pull the WHERE clause of the funded_overlay term's chip_ledger subquery -
 * the block between "FROM public.chip_ledger l" and the closing "), 0)" that
 * ends the first arm of the GREATEST(...). Scoped narrowly so this test fails
 * on the exact term it is about, not on some unrelated chip_ledger read
 * elsewhere in the function.
 */
function fundedOverlayLedgerClause(body: string): string {
  const at = body.indexOf('FROM public.chip_ledger l');
  expect(
    at,
    'fn_tournament_conservation_delta no longer reads chip_ledger for funded_overlay'
  ).toBeGreaterThan(-1);
  const end = body.indexOf('), 0)', at);
  expect(end, 'could not find the end of the chip_ledger funded_overlay subquery').toBeGreaterThan(
    -1
  );
  return body.slice(at, end);
}

describe('a correction into prize_liability is house funding too', () => {
  it('fn_tournament_conservation_delta is still defined in the migrations', () => {
    expect(delta.file, 'no migration defines fn_tournament_conservation_delta').toBeTruthy();
  });

  it("the funded_overlay chip_ledger term counts a house treasury's correction, not only its overlay", () => {
    const clause = fundedOverlayLedgerClause(delta.body);
    expect(
      clause,
      `fn_tournament_conservation_delta (${delta.file})'s funded_overlay term does not recognise ` +
        `category='correction' as house funding. A CLAUDE.md 10.9 backpay from club_treasury or ` +
        `union_bank into a tournament's prize_liability is house money added to the pool exactly ` +
        `like an overlay; excluding it makes the delta flag its own already-settled correction as ` +
        `an unexplained shortfall on every future run.`
    ).toMatch(
      /category\s+IN\s*\(\s*'overlay'\s*,\s*'correction'\s*\)|category\s+IN\s*\(\s*'correction'\s*,\s*'overlay'\s*\)/i
    );
  });

  it('the widened recognition is still scoped to an actual house treasury bank', () => {
    const clause = fundedOverlayLedgerClause(delta.body);
    expect(
      clause,
      `fn_tournament_conservation_delta (${delta.file}) widened funded_overlay to 'correction' ` +
        `without scoping from_type to a house treasury bank. An unrelated correction (e.g. from a ` +
        `suspense account) would then be silently read as house funding, hiding a real shortfall.`
    ).toMatch(
      /from_type\s+IN\s*\(\s*'club_treasury'\s*,\s*'union_bank'\s*\)|from_type\s+IN\s*\(\s*'union_bank'\s*,\s*'club_treasury'\s*\)/i
    );
  });
});
