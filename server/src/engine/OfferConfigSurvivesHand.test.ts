/**
 * "INSURANCE AND RUN IT TWICE ARE 100% BROKEN AND HAVE ZERO FUNCTIONALITY"
 * (Dan, 2026-08-21). He was right, and this is the reason.
 *
 * ServerTableEngineSettlement step 6 cleaned up "advanced modules between
 * hands" by calling dispose() on both engines. dispose() deleted the pending
 * offer AND the table's configuration. configure() is called exactly once per
 * engine, in start(). isEnabled() reads the config:
 *
 *     tableConfigs.get(tableId)?.enabled ?? false
 *
 * So after the first hand settled, isEnabled() was false forever and neither
 * feature could ever be offered again on that table.
 *
 * Every existing test passed because they all configure and then exercise ONE
 * hand. The bug lives strictly in hand N+1, so that is what these tests check.
 *
 * Production shape of the bug (2026-08-21, cash tables with RIT on, 35 min
 * after the engine deploy): 54 hands where betting stopped on a pre-river
 * all-in, 3 RIT offers - and those 3 clustered in the minutes right after the
 * deploy restarted every table, i.e. each table's one allowed hand.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import { InsuranceEngine } from './InsuranceEngine.js';

const TABLE = 'table-offer-config';

describe('RunItTwiceEngine: config outlives the hand', () => {
  let rit: RunItTwiceEngine;

  beforeEach(() => {
    rit = new RunItTwiceEngine();
    rit.configure(TABLE, { enabled: true, autoDeclineTimeout: 10, maxRuns: 3 });
  });

  it('is still enabled after the between-hands cleanup', () => {
    expect(rit.isEnabled(TABLE)).toBe(true);
    rit.endHand(TABLE);
    expect(rit.isEnabled(TABLE)).toBe(true);
  });

  it('still offers on the SECOND hand - the hand the old code could not reach', () => {
    rit.offer(TABLE, `${TABLE}:1`, 'alice', ['alice', 'bob'], 100);
    expect(rit.getState(TABLE)).not.toBeNull();
    rit.endHand(TABLE);

    // Hand 2: nothing was re-configured in between, exactly like production.
    expect(rit.isEnabled(TABLE)).toBe(true);
    rit.offer(TABLE, `${TABLE}:2`, 'alice', ['alice', 'bob'], 250);
    expect(rit.getState(TABLE)?.status).toBe('offered');
  });

  it('runs it twice on hand 5 - a table does not decay with hand count', () => {
    for (let hand = 1; hand <= 4; hand++) {
      rit.offer(TABLE, `${TABLE}:${hand}`, 'alice', ['alice', 'bob'], 100);
      rit.endHand(TABLE);
    }
    rit.offer(TABLE, `${TABLE}:5`, 'alice', ['alice', 'bob'], 100);
    rit.chooserDecides(TABLE, 'alice', 2);
    expect(rit.accept(TABLE, 'bob')).toBe(true);
    expect(rit.isActive(TABLE)).toBe(true);
  });

  it('endHand clears the OFFER, so a stale offer cannot leak into the next hand', () => {
    rit.offer(TABLE, `${TABLE}:1`, 'alice', ['alice', 'bob'], 100);
    rit.chooserDecides(TABLE, 'alice', 3);
    rit.endHand(TABLE);
    expect(rit.getState(TABLE)).toBeNull();
    expect(rit.hasPendingOffer(TABLE)).toBe(false);
    expect(rit.isActive(TABLE)).toBe(false);
  });

  it('dispose still tears the table down completely', () => {
    rit.dispose(TABLE);
    expect(rit.isEnabled(TABLE)).toBe(false);
    expect(rit.getState(TABLE)).toBeNull();
  });

  it('a table configured OFF is not switched on by the cleanup', () => {
    const off = 'table-rit-off';
    rit.configure(off, { enabled: false, autoDeclineTimeout: 10, maxRuns: 3 });
    rit.endHand(off);
    expect(rit.isEnabled(off)).toBe(false);
  });
});

describe('InsuranceEngine: config outlives the hand', () => {
  let ins: InsuranceEngine;

  beforeEach(() => {
    ins = new InsuranceEngine();
    ins.configure(TABLE, { enabled: true });
  });

  it('is still enabled after the between-hands cleanup', () => {
    expect(ins.isEnabled(TABLE)).toBe(true);
    ins.endHand(TABLE);
    expect(ins.isEnabled(TABLE)).toBe(true);
  });

  it('survives many hands', () => {
    for (let hand = 0; hand < 10; hand++) ins.endHand(TABLE);
    expect(ins.isEnabled(TABLE)).toBe(true);
  });

  it('dispose still tears the table down completely', () => {
    ins.dispose(TABLE);
    expect(ins.isEnabled(TABLE)).toBe(false);
  });
});

describe('settlement calls endHand, never dispose, between hands', () => {
  it('the between-hands cleanup in ServerTableEngineSettlement uses endHand', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/engine/ServerTableEngineSettlement.ts', 'utf8');
    expect(src).toContain('this.runItTwiceEngine.endHand(this.tableId)');
    expect(src).toContain('this.insuranceEngine.endHand(this.tableId)');
    // The regression itself: a per-hand dispose() of either engine.
    expect(src).not.toContain('this.runItTwiceEngine.dispose(');
    expect(src).not.toContain('this.insuranceEngine.dispose(');
  });
});
