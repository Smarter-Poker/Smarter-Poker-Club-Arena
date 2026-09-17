/**
 * LAW: A STALE READ NEVER LANDS, AND A LOOP NEVER OUTLIVES ITS OWNER (2026-09-10)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Seven React defects from the 2026-09-08 client audit, one shape: an effect
 * started asynchronous work keyed on a prop and let the ANSWER TO THE OLD
 * KEY land after the key had changed - or let the work outlive the
 * component altogether.
 *
 *   - useClubRole: switching clubs mid-flight let the previous club's
 *     membership resolve last, so isAdmin / canViewFinancials described the
 *     wrong club (CL-27);
 *   - PlayerNotesPanel: a player with no saved note inherited the PREVIOUS
 *     player's text, tags and colour, which saveNote then upserted against
 *     the new target (CL-29);
 *   - AgentManagementPage: changing club while agents were loading landed the
 *     old club's credit limits under the new club's header (CL-53);
 *   - RealTimeResultPanel: the channel ref was assigned after the await the
 *     cleanup raced, leaking one live channel per open/close (CL-28);
 *   - AnimatedCounter: no frame id, no cleanup, two loops fighting (CL-51);
 *   - SortableTable: positional keys on a list the sort reorders (CL-52);
 *   - RakeTab: toFixed on RPC fields nobody promised (CL-46) - fixed where
 *     the promise belongs, in StatsFactsService.normaliseRakeStats.
 *
 * This law pins each fix by its load-bearing line, and exercises the one
 * that is pure.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normaliseRakeStats } from '../src/services/StatsFactsService';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('LAW: a stale read never lands', () => {
  it('useClubRole and useIsMember cancel the read for a club that is no longer current', () => {
    const hooks = read('src/hooks/index.ts');
    const roleFn = hooks.slice(
      hooks.indexOf('export function useClubRole'),
      hooks.indexOf('export function useClubMembers')
    );
    expect(roleFn).toContain('let cancelled = false;');
    expect(roleFn).toMatch(/if \(!cancelled\) setMembership\(m\)/);
    expect(roleFn).toMatch(/cancelled = true;/);
    // The old club's permissions are cleared before the new club's are read.
    expect(roleFn).toMatch(/setMembership\(null\);\s*setIsLoading\(true\);/);
    const memberFn = hooks.slice(
      hooks.indexOf('export function useIsMember'),
      hooks.indexOf('// UNION HOOKS')
    );
    expect(memberFn).toContain('let cancelled = false;');
    expect(memberFn).toMatch(/if \(!cancelled\) setIsMember\(/);
  });

  it('PlayerNotesPanel resets the form when the target changes and refuses to save over an unread note', () => {
    const panel = read('src/components/gameplay/PlayerNotesPanel.tsx');
    const loadStart = panel.lastIndexOf(
      'useEffect(() => {',
      panel.indexOf('const loadSingleNote = async')
    );
    const load = panel.slice(loadStart, panel.indexOf('const loadAllNotes = async'));
    // Reset BEFORE the read, so no previous player's note survives a miss.
    const resetAt = load.indexOf("setCurrentNote('')");
    const readAt = load.indexOf(".from('player_notes')");
    expect(resetAt).toBeGreaterThan(-1);
    expect(resetAt).toBeLessThan(readAt);
    expect(load).toContain('setSelectedTags([])');
    expect(load).toContain("setSelectedColor('none')");
    expect(load).toMatch(/if \(!isCurrent\(\)\) return;/);
    expect(load).toContain('setNoteLoadFailed(true)');
    const save = panel.slice(
      panel.indexOf('const saveNote = async'),
      panel.indexOf('const toggleTag')
    );
    expect(save).toMatch(/if \(visibleLoadFailed\) \{[\s\S]*?return;/);
  });

  it('AgentManagementPage drops an agents read whose ticket is no longer current', () => {
    const page = read('src/pages/AgentManagementPage.tsx');
    expect(page).toContain('const agentsLoadTicket = useRef(0);');
    expect(page).toMatch(/const claimAgentsLoad = \(\) => \+\+agentsLoadTicket\.current;/);
    // Every setAgents after an await is fenced on the ticket.
    const fenced = (page.match(/if \(agentsLoadIsCurrent\(ticket\)\) setAgents\(data\)/g) || [])
      .length;
    const unfenced = (page.match(/if \(isMounted\.current\) setAgents\(/g) || []).length;
    expect(fenced).toBeGreaterThanOrEqual(2);
    expect(unfenced).toBe(0);
    expect(page).toMatch(/if \(!agentsLoadIsCurrent\(ticket\)\) return;\s*setAgents\(data\);/);
    // A club change reissues the ticket.
    expect(page).toMatch(
      /return \(\) => \{\s*\/\/ A club change reissues the ticket[\s\S]*?claimAgentsLoad\(\);/
    );
  });

  it('RealTimeResultPanel claims the channel ref before the await its cleanup races', () => {
    const panel = read('src/components/table/RealTimeResultPanel.tsx');
    const effect = panel.slice(
      panel.indexOf('supabase.channel(`table-observers-${tableId}`'),
      panel.indexOf("reportError(e, 'RealTimeResultPanel.presence')")
    );
    const refAt = effect.indexOf('channelRef.current = ch;');
    const subscribeAt = effect.indexOf('await ch.subscribe(async');
    expect(refAt).toBeGreaterThan(-1);
    expect(refAt).toBeLessThan(subscribeAt);
    // A subscribe that completes after cancellation removes what it made.
    expect(effect).toMatch(
      /if \(cancelled && channelRef\.current !== ch\)[\s\S]*?supabase\.removeChannel\(ch\)/
    );
  });

  it('AnimatedCounter keeps its frame id and cancels it on change and unmount', () => {
    const counter = read('src/components/counters/AnimatedCounter.tsx');
    expect(counter).toMatch(/frame = requestAnimationFrame\(animate\)/);
    expect(counter).toMatch(/return \(\) => cancelAnimationFrame\(frame\)/);
    expect(counter).not.toMatch(/^\s*requestAnimationFrame\(animate\);/m);
  });

  it('SortableTable keys a row by its record, never by its position', () => {
    const table = read('src/components/tables/SortableTable.tsx');
    expect(table).not.toMatch(/<tr key=\{rowIdx\}>/);
    expect(table).toMatch(/<tr key=\{rowKey\(row, rowIdx\)\}>/);
    expect(table).toMatch(/const id = row\.id \?\? row\.key \?\? row\.uuid;/);
  });

  it('normaliseRakeStats promises every field the Rake tab formats', () => {
    const empty = normaliseRakeStats(undefined);
    expect(empty).toEqual({
      hands: 0,
      raked_hands: 0,
      rake_paid: 0,
      rake_per_100: 0,
      rake_in_bb: 0,
      bb_per_100: 0,
      avg_rake_per_raked_hand: 0,
      first_hand_at: null,
      last_hand_at: null,
      days: null,
    });
    // A column missing from the payload is 0, not undefined.toFixed.
    const partial = normaliseRakeStats({
      hands: '12',
      rake_paid: 3.5,
      error: 'read_failed',
    } as never);
    expect(partial.hands).toBe(12);
    expect(partial.rake_paid).toBe(3.5);
    expect(partial.rake_in_bb.toFixed(2)).toBe('0.00');
    expect(partial.avg_rake_per_raked_hand.toFixed(4)).toBe('0.0000');
    expect(partial.error).toBe('read_failed');
    // A null the SQL let through is 0 too; a string date survives; days may be null.
    const nulls = normaliseRakeStats({
      rake_per_100: null,
      first_hand_at: '2026-09-01',
      days: null,
    } as never);
    expect(nulls.rake_per_100).toBe(0);
    expect(nulls.first_hand_at).toBe('2026-09-01');
    expect(nulls.days).toBeNull();
    // getRakeStats routes through it.
    const svc = read('src/services/StatsFactsService.ts');
    const fn = svc.slice(
      svc.indexOf('async getRakeStats('),
      svc.indexOf('async getHandRakeShare(')
    );
    expect(fn).toContain('return normaliseRakeStats(raw);');
  });
});
