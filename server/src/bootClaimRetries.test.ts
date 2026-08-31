/**
 * THE BOOT CLAIM MUST RETRY, OR THE ENGINE CANNOT RECOVER FROM A SLOW DATABASE.
 *
 * The loop this guards, observed in production on 2026-08-30 across five
 * containers in a row while Supabase was RESIZING:
 *
 *   1. boot asks for leadership once; the claim times out, or loses to the
 *      fresh lease this process's own DEAD predecessor wrote seconds before
 *      exiting;
 *   2. the process therefore boots as a STANDBY, which by contract claims
 *      nothing, cleans nothing and hydrates nothing — and never starts a
 *      discovery loop or a fleet;
 *   3. a staleness window later it is promoted, and because a standby cannot
 *      become a working leader in place it EXITS to be restarted as a real one;
 *   4. the successor's boot claim meets the lease ITS predecessor just wrote,
 *      and step 1 begins again.
 *
 * One container restart per staleness window, dealing nothing, for as long as
 * the database is unwell. The fleet was dark for over forty minutes and had to
 * be recovered by clearing the lease by hand three separate times.
 *
 * The retry is what breaks it, and it works for a reason worth stating: while
 * the boot claim is still being retried, markBootedAsStandby() has NOT been
 * called yet, so restartIntoLeaderBoot() returns early and a promotion during
 * this window produces a REAL leader instead of an exit.
 *
 * These are source guards because the alternative is booting a GameServer
 * against a real database and killing it on a timer.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceEnclosingBlock } from './testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
/** Strip comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const GAMESERVER = code(read('src/GameServer.ts'));

describe('start() retries the boot claim before accepting standby', () => {
  it('does not settle for the first answer', () => {
    // A single await renewLeadership() deciding leader-or-standby is the bug.
    expect(GAMESERVER).toMatch(/while \(role === 'standby' && Date\.now\(\) < bootClaimDeadline\)/);
  });

  it('retries for at least a full staleness window', () => {
    // The predecessor's lease has to be allowed to go stale, or the successor
    // loses the same race forever. Anything shorter reopens the loop.
    expect(GAMESERVER).toMatch(
      /bootClaimDeadline = Date\.now\(\) \+ \(LEADERSHIP_STALE_SECONDS \+ \d+\) \* 1000/
    );
  });

  it('re-asks inside the loop rather than spinning on a stale answer', () => {
    const window = sliceEnclosingBlock(GAMESERVER, 'bootClaimDeadline');
    expect(window).toMatch(/await new Promise\(\(r\) => setTimeout\(r, \d+\)\)/);
    expect(window).toMatch(/role = await renewLeadership\(\)/);
  });

  it('only takes the standby early-return after the retries are exhausted', () => {
    // Order is the whole fix: the standby branch — and the
    // markBootedAsStandby() that arms the exit path — must come AFTER the
    // retry loop, otherwise the process is committed to exiting before it has
    // finished asking.
    const retry = GAMESERVER.indexOf('bootClaimDeadline');
    const standbyReturn = GAMESERVER.indexOf("if (role === 'standby') {", retry + 1);
    expect(retry).toBeGreaterThan(-1);
    expect(standbyReturn).toBeGreaterThan(retry);
  });

  it('still resolves leadership before it mutates any shared state', () => {
    // cleanupStaleData cashes out seats and resets table counts. A standby
    // must never reach it — the 2026-08-23 incident.
    const decide = GAMESERVER.indexOf('await renewLeadership()');
    const cleanup = GAMESERVER.indexOf('await this.cleanupStaleData(');
    expect(decide).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(cleanup);
  });
});
