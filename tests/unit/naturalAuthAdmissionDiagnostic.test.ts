import { afterEach, expect, it, vi } from 'vitest';
import { installNaturalAuthAdmissionDiagnosticScript } from '../e2e/support/naturalAuthAdmissionDiagnostic';

const authLock = 'lock:smarter-poker-auth';
const diagnostic = () => (window as any).__naturalAuthAdmissionDiagnostic;
afterEach(() => {
  diagnostic()?.stop();
  delete (window as any).__naturalAuthAdmissionDiagnostic;
  vi.unstubAllGlobals();
});

function install(
  request: (...args: any[]) => any,
  query = vi.fn(async () => ({ held: [], pending: [] }))
) {
  const locks = { request, query };
  vi.stubGlobal('navigator', { locks });
  installNaturalAuthAdmissionDiagnosticScript();
  return locks;
}

it.each([false, true])(
  'preserves overload arguments, receivers and the original request promise (%s)',
  async (withOptions) => {
    const callbackReceiver = {};
    const lock = { name: authLock };
    const callback = vi.fn(function (this: unknown, received: unknown) {
      expect(this).toBe(callbackReceiver);
      expect(received).toBe(lock);
      return 'same-result';
    });
    let nativeResult!: Promise<string>;
    const original = vi.fn(function (this: unknown, ...args: any[]) {
      expect(this).toBe(locks);
      expect(args[0]).toBe(authLock);
      if (withOptions) expect(args[1]).toBe(options);
      nativeResult = Promise.resolve(Reflect.apply(args.at(-1), callbackReceiver, [lock]));
      return nativeResult;
    });
    const locks = install(original);
    const options = { mode: 'exclusive', signal: new AbortController().signal };
    const result = withOptions
      ? locks.request(authLock, options, callback)
      : locks.request(authLock, callback);
    expect(result).toBe(nativeResult);
    await expect(result).resolves.toBe('same-result');
    expect(callback).toHaveBeenCalledTimes(1);
    expect((await diagnostic().read()).events.map((event: any) => event.event)).toEqual([
      'requested',
      'acquired',
      'released',
    ]);
  }
);

it('preserves synchronous acquisition throws and never reports an acquired lock', async () => {
  const failure = new Error('secret-bearing error must not enter evidence');
  const locks = install(() => {
    throw failure;
  });
  expect(() => locks.request(authLock, () => {})).toThrow(failure);
  expect((await diagnostic().read()).events.map((event: any) => event.event)).toEqual([
    'requested',
    'rejected',
  ]);
  expect(JSON.stringify(await diagnostic().read())).not.toContain(failure.message);
});

it.each(['acquisition', 'callback', 'callback-sync'])(
  'preserves %s rejection and ends without a held diagnostic request',
  async (kind) => {
    const failure = new Error('original rejection');
    const locks = install((_name, callback) => {
      if (kind === 'acquisition') return Promise.reject(failure);
      return Promise.resolve().then(() => callback({ name: authLock }));
    });
    const promise = locks.request(authLock, () => {
      if (kind === 'callback-sync') throw failure;
      return Promise.reject(failure);
    });
    await expect(promise).rejects.toBe(failure);
    expect((await diagnostic().read()).events.map((event: any) => event.event)).toEqual(
      kind === 'acquisition'
        ? ['requested', 'rejected']
        : ['requested', 'acquired', 'released', 'rejected']
    );
  }
);

it('does not replace the callback promise or pretend a null lock was acquired', async () => {
  const callbackPromise = Promise.resolve('unchanged');
  const callback = vi.fn(() => callbackPromise);
  const locks = install((_name, wrappedCallback) => {
    const result = wrappedCallback(null);
    expect(result).toBe(callbackPromise);
    return result;
  });
  expect(locks.request(authLock, callback)).toBe(callbackPromise);
  await callbackPromise;
  expect(callback).toHaveBeenCalledWith(null);
  expect((await diagnostic().read()).events.map((event: any) => event.event)).toEqual([
    'requested',
  ]);
});

it('reports unavailable query state without exposing the query error', async () => {
  install(() => Promise.resolve(), vi.fn().mockRejectedValue(new Error('private-query-error')));
  const snapshot = await diagnostic().read();
  expect(snapshot.state).toBeNull();
  expect(snapshot.queryFailed).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('private-query-error');
});

it('passes unrelated locks untouched and sanitizes explicit query snapshots', async () => {
  const request = vi.fn(() => Promise.resolve('other'));
  const query = vi.fn(async () => ({
    held: [
      { name: authLock, mode: 'exclusive', clientId: 'private-client' },
      { name: 'other', mode: 'shared' },
    ],
    pending: [{ name: authLock, mode: 'exclusive', unexpected: 'private' }],
  }));
  const locks = install(request, query as any);
  const callback = () => {};
  const options = { arbitrary: 'not inspected' };
  await locks.request('other', options, callback);
  expect(request).toHaveBeenCalledWith('other', options, callback);
  expect(query).not.toHaveBeenCalled();
  const snapshot = await diagnostic().read();
  expect(snapshot.events).toEqual([]);
  expect(snapshot.state).toEqual({
    held: [{ name: authLock, mode: 'exclusive' }],
    pending: [{ name: authLock, mode: 'exclusive' }],
  });
  expect(JSON.stringify(snapshot)).not.toMatch(/private|unexpected|arbitrary/);
});

it('restores only its own wrapper and stops recording pending completions', async () => {
  let finish!: () => void;
  const original = (_name: string, callback: any) => {
    callback({ name: authLock });
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  const locks = install(original);
  const pending = locks.request(authLock, () => {});
  diagnostic().stop();
  expect(locks.request).toBe(original);
  finish();
  await pending;
  expect((await diagnostic().read()).events).toHaveLength(2);
  delete (window as any).__naturalAuthAdmissionDiagnostic;
  installNaturalAuthAdmissionDiagnosticScript();
  const otherWrapper = vi.fn();
  locks.request = otherWrapper;
  diagnostic().stop();
  expect(locks.request).toBe(otherWrapper);
});

it.each([undefined, {}])('leaves unavailable lock requests untouched (%s)', async (locks) => {
  vi.stubGlobal('navigator', { locks });
  installNaturalAuthAdmissionDiagnosticScript();
  expect((await diagnostic().read()).installed).toBe(false);
  expect((await diagnostic().read()).events).toEqual([]);
  expect(navigator.locks).toBe(locks);
});
