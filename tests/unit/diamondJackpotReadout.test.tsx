import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DiamondJackpotReadout } from '../../src/components/bbj/DiamondJackpotReadout';

afterEach(cleanup);
describe('whole Diamond jackpot readout', () => {
  it.each([0, 2792, 999999999999])('keeps all %s Diamonds on two separate lines', (amount) => {
    const { container } = render(<DiamondJackpotReadout amount={amount} />);
    const whole = amount.toLocaleString('en-US');
    expect(screen.getByText(whole).className).toBe('lobby-bbj__number');
    expect(screen.getByText('Diamonds').className).toBe('lobby-bbj__unit');
    expect(container.querySelector('strong')?.textContent).toBe(`${whole} Diamonds`);
  });
});
