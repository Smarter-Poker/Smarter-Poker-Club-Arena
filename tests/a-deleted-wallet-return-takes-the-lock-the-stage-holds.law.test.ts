/**
 * A DELETED-WALLET RETURN TAKES THE LOCK THE STAGE ALREADY HOLDS (2026-10-17)
 *
 * Round 3 of the 2026-10-05 Midway close deadlocked twice (12:15, 15:10 UTC)
 * inside fn_ca_deleted_wallet_bank_return: the rakeback stage holds the club
 * and its wallets FOR NO KEY UPDATE, and the return asked for them again FOR
 * UPDATE, which waits on every hand holding FOR KEY SHARE on the club (any
 * insert referencing clubs). The function changes balance columns only, so it
 * takes FOR NO KEY UPDATE. This law keeps a FOR UPDATE from coming back.
 * scripts/ci/fixtures/deleted-wallet-return-lock/reproduce.sh shows both cases.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017161610_a_deleted_wallet_return_takes_the_lock_the_stage_holds.sql',
  'utf8'
);
const news = ['n1', 'n2', 'n3'].map((t) => sql.split(`$${t}$`)[1]);

describe('a deleted-wallet return takes the lock the stage holds', () => {
  it('reads agents, club_members and clubs FOR NO KEY UPDATE', () => {
    expect(news[0]).toContain('FROM public.agents WHERE club_id=p_club AND user_id=p_user FOR NO KEY UPDATE;');
    expect(news[1]).toContain(
      'INTO v_player FROM public.club_members WHERE club_id=p_club AND user_id=p_user FOR NO KEY UPDATE;'
    );
    expect(news[2]).toContain("WHERE id=p_club AND asset='chips' AND lifecycle_status='active' FOR NO KEY UPDATE;");
    for (const n of news) expect(n).not.toMatch(/FOR UPDATE/);
  });

  it('refuses to install if any FOR UPDATE would remain, and pins both bodies', () => {
    expect(sql).toContain("IF position('FOR UPDATE' in v_new) > 0 THEN");
    expect(sql).toContain("'975a6eb235c2d0a6e0f7e84043bb3d28'");
    expect(sql).toContain("'43efd888e3b5364693bbc8fc03855c93'");
    expect(sql).toContain('original_inventory_proof_sources_match() IS DISTINCT FROM true');
  });

  it('changes no money: only the three lock clauses are substituted', () => {
    expect(sql.match(/c_old\d constant text/g)?.length).toBe(3);
    expect(sql).not.toMatch(/(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?(?:chip_ledger|club_members|clubs|agents)\b(?![^$]*\$[on]\d\$)/i);
  });
});
