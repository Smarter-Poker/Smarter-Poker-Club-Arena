/**
 * The 5-dollar Sunrise and Midnight Bounty must be spawnable (2026-10-22).
 *
 * The engine writes them at 5.00 + 0.50 (owner exception, 2026-10-20,
 * midwayStructurePolicy.ts). The database's whole-dollar trigger refused that
 * split for two days, so neither event spawned while 244 refusals an hour
 * went unread. This pins the two sides to the same exception: the names, the
 * split and the Midway scope the engine uses must all appear in the newest
 * migration that defines fn_enforce_whole_dollar_buyin.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

function newestTriggerDefinition(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      /FUNCTION\s+public\.fn_enforce_whole_dollar_buyin\s*\(/i.test(
        readFileSync(join(MIGRATIONS, f), 'utf8')
      )
    );
  const file = files[files.length - 1];
  return { file, sql: readFileSync(join(MIGRATIONS, file), 'utf8') };
}

describe('the small Midway bounties spawn', () => {
  const policy = readFileSync(
    join(ROOT, 'server', 'src', 'tournament', 'midwayStructurePolicy.ts'),
    'utf8'
  );

  it('the engine still applies the owner-approved 5 + 0.5 split to exactly these two events', () => {
    expect(policy).toMatch(/\['Sunrise Bounty \(NLH\)', 'Midnight Bounty \(NLH\)'\]/);
    expect(policy).toMatch(/smallBounty \? 5 :/);
    expect(policy).toMatch(/smallBounty \? 0\.5 :/);
  });

  it('the newest whole-dollar trigger admits that exact split for those events and nothing wider', () => {
    const { file, sql } = newestTriggerDefinition();
    expect(file, 'a migration defines the trigger').toBeTruthy();
    expect(sql).toMatch(/NEW\.buy_in_amount, 0\) = 5\.00/);
    expect(sql).toMatch(/NEW\.buy_in_fee, 0\) = 0\.50/);
    expect(sql).toMatch(/NEW\.name IN \('Sunrise Bounty \(NLH\)', 'Midnight Bounty \(NLH\)'\)/);
    expect(sql).toMatch(/fade0000-0000-0000-0000-000000000001/);
    expect(sql).toMatch(/NEW\.is_pko IS NOT TRUE/);
    expect(sql).toMatch(/NEW\.is_mystery_bounty IS NOT TRUE/);
    // Everything else is still refused.
    expect(sql).toMatch(/RAISE EXCEPTION\s+'whole-dollar buy-in rule/);
  });
});
