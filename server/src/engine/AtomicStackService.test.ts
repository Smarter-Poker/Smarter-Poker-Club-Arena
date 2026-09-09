import { describe, expect, it, vi } from 'vitest';
import { AtomicStackService } from './AtomicStackService.js';

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe('AtomicStackService finite-money boundary', () => {
  it.each(NON_FINITE)('throws before initializing a stack with %s', (stack) => {
    const service = new AtomicStackService();
    service.initializeStack('table', 'existing', 125);

    expect(() => service.initializeStack('table', 'existing', stack)).toThrow(/must be finite/);
    expect(() => service.initializeStack('table', 'new', stack)).toThrow(/must be finite/);
    expect(service.getStackWithVersion('table', 'existing')).toEqual({ stack: 125, version: 1 });
    expect(service.getTableStacks('table').has('new')).toBe(false);
  });

  it.each(NON_FINITE)('refuses a non-finite debit of %s without mutation', (amount) => {
    const service = new AtomicStackService();
    service.initializeStack('table', 'player', 125);

    expect(service.atomicDebit('table', 'player', amount, 1)).toMatchObject({
      success: false,
      error: 'Debit amount must be finite',
    });
    expect(service.getStackWithVersion('table', 'player')).toEqual({ stack: 125, version: 1 });
  });

  it.each(NON_FINITE)('refuses a non-finite credit of %s without mutation', (amount) => {
    const service = new AtomicStackService();
    service.initializeStack('table', 'existing', 125);

    expect(service.atomicCredit('table', 'existing', amount)).toMatchObject({
      success: false,
      error: 'Credit amount must be finite',
    });
    expect(service.atomicCredit('table', 'new', amount)).toMatchObject({
      success: false,
      error: 'Credit amount must be finite',
    });
    expect(service.getStackWithVersion('table', 'existing')).toEqual({ stack: 125, version: 1 });
    expect(service.getTableStacks('table').has('new')).toBe(false);
  });

  it.each(NON_FINITE)('refuses the whole batch when one delta is %s', (delta) => {
    const onEvent = vi.fn();
    const service = new AtomicStackService(onEvent);
    service.initializeStack('table', 'one', 125);
    service.initializeStack('table', 'two', 125);

    const result = service.atomicSettle('table', [
      { userId: 'one', delta: -25 },
      { userId: 'two', delta },
    ]);

    expect(result.success).toBe(false);
    expect(result.settled.size).toBe(0);
    expect(result.errors).toContain('Settlement delta must be finite for two');
    expect(service.getStackWithVersion('table', 'one')).toEqual({ stack: 125, version: 1 });
    expect(service.getStackWithVersion('table', 'two')).toEqual({ stack: 125, version: 1 });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('refuses a finite credit or batch that would overflow to Infinity', () => {
    const service = new AtomicStackService();
    // MAX_VALUE itself cannot cross the cent-rounding boundary. A smaller
    // finite baseline can, but adding MAX_VALUE still overflows.
    expect(() => service.initializeStack('table', 'too-large', Number.MAX_VALUE)).toThrow(
      /overflowed the finite cent boundary/
    );
    service.initializeStack('table', 'player', Number.MAX_VALUE / 1000);
    const before = service.getStackWithVersion('table', 'player');

    expect(service.atomicCredit('table', 'player', Number.MAX_VALUE)).toMatchObject({
      success: false,
      error: "Credit would make player's stack non-finite",
    });
    expect(
      service.atomicSettle('table', [{ userId: 'player', delta: Number.MAX_VALUE }])
    ).toMatchObject({
      success: false,
      errors: ["Settlement would make player's stack non-finite"],
    });
    expect(service.getStackWithVersion('table', 'player')).toEqual(before);
    expect(service.getTableStacks('table').has('too-large')).toBe(false);
  });

  it('keeps valid debit, credit, and batch behavior intact', () => {
    const service = new AtomicStackService();
    service.initializeStack('table', 'one', 125);
    service.initializeStack('table', 'two', 75);

    expect(service.atomicDebit('table', 'one', 25, 1)).toMatchObject({
      success: true,
      newStack: 100,
      newVersion: 2,
    });
    expect(service.atomicCredit('table', 'two', 25)).toMatchObject({
      success: true,
      newStack: 100,
      newVersion: 2,
    });
    expect(
      service.atomicSettle('table', [
        { userId: 'one', delta: -10 },
        { userId: 'two', delta: 10 },
      ])
    ).toMatchObject({ success: true, errors: [] });
    expect(service.getStackWithVersion('table', 'one')).toEqual({ stack: 90, version: 3 });
    expect(service.getStackWithVersion('table', 'two')).toEqual({ stack: 110, version: 3 });
  });
});
