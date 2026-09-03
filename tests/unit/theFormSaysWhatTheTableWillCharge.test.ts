/**
 * THE CREATE-TABLE FORM SAYS WHAT THE TABLE WILL CHARGE.
 *
 * The two rake sliders read "Schedule" by default, and the schedule is a table
 * in a config file, so an owner could set up a game without ever seeing its
 * price. That is not a hypothetical complaint: the rake gap this audit found —
 * six of the twelve blind presets had no schedule row, and the DEFAULT preset
 * was priced off a tier fallback at 30 big blinds — survived in the product
 * for months precisely because nothing on the authoring screen ever said the
 * number out loud.
 *
 * The danger in adding such a panel is the OTHER failure this repo has already
 * had: on 2026-08-15 the Game Rules modal told every player "Rake 5% (Cap $3)"
 * at every stake, because its props were never assigned and it fell through to
 * placeholder defaults. A price display that can disagree with the engine is
 * worse than none.
 *
 * So these pins are about AGREEMENT, not about wording: the panel resolves
 * through getRakeConfig with the same precedence the engine applies.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getRakeConfig, RAKE_INHERIT, MAX_RAKE_CAP_BB } from '../../src/config/RakeConfig';
import { BLINDS_PRESETS } from '../../src/config/blindsPresets';

const FORM = fs.readFileSync(
  path.join(process.cwd(), 'src', 'pages', 'TableConfigPage.tsx'),
  'utf8'
);

describe('the panel resolves the price rather than restating a default', () => {
  it('calls getRakeConfig, the function the engine mirrors', () => {
    expect(FORM).toContain('getRakeConfig(config.bigBlind');
  });

  it('passes the owner overrides in, so the panel reflects the sliders', () => {
    expect(FORM).toMatch(/rakePercent: config\.rakePercent/);
    expect(FORM).toMatch(/rakeCapBB: config\.rakeCapBB/);
  });

  it('hard-codes no percentage or cash cap of its own', () => {
    // The Game Rules regression was a hard-coded "5%" / "$3" placeholder.
    const panel = FORM.slice(
      FORM.indexOf('WHAT THIS TABLE WILL ACTUALLY CHARGE'),
      FORM.indexOf('SECTION: Security')
    );
    expect(panel.length).toBeGreaterThan(0);
    expect(panel).not.toMatch(/\d+%\s*<\//);
    expect(panel).not.toMatch(/\$\s?\d/);
  });
});

describe('what it would show is what the schedule charges', () => {
  it.each(BLINDS_PRESETS.map((p) => [p.label, p.sb, p.bb] as const))(
    '%s resolves to a published price',
    (_label, sb, bb) => {
      const priced = getRakeConfig(bb, 'nlh', sb, {
        rakePercent: RAKE_INHERIT,
        rakeCapBB: RAKE_INHERIT,
      });
      expect(priced.rakePercent).toBe(10);
      expect(priced.rakeCap).toBeGreaterThan(0);
      expect(priced._exactMatch).toBe(true);
      expect(priced.bbjFeeBB).toBeGreaterThan(0);
    }
  );

  it('an override may only move the price DOWN, and the panel shows the held value', () => {
    const p = BLINDS_PRESETS.find((x) => x.label === '1/2')!;
    const schedule = getRakeConfig(p.bb, 'nlh', p.sb, {
      rakePercent: RAKE_INHERIT,
      rakeCapBB: RAKE_INHERIT,
    });
    // Ask for the maximum the slider allows, which is worth more than the
    // schedule cap at this stake: 10 BB = $20 against a $5 published cap.
    const greedy = getRakeConfig(p.bb, 'nlh', p.sb, {
      rakePercent: 10,
      rakeCapBB: MAX_RAKE_CAP_BB,
    });
    expect(greedy.rakeCap).toBe(schedule.rakeCap);
    expect(greedy.rakePercent).toBeLessThanOrEqual(schedule.rakePercent);

    const modest = getRakeConfig(p.bb, 'nlh', p.sb, { rakePercent: 5, rakeCapBB: 1 });
    expect(modest.rakePercent).toBe(5);
    expect(modest.rakeCap).toBe(2);
  });

  it('says so plainly when a variant has no Bad Beat Jackpot', () => {
    // The panel branches on bbjEnabled rather than printing a fee of zero.
    expect(FORM).toContain('No Bad Beat Jackpot On This Game');
    expect(FORM).toContain('priced.bbjEnabled ?');
  });
});
