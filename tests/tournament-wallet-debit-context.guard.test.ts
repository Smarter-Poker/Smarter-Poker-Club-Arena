import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260909182500_wallet_debit_uses_the_game_club_and_cannot_mint.sql'
  ),
  'utf8'
);
const start = migration.indexOf('AS $wallet_debit$');
const end = migration.indexOf('$wallet_debit$;', start + 1);
const body = migration.slice(start, end);

describe('the generic wallet debit follows the game and cannot mint', () => {
  it('rejects invalid money before looking up or changing a wallet', () => {
    const validation = body.indexOf('p_amount <= 0');
    const table = body.indexOf('FROM public.tables t');
    const tournament = body.indexOf('FROM public.tournaments t');
    const update = body.indexOf('UPDATE public.club_members cm');
    expect(validation).toBeGreaterThan(-1);
    expect(body).toContain('p_amount <> round(p_amount,2)');
    expect(table).toBeGreaterThan(validation);
    expect(tournament).toBeGreaterThan(validation);
    expect(update).toBeGreaterThan(tournament);
  });

  it('resolves explicit, table, and tournament club context before home club', () => {
    const declared = body.indexOf("current_setting('app.ledger_club_id',true)");
    const table = body.indexOf('FROM public.tables t');
    const tournament = body.indexOf('FROM public.tournaments t');
    const home = body.indexOf('fn_player_home_club(p_user_id,NULL)');
    expect(declared).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(declared);
    expect(tournament).toBeGreaterThan(table);
    expect(home).toBeGreaterThan(tournament);
    expect(body).toContain('declared club does not own table');
    expect(body).toContain('declared club does not own tournament');
  });

  it('keeps one caller-owned wallet receipt and service-only ACLs', () => {
    expect(body).toContain('INSERT INTO public.chip_transactions');
    expect(body).not.toContain('INSERT INTO public.wallet_transactions');
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.atomic_deduct_wallet_and_log\([\s\S]*?PUBLIC,anon,authenticated;/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.atomic_deduct_wallet_and_log\([\s\S]*?TO service_role;/
    );
  });
});
