import type { Locator, Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { openTradeRecord } from '../e2e/support/cashierRecords';

const { ready } = vi.hoisted(() => ({ ready: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@playwright/test', () => ({ expect: () => ({ toHaveAttribute: ready }) }));

describe('Cashier Trade Record observation', () => {
  it('does not classify transient empty content before the requested ledger read resolves', async () => {
    let resolveRead!: (value: unknown) => void;
    const read = new Promise((resolve) => {
      resolveRead = resolve;
    });
    const order: string[] = [];
    const waitForResponse = vi.fn(() => {
      order.push('observe');
      return read;
    });
    const click = vi.fn(async () => {
      order.push('click');
    });
    const page = { waitForResponse, getByRole: vi.fn() } as unknown as Page;
    const tabs = { getByRole: () => ({ click }) } as unknown as Locator;
    ready.mockClear();
    let finished = false;
    const opening = openTradeRecord(page, tabs).then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(ready).not.toHaveBeenCalled();
    expect(order).toEqual(['observe', 'click']);
    resolveRead({});
    await opening;
    expect(ready).toHaveBeenCalledWith('aria-busy', 'false', { timeout: 30_000 });
    expect(finished).toBe(true);
  });
});
