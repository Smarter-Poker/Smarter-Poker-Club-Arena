import { describe, expect, it } from 'vitest';
import { supabaseServerHeaders } from '../../scripts/ci/supabase-auth-headers.mjs';

describe('supabaseServerHeaders', () => {
  it('does not mislabel a current Supabase secret key as a Bearer JWT', () => {
    expect(supabaseServerHeaders('sb_secret_current')).toEqual({
      apikey: 'sb_secret_current',
    });
  });

  it('keeps legacy service-role JWT support while legacy keys remain enabled', () => {
    expect(supabaseServerHeaders('legacy.jwt.key')).toEqual({
      apikey: 'legacy.jwt.key',
      Authorization: 'Bearer legacy.jwt.key',
    });
  });

  it('merges request-specific headers without weakening authentication', () => {
    expect(
      supabaseServerHeaders('sb_secret_current', { 'Content-Type': 'application/json' })
    ).toEqual({
      apikey: 'sb_secret_current',
      'Content-Type': 'application/json',
    });
  });

  it('rejects a missing server key', () => {
    expect(() => supabaseServerHeaders('')).toThrow('A Supabase server key is required');
  });
});
