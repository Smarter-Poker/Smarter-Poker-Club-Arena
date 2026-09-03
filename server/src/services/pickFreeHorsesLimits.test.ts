/**
 * The horse pool read as exhausted while a third of it sat idle (2026-08-23).
 *
 * pickFreeHorses fetched `.limit(400)` from a pool of 584 horses, so the last
 * 184 could never be selected by that path — while 24 spins and 12 heads-up
 * games sat 2-8 hours past their start waiting for a seat. Its sibling
 * registerHorses had always sized the fetch as `count + busy.size`; this one
 * had drifted off that convention.
 *
 * These read the source rather than the runtime because the function is a
 * thin wrapper over three supabase calls: what is worth pinning is the SHAPE
 * of the query, which is exactly what regressed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'TournamentRecurringService.ts'), 'utf8');

function pickFreeHorsesBody(): string {
  const start = SRC.indexOf('private async pickFreeHorses(');
  expect(start, 'pickFreeHorses must still exist').toBeGreaterThan(-1);
  const next = SRC.indexOf('private async ', start + 10);
  return SRC.slice(start, next > -1 ? next : SRC.length);
}

describe('pickFreeHorses - the fleet must not read as exhausted while idle', () => {
  it('never caps the horse fetch at a fixed number below the fleet size', () => {
    const body = pickFreeHorsesBody();
    // Only the PROFILES fetch is the fleet read. The busy-set reads carry a
    // deliberately huge ceiling (a truncated busy set marks busy horses free).
    const profilesFetch = body.slice(body.indexOf(".from('profiles')"));
    const bareLimit = profilesFetch.match(/\.limit\(\s*(\d+)\s*\)/);
    expect(
      bareLimit,
      `the fleet read must size itself from the busy set, not a constant ` +
        `(found .limit(${bareLimit?.[1]}) - the fleet is already larger than that)`
    ).toBeNull();
  });

  it('reads the WHOLE fleet, keyset-paged, rather than any sized page', () => {
    // V23 (2026-08-30): every sized fetch here — `.limit(400)`, then
    // `count + busy.size`, then `count*4 + busy.size + 50` — was still a
    // PAGE, and an unordered page is a STABLE page: Postgres served the same
    // physical rows to every caller all day, the busy set drained them, and
    // the filtered candidates shrank to zero while two-thirds of the fleet
    // idled beyond the page (SNG board dead from 17:31 UTC on 2026-08-30).
    // The pinned shape is now fetchAllRows with an ORDER BY id keyset — the
    // whole fleet, then filter and shuffle in memory.
    const body = pickFreeHorsesBody();
    expect(body).toMatch(/fetchAllRows/);
    expect(body).toMatch(/\.order\('id'/);
    expect(body, 'an incomplete fleet read must fail closed').toMatch(/fleetPage\.complete/);
  });

  it('registerHorses (the sibling) also reads the whole fleet, paged', () => {
    const start = SRC.indexOf('private async registerHorses(');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('fn_register_horse_for_tournament', start));
    expect(body).toMatch(/fetchAllRows/);
    expect(body, 'an incomplete fleet read must fail closed').toMatch(/poolPage\.complete/);
  });

  it('shuffles candidates so concurrent callers do not claim the same horses', () => {
    // The recurring service, the scheduler and GameServer's past-start top-up
    // all call this; an unshuffled list hands each of them the same head.
    expect(pickFreeHorsesBody()).toMatch(/nodeCrypto\.randomInt/);
  });
});
