import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const refundSql = read(
  'supabase/migrations/20260909014421_satellite_settlement_has_one_atomic_authority.sql'
);
const purchaseSql = read(
  'supabase/migrations/20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
);
const service = read('src/services/TournamentService.ts');
const modal = read('src/components/table/RebuyModal.tsx');

function taggedBody(source: string, tag: string): string {
  const delimiter = `$${tag}$`;
  const start = source.indexOf(delimiter);
  const end = source.indexOf(delimiter, start + delimiter.length);
  expect(start, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(end, `closing ${delimiter}`).toBeGreaterThan(start);
  return source.slice(start + delimiter.length, end);
}

describe('fractional tournament fee and bounty rails stay exact end to end', () => {
  const chargeSplit = taggedBody(refundSql, 'charge_split');
  const escrow = taggedBody(refundSql, 'exact_refund_read_model');
  const purchase = taggedBody(purchaseSql, 'tournament_chip_purchase_money');

  it('books the rebuy fee and bounty head to cents without crossing ten percent', () => {
    expect(purchase).toContain('trunc(v_total*v_ratio*100+0.000001)/100');
    expect(purchase).toContain('trunc(v_total*0.1*100+0.000001)/100');
    expect(purchase).toContain('round(COALESCE(v_t.bounty_amount,0),2)');
    expect(purchase).not.toMatch(/round\(COALESCE\(v_t\.bounty_amount,0\)\)(?!,)/);
    expect(purchase).toContain('round(v_base+v_bounty_head+v_fee,2)<>round(v_total,2)');
  });

  it('captures the identical cents in refund entitlement and escrow read models', () => {
    expect(chargeSplit).toContain('round(COALESCE(v_t.bounty_amount,0),2)');
    expect(chargeSplit).not.toMatch(/round\(COALESCE\(v_t\.bounty_amount,0\)\)(?!,)/);
    expect(chargeSplit).toContain('round(refund_prize+refund_bounty+refund_fee,2)');
    expect(escrow).toContain('GREATEST(0,round(t.bounty_amount,2))');
    expect(escrow).not.toMatch(/round\(t\.bounty_amount\)(?!,)/);
  });

  it('quotes and renders the same cent split instead of rounding each leg upward', () => {
    expect(service).toContain("import { DEFAULT_RAKE_RATE, splitBuyIn } from '../utils/buyIn'");
    expect(service).toContain('return splitBuyIn(baseCost, rate).fee');
    expect(modal).toContain('Math.round((Number(rebuyCost) + Number(rebuyFee)) * 100) / 100');
    expect(modal).toContain('moneyExact(rebuyCost)');
    expect(modal).toContain('moneyExact(rebuyFee)');
  });
});
