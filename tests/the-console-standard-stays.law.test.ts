/**
 * LAW: the #ClubArenaConsole standard stays in the repo, and stays reachable.
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan, 2026-09-09, on being told the standard existed only inside one Claude
 * account: "I WANT YOU TO UPGRADE AND ENHANCE IT AS BEST AS YOU CAN SO ANY AND
 * ALL AGENTS CAN DO WHAT YOU ARE DOING HERE."
 *
 * A method that lives in one agent's head is re-derived, badly, by the next
 * one; a method that lives in one Claude account is invisible from every other
 * account and every other tool, which is CLAUDE.md 10.85's lesson applied to
 * instructions instead of schedules. So the standard is a file in this repo,
 * and CLAUDE.md points at it, and this law makes both load-bearing:
 *
 *   - delete the skill, or its runnable kit, and CI says so;
 *   - delete the pointer in CLAUDE.md and CI says so, because a document
 *     nobody is told to read is a document nobody reads;
 *   - hollow the skill out and CI says so - it must still carry the parts an
 *     agent cannot infer: Dan's rulings, the zone constants, the surgery, the
 *     harness, the traps, the definition of done.
 *
 * This pins EXISTENCE and REACH, never the design opinions inside. Those are
 * Dan's and they will keep moving; edit them freely.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'club-arena-console');
const SKILL = join(SKILL_DIR, 'SKILL.md');

describe('the #ClubArenaConsole standard stays', () => {
  it('the skill exists where every agent and every tool looks for it', () => {
    expect(
      existsSync(SKILL),
      '.claude/skills/club-arena-console/SKILL.md is gone. It is how every ' +
        'agent - on any account, in any tool - knows how a Club Arena surface ' +
        'is rebuilt. Restore it; do not re-derive it.'
    ).toBe(true);
  });

  it('CLAUDE.md points at it, so nobody has to already know it exists', () => {
    const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('.claude/skills/club-arena-console/SKILL.md');
    expect(claude).toContain('#ClubArenaConsole');
  });

  it('the runnable kit is still runnable', () => {
    for (const f of [
      'scripts/master_surgery.py',
      'scripts/find-generic-surfaces.mjs',
      'harness/card-harness.tsx',
      'harness/card-harness.html',
      'harness/shot.mjs',
      'harness/run-shots.sh',
      'harness/sheet.py',
      'harness/README.md',
    ]) {
      expect(existsSync(join(SKILL_DIR, f)), `${f} is missing from the skill`).toBe(true);
    }
  });

  it('the surgery library still offers every technique the doc teaches', () => {
    const lib = readFileSync(join(SKILL_DIR, 'scripts', 'master_surgery.py'), 'utf8');
    for (const fn of [
      'def median_bridge',
      'def synth_fill',
      'def synth_fill_matched',
      'def axis_of_symmetry',
      'def mirror_close',
      'def flat_cap',
      'def splice',
      'def is_straight',
      'def column_runs',
    ]) {
      expect(lib, `master_surgery.py lost ${fn}`).toContain(fn);
    }
  });

  it('the skill still carries what an agent cannot infer', () => {
    const skill = readFileSync(SKILL, 'utf8');
    // The trigger, so the description keeps firing on the phrase Dan uses.
    expect(skill).toContain('#ClubArenaConsole');
    // The one idea, the kit, the method, the surgery, the harness, the traps.
    for (const section of [
      'Paint what never changes',
      "Dan's law",
      'SPADE_CONSOLE_ZONES',
      'Art surgery',
      'The render harness',
      'Traps that have each cost hours',
      'Definition of done',
    ]) {
      expect(skill, `the skill no longer covers "${section}"`).toContain(section);
    }
    // Long enough to be the real thing rather than a stub that satisfies greps.
    expect(skill.split('\n').length).toBeGreaterThan(300);
  });
});
