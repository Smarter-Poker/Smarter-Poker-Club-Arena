import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Club Create Certification run 37064989099 reported "Atomic Create Failed:
 * 55006 PLATFORM_FROZEN". Nothing was wrong with club creation: the 21:05:05Z
 * certified recovery break (CLAUDE.md section 13) was still enforced, and
 * fn_create_club_atomic writes chip_transactions, so zz_freeze_guard was right
 * to refuse it. The check folded a stop we scheduled into "the door is broken",
 * which is CLAUDE.md 10.86 rule 1.
 *
 * Every fixture create now goes through one helper that waits on the freeze's
 * own end condition with the budget read from engine_maintenance_break, and that
 * keeps thawed, exhausted and unreadable apart.
 */
const source = readFileSync(resolve(__dirname, '../../scripts/ci/certify-club-create.mjs'), 'utf8');

describe('club create certification waits out the platform freeze', () => {
  it('reads the freeze from the shared window helper, not from a tick count', () => {
    expect(source).toContain("from './platform-freeze-window.mjs'");
    expect(source).toContain('awaitPlatformThaw');
    expect(source).toContain('freezeBudgetMs');
    expect(source).toContain('describeThaw');
    expect(source).toContain("admin.rpc('fn_platform_frozen')");
    expect(source).toContain("from('engine_maintenance_break')");
    expect(source).not.toMatch(/for\s*\(\s*let\s+attempt[^)]*37/);
  });

  it('routes every fixture create through the one freeze-aware door', () => {
    const calls = source.match(/rpc\('fn_create_club_atomic'/g) || [];
    expect(calls).toHaveLength(1);
    expect(source).toContain('async function createClubThroughTheFreeze(player, label, args)');
    expect(source).toContain("createClubThroughTheFreeze(player, 'Atomic Create Failed'");
    expect(source).toContain("createClubThroughTheFreeze(player, 'Preset Create Failed'");
  });

  it('tells a scheduled freeze apart from a refusal and from not knowing', () => {
    expect(source).toContain("String(error.code || '') === '55006'");
    expect(source).toContain('/PLATFORM_FROZEN/');
    // A freeze it could not read out is never reported as a thaw.
    expect(source).toContain("if (thaw.outcome !== 'thawed')");
    expect(source).toContain('the create was refused for the freeze;');
    // Bounded by the freezes one run can legitimately meet, not by a timer.
    expect(source).toContain('const PLATFORM_FREEZE_MAX_WAITS = 2;');
    expect(source).toContain('more than section 13 schedules');
  });
});
