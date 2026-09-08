import { describe, expect, it } from 'vitest';
import { supabaseServerHeaders } from '../../scripts/ci/supabase-auth-headers.mjs';

describe('supabaseServerHeaders', () => {
  it('does not mislabel a current Supabase secret key as a Bearer JWT', () => {
    expect(supabaseServerHeaders('sb_secret_current')).toEqual({
      apikey: 'sb_secret_current',
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    });
  });

  it('keeps legacy service-role JWT support while legacy keys remain enabled', () => {
    expect(supabaseServerHeaders('legacy.jwt.key')).toEqual({
      apikey: 'legacy.jwt.key',
      Authorization: 'Bearer legacy.jwt.key',
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    });
  });

  it('merges request-specific headers without weakening authentication', () => {
    expect(
      supabaseServerHeaders('sb_secret_current', { 'Content-Type': 'application/json' })
    ).toEqual({
      apikey: 'sb_secret_current',
      'Content-Type': 'application/json',
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    });
  });

  it('does not let request extras replace service identity or add manager authority', () => {
    expect(
      supabaseServerHeaders('legacy.jwt.key', {
        apikey: 'attacker-key',
        authorization: 'Bearer attacker-key',
        'x-smarter-data-actor': 'tournament-manager',
        'x-smarter-data-protocol': '2',
        'x-smarter-tournament-id': '00000000-0000-0000-0000-000000000001',
        'x-smarter-tournament-lease-generation': '00000000-0000-0000-0000-000000000002',
      })
    ).toEqual({
      apikey: 'legacy.jwt.key',
      Authorization: 'Bearer legacy.jwt.key',
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    });
  });

  it('rejects a missing server key', () => {
    expect(() => supabaseServerHeaders('')).toThrow('A Supabase server key is required');
  });
});
