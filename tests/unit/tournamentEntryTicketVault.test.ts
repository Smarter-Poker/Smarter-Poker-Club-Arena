import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('Tournament Ticket Vault', () => {
  const cashier = code(read('src/pages/CashierTradePage.tsx'));

  it('reads and labels the immutable redemption mode', () => {
    expect(cashier).toContain(
      ".select('id, holder_id, issued_by, value, note, status, redemption_mode, created_at')"
    );
    expect(cashier).toContain("t.redemptionMode === 'tournament_entry_only'");
    expect(cashier).toContain('Tournament Entry Ticket');
    expect(cashier).toContain('Entry Only');
  });

  it('never exposes wallet Redeem or Cancel controls for an entry-only ticket', () => {
    expect(
      cashier.match(/t\.redemptionMode === 'wallet_chips' && t\.status === 'issued'/g)
    ).toHaveLength(2);
    expect(cashier).toMatch(
      /if \(row\.redemptionMode !== 'wallet_chips'\) \{[\s\S]{0,220}?return;[\s\S]{0,220}?supabase\.rpc/
    );
  });

  it('does not repeat the obsolete one-minute unregister warning', () => {
    const dialog = read('src/components/tournament/signUpDialog.tsx');
    expect(dialog).not.toMatch(/cannot unregister within 1 minute/i);
    expect(dialog).toContain('You Can Unregister Any Time Before The Tournament Starts');
  });
});
