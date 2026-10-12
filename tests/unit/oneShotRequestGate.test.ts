import { describe, expect, it } from 'vitest';
import { OneShotRequestGate, runWithOneShotRequestGate } from '../e2e/support/oneShotRequestGate';

describe('one-shot customization request gate', () => {
  it('holds persistence through the immediate proof, releases it, and returns the response', async () => {
    const gate = new OneShotRequestGate();
    let resolvePersisted!: (value: string) => void;
    const persisted = new Promise<string>((resolve) => {
      resolvePersisted = resolve;
    });
    let held: Promise<boolean> | undefined;
    let immediateVerified = false;

    const result = runWithOneShotRequestGate({
      gate,
      persisted,
      timeoutMs: 100,
      action: async () => {
        held = gate.holdIfArmed({
          continue: async () => {
            expect(immediateVerified).toBe(true);
            resolvePersisted('persisted');
          },
        });
      },
      verifyImmediate: async () => {
        immediateVerified = true;
      },
    });

    await expect(result).resolves.toBe('persisted');
    await expect(held).resolves.toBe(true);
  });

  it('releases a held route and observes its response rejection when the immediate proof fails', async () => {
    const gate = new OneShotRequestGate();
    const primary = new Error('optimistic paint failed');
    let rejectPersisted!: (reason: Error) => void;
    const persisted = new Promise<string>((_resolve, reject) => {
      rejectPersisted = reject;
    });
    let held: Promise<boolean> | undefined;
    let continued = false;

    const result = runWithOneShotRequestGate({
      gate,
      persisted,
      timeoutMs: 100,
      action: async () => {
        held = gate.holdIfArmed({
          continue: async () => {
            continued = true;
            rejectPersisted(new Error('context closed after the primary failure'));
          },
        });
      },
      verifyImmediate: async () => {
        throw primary;
      },
    });

    await expect(result).rejects.toBe(primary);
    await expect(held).resolves.toBe(true);
    expect(continued).toBe(true);
    // A released gate can be reused; the failed proof did not strand it.
    expect(() => gate.arm()).not.toThrow();
    gate.release();
  });
});
