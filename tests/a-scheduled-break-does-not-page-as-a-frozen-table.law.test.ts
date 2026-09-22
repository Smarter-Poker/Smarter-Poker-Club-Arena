/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A SCHEDULED BREAK DOES NOT PAGE AS A FROZEN TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md section 13 rule 6: "Fleet-level alert rules carry the break
 * guard ... or they page hourly about a stop we scheduled." PokerTablesFrozen
 * in infra/monitoring/engine-freeze-rules.yml never carried it - the one rule
 * in that file's original "THE ONE THAT MATTERS" comment that predates every
 * later rule's guard.
 *
 * Measured against production operational_alert_events (Supabase project
 * kuklfnapbkmacvwxktbh), 2026-09-13 through 2026-09-22: 351 PokerTablesFrozen
 * deliveries, resolving near :53 at the full seated-table count (61 on
 * 2026-09-22) and re-firing near :03 on the thaw's residual lag (3) - once an
 * hour, on the announced :55 break's own clock. poker_stalled_tables counts
 * every table with 2+ dealable seats making no progress for 2 minutes, and
 * the break deliberately parks the whole fleet for up to ~5 minutes every
 * hour - so the fleet crossing its own threshold together is the SCHEDULED
 * STOP, not a freeze bug. This is exactly the failure mode section 13 rule 6
 * names, and every sibling rule in this same file already carries the guard
 * (EngineScrapeDown, EngineLivenessDead, EngineHandsStopped,
 * EngineFleetThroughputCollapsed, PokerSettlementBlocked).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceYamlEntry, sliceBetween } from './helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '..');
const RULES = fs.readFileSync(
  path.join(ROOT, 'infra/monitoring/engine-freeze-rules.yml'),
  'utf8'
);

describe('PokerTablesFrozen is guarded against the announced maintenance break', () => {
  it('carries the section 13 rule 6 break guard in its expr', () => {
    const entry = sliceYamlEntry(RULES, 'alert: PokerTablesFrozen');
    const guard = sliceBetween(entry, 'expr:', 'for:');
    expect(guard, 'PokerTablesFrozen has no break guard').toContain(
      'max_over_time(poker_maintenance_break_active[6m]) == 1'
    );
  });

  it('the guard suppresses the announced break - it does not delete the underlying signal', () => {
    const entry = sliceYamlEntry(RULES, 'alert: PokerTablesFrozen');
    expect(entry).toContain('poker_stalled_tables > 0');
    expect(entry).toContain('for: 1m');
    expect(entry).toContain('severity: critical');
  });
});
