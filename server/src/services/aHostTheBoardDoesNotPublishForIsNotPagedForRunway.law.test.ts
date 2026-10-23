/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: A HOST THE BOARD DOES NOT PUBLISH FOR IS NOT PAGED FOR RUNWAY
 * (2026-10-12)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * StableHandExecutor.checkBanks measured every host's bank in days of the Free
 * Buy board's daily guarantee (2,000 under the owner October 22 schedule). Deep Stack Society has been held off that board
 * since 2026-10-04 (FREE_BUY_HELD_HOSTS, every schedule inactive, no open
 * event). On 2026-10-12 its bank moved to the Midway Union bank ahead of the
 * join Dan decided on 2026-10-11, the runway read 0.0 days, and a critical
 * alert (9a65d5ae) told an operator to refill a bank that funds nothing.
 *
 * This law pins the cause:
 *
 *   1. only a host the board publishes for owes the board's daily guarantee;
 *      a held host and an unknown host owe none;
 *   2. a bank that owes nothing is never critical, however empty;
 *   3. a host the board does publish for is still paged on an empty bank;
 *   4. checkBanks reads the guarantee per host, never the flat per-host number.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  dailyGuaranteeForHost,
  dailyGuaranteePerHost,
  FREE_BUY_HOSTS,
  FREE_BUY_HELD_HOSTS,
} from './FreeBuy.js';
import { bankVerdict } from './StableHandBeats.js';
import { DSS_CLUB_ID, MIDWAY_UNION_ID } from './StableHand.js';

describe('LAW: a host the board does not publish for is not paged for runway', () => {
  it('only a published host owes the board guarantee', () => {
    expect(dailyGuaranteePerHost()).toBe(2000);
    expect(dailyGuaranteeForHost(MIDWAY_UNION_ID)).toBe(2000);
    for (const h of FREE_BUY_HOSTS) expect(dailyGuaranteeForHost(h.hostId)).toBe(2000);
    expect(dailyGuaranteeForHost(DSS_CLUB_ID)).toBe(0);
    for (const h of FREE_BUY_HELD_HOSTS) expect(dailyGuaranteeForHost(h.hostId)).toBe(0);
    expect(dailyGuaranteeForHost('00000000-0000-0000-0000-00000000beef')).toBe(0);
  });

  it('an empty bank that owes nothing is never critical', () => {
    expect(bankVerdict({ bank: 0, dailyGuarantee: dailyGuaranteeForHost(DSS_CLUB_ID) })).toBe('ok');
  });

  it('a published host is still paged on an empty bank', () => {
    expect(bankVerdict({ bank: 0, dailyGuarantee: dailyGuaranteeForHost(MIDWAY_UNION_ID) })).toBe(
      'critical'
    );
  });

  it('checkBanks reads the guarantee per host', () => {
    const src = readFileSync(resolve(__dirname, 'StableHandExecutor.ts'), 'utf8');
    const start = src.indexOf('private async checkBanks(');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('/** Both table-flag passes', start));
    expect(body).toContain('dailyGuaranteeForHost(host.hostId)');
    expect(body).not.toContain('dailyGuaranteePerHost()');
  });
});
