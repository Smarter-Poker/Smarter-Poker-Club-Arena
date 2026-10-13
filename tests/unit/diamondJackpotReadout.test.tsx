import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DiamondJackpotReadout } from '../../src/components/bbj/DiamondJackpotReadout';

afterEach(cleanup);
describe('whole Diamond jackpot readout', () => {
  it('runs the rendered fit cases through the required lobby chrome lane', () => {
    const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');
    expect(read('.github/workflows/ci.yml')).toContain('tests/e2e/mobile-lobby-chrome.spec.ts');
    const owner = read('tests/e2e/mobile-lobby-chrome.spec.ts');
    expect(owner).toContain("from './helpers/diamond-jackpot-readout-cases'");
    expect(owner).toContain('registerDiamondJackpotReadoutCases();');
    const cases = read('tests/e2e/helpers/diamond-jackpot-readout-cases.ts');
    expect(cases).toContain('for (const width of [375, 393, 430, 1440])');
    expect(cases).toContain('for (const amount of [0, 2792, 999999999999])');
  });
  it.each([0, 2792, 999999999999])('keeps all %s Diamonds on two separate lines', (amount) => {
    const { container } = render(<DiamondJackpotReadout amount={amount} />);
    const whole = amount.toLocaleString('en-US');
    expect(screen.getByText(whole).className).toBe('lobby-bbj__number');
    expect(screen.getByText('Diamonds').className).toBe('lobby-bbj__unit');
    expect(container.querySelector('strong')?.textContent).toBe(`${whole} Diamonds`);
  });
});
