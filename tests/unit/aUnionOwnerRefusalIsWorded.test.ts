/**
 * The union owner is a member of every club in the union (Dan, 2026-10-12;
 * migration 20261012112707). The database refuses a club that tries to remove,
 * ban, suspend or let go of the union owner, and a join while the union owner
 * is banned or suspended in the club, with a token. A club owner who taps
 * Remove, Ban or Leave must read why, not "Something Went Wrong".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVER_REFUSALS,
  isSafePlainMessage,
  safeErrorMessage,
  serverRefusalMessage,
} from '../../src/utils/safeErrorMessage';

// PostgREST's error object for a RAISE ... USING ERRCODE = 'check_violation', HINT = ...
const refusal = (token: string, sentence: string) => ({
  message: `${token}: ${sentence}`,
  code: '23514',
  details: null,
  hint: 'Take the club out of the union, or transfer the union, before this membership can end.',
});

describe('a union owner refusal is worded for the person who caused it', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('words each token as a plain Title Case line with no dollar sign or em dash', () => {
    for (const line of Object.values(SERVER_REFUSALS)) {
      expect(isSafePlainMessage(line), line).toBe(true);
      expect(line).not.toMatch(/[$—]/);
      for (const word of line.replace(/[.]/g, '').split(' '))
        expect(word[0], line).toMatch(/[A-Z]/);
    }
  });

  it('turns the guard refusal into its line, whatever wraps it', () => {
    const err = refusal(
      'UNION_OWNER_MEMBERSHIP_REQUIRED',
      'The Union Owner Must Stay A Member Of Every Club In The Union'
    );
    expect(serverRefusalMessage(err)).toBe(
      'The Union Owner Must Stay A Member Of Every Club In The Union.'
    );
    vi.stubEnv('DEV', false);
    expect(safeErrorMessage(err, 'Failed To Mark Member Departed')).toBe(
      'The Union Owner Must Stay A Member Of Every Club In The Union.'
    );
  });

  it('words a join refused for a banned or suspended union owner', () => {
    vi.stubEnv('DEV', false);
    expect(safeErrorMessage(refusal('UNION_OWNER_BANNED_IN_CLUB', 'x'))).toBe(
      SERVER_REFUSALS.UNION_OWNER_BANNED_IN_CLUB
    );
    expect(safeErrorMessage(new Error('UNION_OWNER_SUSPENDED_IN_CLUB: x'))).toBe(
      SERVER_REFUSALS.UNION_OWNER_SUSPENDED_IN_CLUB
    );
  });

  it('leaves every other error to the existing rules', () => {
    expect(serverRefusalMessage(new Error('Failed to fetch'))).toBeNull();
    expect(serverRefusalMessage(null)).toBeNull();
  });
});
