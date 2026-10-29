import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readRabbitReceipt, withRabbitReceipt } from '../../src/services/rabbitHuntReceipts';
const result = {
  success: true,
  cards: [{ rank: 'A', suit: 's' }],
  diamonds_spent: 5,
  vip_remaining: 0,
};
beforeEach(async () => {
  await readRabbitReceipt(null, 'table', 1);
});
describe('private Rabbit Hunt receipt recovery', () => {
  it('joins the exact pending purchase from a reopened surface and never calls billing twice', async () => {
    let finish!: (v: typeof result) => void;
    const work = new Promise<typeof result>((resolve) => {
      finish = resolve;
    });
    const bill = vi.fn(() => work);
    const original = withRabbitReceipt('login-a', 'table', 1, bill);
    const reopened = withRabbitReceipt('login-a', 'table', 1, bill);
    const restore = readRabbitReceipt('login-a', 'table', 1);
    expect(bill).toHaveBeenCalledTimes(1);
    finish(result);
    expect(await original).toMatchObject({ diamonds_spent: 5 });
    expect(await reopened).toMatchObject({ source: 'already_revealed', diamonds_spent: 0 });
    expect(await restore).toMatchObject({ source: 'already_revealed', diamonds_spent: 0 });
    expect(await readRabbitReceipt('login-a', 'table', 1)).not.toHaveProperty('vip_remaining');
  });
  it('does not reuse another table or hand and does not cache refusals', async () => {
    const bill = vi.fn().mockResolvedValue(result);
    await withRabbitReceipt('a', 'one', 1, bill);
    expect(await readRabbitReceipt('a', 'two', 1)).toBeNull();
    expect(await readRabbitReceipt('a', 'one', 2)).toBeNull();
    await withRabbitReceipt('a', 'one', 2, async () => ({ success: false, retryable: true }));
    await withRabbitReceipt('a', 'one', 2, bill);
    expect(bill).toHaveBeenCalledTimes(2);
  });
  it('purges on a new login and rejects an old pending receipt after replacement', async () => {
    let finish!: (v: typeof result) => void;
    const original = withRabbitReceipt(
      'a',
      'one',
      1,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const restoring = readRabbitReceipt('a', 'one', 1);
    expect(await readRabbitReceipt('b', 'one', 1)).toBeNull();
    finish(result);
    await original;
    expect(await restoring).toBeNull();
    expect(await readRabbitReceipt('a', 'one', 1)).toBeNull();
  });
  it('copies private cards so a consumer cannot change a later replay', async () => {
    await withRabbitReceipt('a', 'one', 1, async () => result);
    const first = await readRabbitReceipt('a', 'one', 1);
    first!.cards![0].rank = 'K';
    expect((await readRabbitReceipt('a', 'one', 1))!.cards![0].rank).toBe('A');
  });
  it('bounds retained receipts to the most recent hundred exact hands', async () => {
    for (let hand = 1; hand <= 101; hand++)
      await withRabbitReceipt('a', 'one', hand, async () => result);
    expect(await readRabbitReceipt('a', 'one', 1)).toBeNull();
    expect(await readRabbitReceipt('a', 'one', 101)).toMatchObject({ success: true });
  });
});
