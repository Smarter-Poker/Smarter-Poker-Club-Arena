/**
 * A SUBJECT KEY REACHES THE DEDUPE DOOR (2026-09-25, binding)
 *
 * `fn_raise_server_financial_alert` has always taken `p_dedupe_key` and
 * `p_entity_id`, and implements "ONE OPEN ALERT PER THING THAT IS WRONG. Not
 * per pass over it." For as long as it existed, the server wrapper in
 * `financialAlerts.ts` passed neither, so every call site that went through the
 * wrapper could not reach the guard. The only flood control left was the RPC's
 * 60-per-minute RATE limit, which a refusal retried on a ~30-minute backoff
 * never trips.
 *
 * What that cost, measured on production 2026-09-25:
 *   - Tournament.atomic_finish_refused .............. 15,426 unresolved criticals
 *     across 1,003 tournaments, every one of which had COMPLETED and paid its
 *     pool in full (91,009.20, paid == pool to the penny).
 *   - postHandTasks.hand_history_failed ............. 2,395
 *   - ServerTableEngine.authoritative_hand_semantic_refusal ... 2,084
 *     (1,837 of those were the SAME hand as a row in the line above)
 *   - the five sites that bypass the wrapper and call the RPC directly with
 *     `p_entity_id` - StableHandExecutor.checkBanks,
 *     HorseFleet.stableHandHeartbeat and friends ..... ONE row each.
 *
 * Same estate, same day. The only difference was whether the subject key
 * reached the door. 22,244 unresolved money alerts is not 22,244 problems, and
 * an operator who cannot see that stops reading the table - which is what
 * CLAUDE.md 10.11 and 10.12 are about.
 *
 * This law pins the wrapper's forwarding and the three highest-volume call
 * sites. If you add a call site that can fire more than once for one subject,
 * give it a key.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const SRC = join(__dirname, '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

const ALERTS = read('services/financialAlerts.ts');
const MANAGER = read('tournament/TournamentManagerBase.ts');
const SETTLEMENT = read('engine/ServerTableEngineSettlement.ts');

describe('a subject key reaches the dedupe door', () => {
  it('the wrapper accepts a dedupe key and an entity id', () => {
    expect(ALERTS).toMatch(/dedupeKey\?: string \| null/);
    expect(ALERTS).toMatch(/entityId\?: string \| null/);
  });

  it('the wrapper FORWARDS both to the RPC that implements the guard', () => {
    // The whole defect was that these two lines did not exist.
    expect(ALERTS).toMatch(/p_dedupe_key:\s*dedupeKey\s*\?\?\s*null/);
    expect(ALERTS).toMatch(/p_entity_id:\s*entityId\s*\?\?\s*null/);
  });

  it('a finish refusal is keyed by tournament AND reason, not by the attempt', () => {
    // Bounded by the METHOD, not by a byte count. A fixed window is how a pin
    // starts failing for prose: the sibling law in
    // aRuleRefusalStopsAskingEveryFiveSeconds pinned this same helper with a
    // +700 slice that was already shorter than the comment explaining it.
    const body = sliceMethod(MANAGER, 'protected async alertFinishRefusalOnce(');
    // The key must name the subject and the reason together: a different
    // refusal still earns its own alert, the same one stops repeating.
    expect(body).toMatch(/\$\{String\(subject\)\}:\$\{reasonForKey \?\? 'unknown'\}/);
    expect(body).toContain('const subject = context.tournament_id ?? this.tournamentId');
  });

  it('a finish refusal records WHAT was refused', () => {
    // 14,388 of the 15,426 rows carried no error and no error_name at all,
    // while asserting proven_refusal: true. CLAUDE.md 10.86 rule 1.
    const body = sliceMethod(MANAGER, 'protected async alertFinishRefusalOnce(');
    expect(body).toMatch(/refusal_reason: reasonForKey/);
  });

  it('both hand-level money alerts are keyed by table and hand number', () => {
    const keyed = SETTLEMENT.match(/`\$\{this\.tableId\}:\$\{snap\.handNumber\}`/g) ?? [];
    // postHandTasks.<step>_failed and the authoritative-hand refusal.
    expect(keyed.length).toBeGreaterThanOrEqual(2);
  });

  it('the wrapper still never throws, so an alarm cannot break a money path', () => {
    expect(ALERTS).toContain('return { persisted: false, alertId: null };');
    expect(ALERTS).toMatch(/} catch \(e\) \{/);
  });
});
