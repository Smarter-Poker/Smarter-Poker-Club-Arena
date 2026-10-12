import { describe, expect, it, vi } from 'vitest';
import { waitForFirstContentfulPaint } from '../../scripts/ci/paint-readiness.mjs';

describe('route performance paint readiness', () => {
  it('waits for actual paint after putting the measurement page in the foreground', async () => {
    const order: string[] = [];
    const page = {
      bringToFront: async () => {
        order.push('foreground');
      },
      waitForFunction: async () => {
        order.push('paint');
      },
    };
    expect(await waitForFirstContentfulPaint(page)).toBe(true);
    expect(order).toEqual(['foreground', 'paint']);
  });

  it('reports absent paint as false so the existing FCP refusal stays armed', async () => {
    const error = Object.assign(new Error('No paint'), { name: 'TimeoutError' });
    const page = { bringToFront: vi.fn(), waitForFunction: vi.fn().mockRejectedValue(error) };
    expect(await waitForFirstContentfulPaint(page, 20)).toBe(false);
  });

  it('does not conceal browser or transport failures as a paint timeout', async () => {
    const error = new Error('Browser closed');
    const page = { bringToFront: vi.fn(), waitForFunction: vi.fn().mockRejectedValue(error) };
    await expect(waitForFirstContentfulPaint(page)).rejects.toBe(error);
  });
});
