/**
 * A REPORTER DOES NOT BECOME THE BUG.
 * ═══════════════════════════════════════════════════════════════════════════
 * `reportError` is only ever called from a catch block. If it throws, it does
 * not add an error - it REPLACES one. The caller was handling a failure it
 * knew about; instead it gets an unrelated TypeError out of the machinery that
 * was supposed to be writing that failure down, and the real one is never
 * recorded anywhere.
 *
 * WHAT THIS COST, from horse_bug_reports on 2026-09-12. Two families of
 * unresolved rows, 5,592 between them, were one mechanism end to end:
 *
 *   1. `OfflineQueueService.getCount()` called `db.transaction()` inside a
 *      `new Promise` executor that took no `reject`. That call throws
 *      `InvalidStateError` - a DOMException - synchronously once the IndexedDB
 *      connection is closing, and a throw in an executor rejects the promise.
 *      OfflineQueueBadge polls it every 2000ms without a catch, so one closing
 *      connection produced an unhandled rejection every two seconds for as
 *      long as the tab stayed open.
 *
 *   2. main.tsx handed each rejection to `reportError`, which assigned to
 *      `message` while normalising it. `DOMException.prototype.message` is an
 *      accessor with NO SETTER, and modules are strict, so the assignment
 *      threw back out of the `unhandledrejection` listener - before
 *      `event.preventDefault()` and before `captureException`. The browser
 *      re-raised the reporter's own TypeError through `window.onerror`, and
 *      HorseBugReporter filed THAT as a second, critical bug.
 *
 * The arithmetic is the proof, not the theory. 2026-04-02, one 98-minute
 * session: 2,686 IndexedDB rejections and 2,686 `Uncaught Error: Uncaught
 * TypeError: Cannot set property message of  which has only a getter`.
 * 2026-08-29, one Safari session: 158 and 158, worded `Attempted to assign to
 * readonly property.` by the other engine. Exactly one secondary row per
 * rejection, at 30-32 rows a minute - the badge's 2000ms poll, counted. The
 * ~62 rejections in the table that are NOT DOMExceptions produced no secondary
 * row at all, because a plain Error's `message` is a writable own property and
 * the assignment worked.
 *
 * AND NOT ONE OF THE 2,844 REACHED THE ERROR LOG. The throw was on the line before
 * `captureException`, so the IndexedDB failure - the actual defect - was
 * visible only as the reporter's complaint about itself. That is the damage
 * this law exists to prevent: a reporter that throws is a reporter that hides.
 *
 * These tests are behavioural on purpose. The old spelling of every one of
 * them threw where this now asserts a value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { reportError } from '../src/utils/errorReporter';
import { OfflineQueueService } from '../src/services/OfflineQueueService';
import { uncaughtTitle } from '../src/services/HorseBugReporter';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IDB_CLOSING =
  "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.";

/**
 * A DOMException AS A BROWSER DEFINES IT — which is not what this suite gets.
 *
 * happy-dom gives DOMException a plain writable own `message`. Real engines,
 * and Node's own native DOMException, put `message` on the prototype as an
 * accessor with a getter and NO SETTER, and that missing setter IS the bug.
 * So a test built on the environment's stock DOMException asserts nothing:
 * checked against the exact 2026-03-30 source that produced the 2,686-row
 * burst (`err.message = ...`, bare, on the line before `captureException`),
 * it passed. The platform shape is therefore restored explicitly, and the
 * restoration is asserted, so this law cannot quietly go hollow again if the
 * DOM shim changes underneath it.
 */
function browserDOMException(message = IDB_CLOSING, name = 'InvalidStateError'): Error {
  const err = new DOMException(message, name);
  Object.defineProperty(err, 'message', {
    get: () => message,
    enumerable: false,
    configurable: true,
  });
  return err as unknown as Error;
}

/** The exact object the production rejections carried. */
const idbFailure = () => browserDOMException();

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
  OfflineQueueService.db = null;
});

describe('the error reporter never throws out of a catch block', () => {
  it('survives the DOMException whose message has no setter', () => {
    const err = idbFailure();
    // The precondition the whole incident rests on, asserted rather than
    // assumed: `message` reads, and refuses to be written.
    const descriptor = Object.getOwnPropertyDescriptor(err, 'message');
    expect(typeof descriptor?.get).toBe('function');
    expect(descriptor?.set).toBeUndefined();
    expect(() => {
      'use strict';
      (err as unknown as Record<string, unknown>).message = 'proof';
    }).toThrow(/only a getter|readonly|read only/i);

    expect(() => reportError(err, 'OfflineQueueBadge.check')).not.toThrow();
  });

  it('still reaches the local console with the DOMException - the 2,844 rows that did not', () => {
    reportError(idbFailure(), 'OfflineQueueBadge.check');

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect((consoleError.mock.calls[0][1] as Error).message).toBe(
      "[OfflineQueueBadge.check] Failed to execute 'transaction' on 'IDBDatabase': " +
        'The database connection is closing.'
    );
    // The reported copy keeps the original identity, so the the local console issue is
    // still the IndexedDB fault and not a generic Error.
    expect((consoleError.mock.calls[0][1] as Error).name).toBe('InvalidStateError');
  });

  it('leaves the caller’s error exactly as it found it', () => {
    const err = idbFailure();
    const before = err.message;

    reportError(err, 'CashGameCreateFlow.create_failed');

    // The cash create flow reports and then shows `err.message` to a host.
    // A context label must never end up in that sentence.
    expect(err.message).toBe(before);
    expect(err.message).not.toContain('CashGameCreateFlow');
  });

  it('does not re-raise the assignment inside its own [object Object] recovery', () => {
    // The guard that survived the 2026-09-09 fix: `try { err.message = ... }
    // catch { err.message = ... }` - a recovery path that repeated the exact
    // operation it was recovering from, so the second throw had nothing left
    // to catch it. Reproduced with an Error whose message is read-only AND
    // reads as '[object Object]', which is what put control in that branch.
    const hostile = new Error();
    Object.defineProperty(hostile, 'message', {
      get: () => '[object Object]',
      configurable: true,
    });

    expect(() => reportError(hostile, 'WalletService.lockForBuyIn')).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect((consoleError.mock.calls[0][1] as Error).message).toContain(
      '[WalletService.lockForBuyIn]'
    );
  });

  it.each([
    ['a Symbol', () => Symbol('nope')],
    [
      'a circular object',
      () => {
        const o: Record<string, unknown> = { code: 'X' };
        o.self = o;
        return o;
      },
    ],
    [
      'an object with a throwing message getter',
      () => ({
        get message(): string {
          throw new Error('this getter is hostile');
        },
      }),
    ],
    ['a null-prototype object', () => Object.create(null)],
    ['a frozen error', () => Object.freeze(new Error('frozen'))],
    ['undefined', () => undefined],
  ])('survives %s as the thing that was thrown', (_label, make) => {
    expect(() => reportError(make(), 'main.Unhandled_promise_rejection_caught')).not.toThrow();
  });
});

describe('the offline queue does not reject when the connection is closing', () => {
  it('getCount resolves 0 instead of rejecting - the flood, at its source', async () => {
    OfflineQueueService.db = {
      transaction() {
        throw idbFailure();
      },
    } as unknown as IDBDatabase;

    await expect(OfflineQueueService.getCount()).resolves.toBe(0);
  });

  it('every reader that says onerror-is-fine also survives the synchronous throw', async () => {
    OfflineQueueService.db = {
      transaction() {
        throw idbFailure();
      },
    } as unknown as IDBDatabase;

    // `onerror` already declared a failure here not worth a rejection. The
    // one failure that arrives by a different route must agree with it.
    await expect(OfflineQueueService.getAll()).resolves.toEqual([]);
    await expect(OfflineQueueService.remove('any-id')).resolves.toBeUndefined();
    await expect(OfflineQueueService.clearAll()).resolves.toBeUndefined();
  });
});

describe('the global handlers do not double-wrap or double-report', () => {
  it('does not say Uncaught twice', () => {
    // Chrome's window.onerror message, verbatim.
    expect(uncaughtTitle('Uncaught TypeError: Cannot set property message')).toBe(
      'Uncaught Error: TypeError: Cannot set property message'
    );
    expect(uncaughtTitle('Uncaught TypeError: x')).not.toContain('Uncaught Error: Uncaught');
  });

  it('gives one defect one title in both engines', () => {
    // WebKit sends the same event without the prefix. Our half of the string
    // must not be what makes the two rows differ - since #4398 the title is
    // the fingerprint, so a disagreement here is a permanent duplicate row.
    const chrome = uncaughtTitle('Uncaught TypeError: Attempted to assign to readonly property.');
    const webkit = uncaughtTitle('TypeError: Attempted to assign to readonly property.');
    expect(chrome).toBe(webkit);
  });

  it('marks the rejection handled before it does anything that could fail', () => {
    // Importing main.tsx boots the application, so this one reads the source.
    // The ORDER is the assertion: `preventDefault()` ran second for eighteen
    // months, so every reporter throw also became an uncaught browser error.
    const main = readFileSync(join(__dirname, '..', 'src', 'main.tsx'), 'utf8');
    const handler = main.slice(main.indexOf("addEventListener('unhandledrejection'"));
    const body = handler.slice(0, handler.indexOf('});'));
    expect(body).toContain('event.preventDefault()');
    expect(body.indexOf('event.preventDefault()')).toBeLessThan(body.indexOf('reportError('));
  });
});
