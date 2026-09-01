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
    expect(modal).toContain('1 Minute After Rebuy Period');
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

  it('keeps a configured Spins reserve represented in the wallet', () => {
    expect(wallet.match(/spinsActive: spins\.state !== null/g)).toHaveLength(2);
  });
});
