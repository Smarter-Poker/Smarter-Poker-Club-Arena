/**
 * ===========================================================================
 * LAW: THE TUNER'S HAND STREAM SEEKS, IT DOES NOT SKIP (2026-09-28)
 * ===========================================================================
 *
 * HorseSelfTuner streams up to 120,000 cash hands from hand_history. It used
 * to page with .range(offset). OFFSET makes Postgres read and discard every
 * row before the page, and cash is a minority of hand_history, so the deep
 * pages cost tens of seconds (measured 2026-09-28: 29 ms for the first page,
 * over 25 s at offset 20,000) against the engine's 8 s statement timeout.
 *
 * When the fleet swung toward tournaments on 2026-09-26 the deep pages
 * crossed that limit. The timeout unwound the whole study before a roster
 * was prepared: the self_tuner job claimed 2026-09-26, 09-27 and 09-28 and
 * wrote zero horse_self_tune_log rows on each.
 *
 * This law pins the three links that keep it from coming back:
 *   1. the stream is a keyset read on (created_at, id), never .range(offset);
 *   2. the seek filter is strictly-older-than the cursor, with quoted values,
 *      beside a plain created_at <= bound the index can seek to;
 *   3. a failed stream costs only the gap-filled horses, never the night.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handHistorySeekFilter } from './HorseSelfTuner.js';

const src = readFileSync(join(__dirname, 'HorseSelfTuner.ts'), 'utf8');

function streamBlock(): string {
  const at = src.indexOf(".from('hand_history')");
  expect(at, 'the tuner no longer reads hand_history').toBeGreaterThan(-1);
  const loopStart = src.lastIndexOf('while (', at);
  const end = src.indexOf("reportError(err, 'HorseSelfTuner.stream')", at);
  expect(end, 'the stream lost its own catch').toBeGreaterThan(at);
  return src.slice(loopStart, end);
}

describe('the tuner hand stream seeks instead of skipping', () => {
  it('pages hand_history by keyset, never by offset', () => {
    const block = streamBlock();
    expect(block).not.toMatch(/\.range\(/);
    expect(block).not.toMatch(/offset/);
    expect(block).toContain('handHistorySeekFilter(cursor)');
    // Without the plain bound the OR is only a filter and every page scans
    // from the newest row again (5.2 s at depth 15,000, measured).
    expect(block).toContain(".lte('created_at', cursor.createdAt)");
    expect(block).toContain(".order('created_at', { ascending: false })");
    expect(block).toContain(".order('id', { ascending: false })");
    expect(block).toContain('.limit(PAGE_SIZE)');
    // The cursor needs the id, so the id must be selected.
    expect(block).toMatch(/select\('id, /);
  });

  it('keeps the cursor as the raw timestamp string, not a Date', () => {
    const block = streamBlock();
    expect(block).toContain('cursor = { createdAt: last.created_at, id: last.id }');
    expect(block).not.toMatch(/new Date\(last\.created_at/);
  });

  it('a failed stream costs the gap-filled horses, not the whole night', () => {
    const at = src.indexOf("reportError(err, 'HorseSelfTuner.stream')");
    // The catch ends where the coverage bookkeeping begins.
    const end = src.indexOf('// What the sample ACTUALLY covered', at);
    expect(end, 'the stream catch lost its closing landmark').toBeGreaterThan(at);
    const after = src.slice(at, end);
    expect(after).toContain('streamed.clear()');
    expect(after).not.toMatch(/throw /);
  });
});

describe('handHistorySeekFilter', () => {
  it('selects rows strictly older than the cursor in (created_at desc, id desc)', () => {
    expect(
      handHistorySeekFilter({
        createdAt: '2026-09-28T10:26:52.042123+00:00',
        id: '0b8a7c1e-1111-4222-8333-444455556666',
      })
    ).toBe(
      'created_at.lt."2026-09-28T10:26:52.042123+00:00",' +
        'and(created_at.eq."2026-09-28T10:26:52.042123+00:00",' +
        'id.lt."0b8a7c1e-1111-4222-8333-444455556666")'
    );
  });

  it('keeps microseconds exactly as Postgres sent them', () => {
    const f = handHistorySeekFilter({ createdAt: '2026-09-28T00:00:00.000001+00:00', id: 'x' });
    expect(f).toContain('00:00:00.000001+00:00');
  });
});
