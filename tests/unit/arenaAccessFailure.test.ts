import { describe, expect, it } from 'vitest';
import { arenaAccessFailure } from '../../src/services/arenaAccessFailure';
describe('Arena access errors preserve what is actually known', () => {
  it.each(['28000', '28P01', 'PGRST301', 'PGRST302', 'PGRST303'])(
    'recognizes rejected auth %s',
    (code) => {
      expect(arenaAccessFailure({ code })).toBe('authentication');
    }
  );
  it('distinguishes a database deadline and the browser read deadline from a connection failure', () => {
    expect(arenaAccessFailure({ code: '57014' })).toBe('timeout');
    expect(arenaAccessFailure(new Error('Arena Access Read Timed Out'))).toBe('timeout');
    expect(arenaAccessFailure(new TypeError('Failed to fetch'))).toBe('connection');
  });
  it('does not turn arbitrary failures or permission refusal into account reassurance', () => {
    for (const error of [undefined, null, new Error('broken'), { code: '42501' }])
      expect(arenaAccessFailure(error)).toBe('service');
  });
});

it('recognizes the real PostgREST-wrapped browser abort without relaxing server refusals', () => {
  expect(arenaAccessFailure(new Error('AbortError: signal is aborted without reason'))).toBe(
    'timeout'
  );
  expect(arenaAccessFailure({ message: 'AbortError: The operation was aborted.', code: '' })).toBe(
    'timeout'
  );
  expect(arenaAccessFailure({ message: 'AbortError: refused', code: '42501' })).toBe('service');
});
