import { describe, expect, it } from 'vitest';
import { cashierStatementRouteMatches } from '../e2e/support/cashierStatementRouteObservation';
const club = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const target = new URL(`https://smarter.poker/hub/club-arena/clubs/${club}/cashier/statements`);
const check = (path: string, rpc: unknown = club, origin = target.origin) =>
  cashierStatementRouteMatches(new URL(path, origin), target, club, rpc);
describe('statement route and native club identity', () => {
  it('accepts the original UUID route and its native request', () =>
    expect(check(target.pathname)).toBe(true));
  it('accepts a canonical slug only with the same native club request', () =>
    expect(check('/hub/club-arena/clubs/shark-club/cashier/statements')).toBe(true));
  it('rejects a different native club behind a valid canonical route', () =>
    expect(check('/hub/club-arena/clubs/shark-club/cashier/statements', 'other-club')).toBe(false));
  it('rejects a missing native club identity', () =>
    expect(check(target.pathname, null)).toBe(false));
  it('rejects another UUID even if a request for the expected club was observed', () =>
    expect(
      check('/hub/club-arena/clubs/11111111-1111-4111-8111-111111111111/cashier/statements')
    ).toBe(false));
  it('rejects another origin', () =>
    expect(check(target.pathname, club, 'https://other.example')).toBe(false));
  it('rejects auth, a different console and a nested suffix', () => {
    for (const path of [
      '/hub/club-arena/auth',
      target.pathname.replace('/statements', ''),
      `${target.pathname}/other`,
    ])
      expect(check(path)).toBe(false);
  });
});
