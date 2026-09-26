import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const modal = readFileSync(
  join(process.cwd(), 'src/components/club/CreateTournamentModal.tsx'),
  'utf8'
);
const css = readFileSync(
  join(process.cwd(), 'src/components/club/CreateTournamentModal.module.css'),
  'utf8'
);
const wallet = readFileSync(join(process.cwd(), 'src/components/wallet/DynamicWallet.tsx'), 'utf8');

describe('club MTT creator contract', () => {
  it('separates entry rules from prize style', () => {
    expect(modal).toContain('Entry Rules');
    expect(modal).toContain('Prize Style');
    expect(modal).toContain('Progressive Knockout (PKO)');
  });

  it('publishes one fee-free 60-second add-on rule', () => {
    // The engine opens ONE 60-second period the moment the rebuy period closes
    // (TournamentManagerBase.triggerAddOnPeriod). "1 Minute After Rebuy Period"
    // read as a delay, so the pinned copy now says what happens.
    expect(modal).toContain('One 60-Second Period When The Rebuy Period Closes');
    expect(modal).not.toContain('1 Minute After Rebuy Period');
    expect(modal).toContain('Play Pauses After The Current Hand');
    expect(modal).toContain('No Rake');
    expect(modal).not.toContain('<label>Add-On Levels</label>');
    expect(modal).not.toContain('<label>Add-On Break (Minutes)</label>');
  });

  it('does not expose field caps or payout ladders for MTT creation', () => {
    expect(modal).not.toContain('The Field Cap. Registration Closes');
    expect(modal).not.toContain('Payout Structure (');
  });

  it('keeps the final action above the persistent club footer', () => {
    expect(css).toContain('z-index: 2147483000');
    expect(css).toContain('+ 120px');
  });

  it('keeps a funded Spins reserve represented in the wallet', () => {
    /* Was `spins.state !== null` (2026-09-20). The owner-state read answers a
       real object for a club that never enabled Spins, so that gate showed
       every standalone owner a zero-chip Spins Treasury. The rule is now one
       pure predicate - running, funded or seeded - and both wallet layouts
       must ask it. tests/unit/spinsWalletRowVisible.test.ts pins the rule. */
    expect(wallet.match(/spinsActive: spinsWalletRowVisible\(spins\.state\),/g)).toHaveLength(2);
    expect(wallet).not.toMatch(/spinsActive: spins\.state !== null/);
  });
});
