import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  TRANSIENT_RETRY_DELAYS_MS,
  isTransientFailure,
  retryTransient,
} from '../../scripts/ci/transient-retry.mjs';

const SLOW = { code: '57014', message: 'canceling statement due to statement timeout' };

describe('which failures mean the database was only slow', () => {
  it.each([
    [SLOW],
    [{ code: '55P03', message: 'could not obtain lock on row' }],
    [{ code: '40001', message: 'could not serialize access' }],
    [{ code: '40P01', message: 'deadlock detected' }],
    [{ code: 'PGRST002', message: 'Could not query the database for the schema cache' }],
    [{ status: 503, message: 'upstream unavailable' }],
    [{ status: 504, message: 'gateway timeout' }],
    [{ status: 429, message: 'rate limited' }],
    [new TypeError('fetch failed')],
    [Object.assign(new Error('boom'), { status: 500, body: { code: '57014' } })],
    [{ message: 'canceling statement due to statement timeout' }],
  ])('retries %j', (failure) => {
    expect(isTransientFailure(failure)).toBe(true);
  });

  it.each([
    [undefined],
    [null],
    [{ code: '55000', message: 'CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY' }],
    [Object.assign(new Error('refused'), { status: 500, code: '55000' })],
    [{ code: '42501', message: 'service_role_only' }],
    [{ status: 500, message: 'internal server error' }],
    [{ status: 400, message: 'bad request' }],
    [{ status: 403, message: 'forbidden' }],
    // An application SQLSTATE outranks timeout-shaped words in its own text.
    [{ code: '55000', message: 'refused: statement timeout was not the cause' }],
    [{ code: 'P0001', message: 'this club has played' }],
  ])('never retries %j', (failure) => {
    expect(isTransientFailure(failure)).toBe(false);
  });
});

describe('retryTransient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('backs off through the documented ladder and returns the first good answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const wait = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const result = await retryTransient(
      async () => {
        calls += 1;
        return calls < 4 ? { data: null, error: SLOW } : { data: { success: true }, error: null };
      },
      { failureOf: (r) => r.error, wait }
    );
    expect(result).toEqual({ data: { success: true }, error: null });
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual(TRANSIENT_RETRY_DELAYS_MS.slice(0, 3));
  });

  it('is bounded: returns the last transient supabase-js result after every attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const wait = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn(async () => ({ data: null, error: SLOW }));
    const result = await retryTransient(operation, { failureOf: (r) => r.error, wait });
    expect(operation).toHaveBeenCalledTimes(TRANSIENT_RETRY_DELAYS_MS.length + 1);
    expect(result.error).toBe(SLOW);
  });

  it('throws the last transient error when the operation throws every time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const operation = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(retryTransient(operation, { wait: async () => undefined })).rejects.toThrow(
      'fetch failed'
    );
    expect(operation).toHaveBeenCalledTimes(TRANSIENT_RETRY_DELAYS_MS.length + 1);
  });

  it('does not retry a definitive result or a definitive error', async () => {
    const wait = vi.fn();
    const refusal = vi.fn(async () => ({
      data: { success: false, error: 'has played' },
      error: null,
    }));
    await expect(retryTransient(refusal, { failureOf: (r) => r.error, wait })).resolves.toEqual({
      data: { success: false, error: 'has played' },
      error: null,
    });
    expect(refusal).toHaveBeenCalledTimes(1);

    const denied = vi.fn(async () => ({ data: null, error: { code: '42501', message: 'nope' } }));
    await retryTransient(denied, { failureOf: (r) => r.error, wait });
    expect(denied).toHaveBeenCalledTimes(1);

    const thrown = vi.fn(async () => {
      throw Object.assign(new Error('refused'), { status: 500, code: '55000' });
    });
    await expect(retryTransient(thrown, { wait })).rejects.toThrow('refused');
    expect(thrown).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('keeps the total wait short enough for a 30 minute certification job', () => {
    expect(TRANSIENT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
  });
});

describe('certify-club-create routes its retirement through the guarded database helper', () => {
  const source = readFileSync(
    resolve(__dirname, '../../scripts/ci/certify-club-create.mjs'),
    'utf8'
  );

  it('retires residual fixtures through the sanctioned helper with the direct database budget', () => {
    expect(source).toContain('retireCertificationClubWithRetry({');
    expect(source).toContain('environment: process.env');
    expect(source).toContain("reason: 'cert-residue-recovery'");
    expect(source).not.toContain("admin.rpc('fn_ca_retire_welcome_certification_club'");
  });

  it('does not read an unreadable leak check as an empty one', () => {
    expect(source).toContain('leakedError');
    expect(source).toContain('could not verify its fixture clubs are gone');
  });
});
