import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leaveClubWarning } from '../../src/utils/leaveClubWarning';

describe('leaving a club says what it costs', () => {
  it('prints the exact balance being given up', () => {
    expect(leaveClubWarning(1234.5)).toBe(
      'You Hold 1,234.50 Chips Here. They Go Back To The Club And Cannot Be Recovered.'
    );
    expect(leaveClubWarning(0.37)).toContain('0.37 Chips');
  });

  it('a member with nothing gets the plain question', () => {
    expect(leaveClubWarning(0)).toBe('This Action Cannot Be Undone.');
  });

  it('an unreadable balance is never shown as zero', () => {
    expect(leaveClubWarning(null)).toContain('Any Chips You Hold');
    expect(leaveClubWarning(Number.NaN)).toContain('Any Chips You Hold');
  });

  it('carries no em dash', () => {
    for (const n of [null, 0, 12.5]) expect(leaveClubWarning(n)).not.toContain('—');
  });

  it('the confirmation prints it, and the Leave plate waits for the read', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'pages', 'HomePage.tsx'), 'utf8');
    expect(src).toContain('leaveClubWarning(leaveChips)');
    expect(src).toContain('disabled: leaveChips === undefined,');
    expect(src).not.toContain('? This Action Cannot Be Undone.');
  });
});
