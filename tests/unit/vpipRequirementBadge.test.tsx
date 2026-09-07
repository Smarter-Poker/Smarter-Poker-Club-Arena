/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE VPIP REQUIREMENT BADGE — data is dynamic, design is immutable
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07, item 3, closing rule: "The live VPIP value must behave like a
 * digital readout installed inside a permanently manufactured casino plaque."
 *
 * Section numbers below are his. Section 30 lists the value matrix by hand and
 * every entry of it is here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  VpipRequirementBadge,
  formatVpipValue,
  isAllowedVpipRequirement,
  ALLOWED_VPIP_REQUIREMENTS,
} from '../../src/components/table/VpipRequirementBadge';

const reportError = vi.fn();
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...a: unknown[]) => reportError(...a),
}));

const read = (p: string) => readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
const CSS = read('src/components/table/VpipRequirementBadge.css');
const TSX = read('src/components/table/VpipRequirementBadge.tsx');

afterEach(() => cleanup());

describe('section 30 — the value matrix, both game rules', () => {
  beforeEach(() => reportError.mockClear());

  for (const min of [30, 50] as const) {
    for (const cur of [0, 7, 29, 30, 49, 50, 54, 99, 100]) {
      it(`MIN ${min}% + CURRENT ${cur}%`, () => {
        render(<VpipRequirementBadge minimumVpip={min} currentVpip={cur} />);
        expect(screen.getByText(`${cur}%`)).toBeTruthy();
        expect(screen.getByText(`MIN ${min}%`)).toBeTruthy();
      });
    }
  }
});

describe('section 14 + 22 — what the readout prints', () => {
  it('rounds to whole percentages', () => {
    expect(formatVpipValue(53.4)).toBe('53%');
    expect(formatVpipValue(53.6)).toBe('54%');
  });

  it('never loaded prints --%, because 0% is a real statistic', () => {
    /* Section 22, and this is the distinction the whole rule rests on: a
       player who has voluntarily entered no pots HAS a VPIP, and it is zero.
       Printing 0% for "we do not know yet" tells them they are failing. */
    expect(formatVpipValue(null)).toBe('--%');
    expect(formatVpipValue(undefined)).toBe('--%');
    expect(formatVpipValue(0)).toBe('0%');
  });

  it('clamps corrupt input rather than drawing outside the window', () => {
    expect(formatVpipValue(-12)).toBe('0%');
    expect(formatVpipValue(180)).toBe('100%');
    expect(formatVpipValue(Number.NaN)).toBe('--%');
    expect(formatVpipValue(Number.POSITIVE_INFINITY)).toBe('--%');
  });
});

describe('section 1 — only two game rules are sanctioned', () => {
  beforeEach(() => reportError.mockClear());

  it('30 and 50 are the whole list', () => {
    expect([...ALLOWED_VPIP_REQUIREMENTS]).toEqual([30, 50]);
    expect(isAllowedVpipRequirement(30)).toBe(true);
    expect(isAllowedVpipRequirement(50)).toBe(true);
    for (const bad of [20, 25, 35, 40, 45, 55, 60]) {
      expect(isAllowedVpipRequirement(bad)).toBe(false);
    }
  });

  it('IN DEVELOPMENT it fails visibly, exactly as section 1 asks', () => {
    /* "fail visibly in development and log an error rather than silently
       inventing another display state". A developer who points this badge at
       a game rule the product does not define is told at once. */
    expect(() => render(<VpipRequirementBadge minimumVpip={40} currentVpip={54} />)).toThrow(
      /Invalid VPIP requirement: 40/
    );
  });

  it('IN PRODUCTION it reports once and prints the real number', () => {
    /* ── THE ONE PLACE THIS SPEC MEETS PRODUCTION AND DISAGREES ─────────────
       Live tables are configured at 40 TODAY - Dan's own screenshots in the
       same message read "VPIP 40% MIN", and fn_cash_vpip_status.required
       returns whatever the club set. So the dev throw above must not reach a
       player: it would take the felt down on every 40% table in the estate.

       Reporting and printing the configured truth is not "inventing another
       display state". Rounding 40 up to MIN 50% would be - and it would tell
       a player they are failing a rule nobody set. Which side moves, the
       component's contract or the clubs' config, is Dan's call; until then
       this fails loudly to us and honestly to them. */
    vi.stubEnv('DEV', false);
    try {
      render(<VpipRequirementBadge minimumVpip={40} currentVpip={54} />);
      expect(screen.getByText('MIN 40%')).toBeTruthy();
      expect(screen.getByText('54%')).toBeTruthy();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(String(reportError.mock.calls[0][0])).toMatch(/not a sanctioned game rule/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports ONCE per mount, not once per live VPIP tick', () => {
    // An error loop on a per-hand event is the shape the engine's Sentry
    // budget exists to survive (CLAUDE.md section 2). Do not re-report.
    vi.stubEnv('DEV', false);
    try {
      const { rerender } = render(<VpipRequirementBadge minimumVpip={40} currentVpip={54} />);
      rerender(<VpipRequirementBadge minimumVpip={40} currentVpip={55} />);
      rerender(<VpipRequirementBadge minimumVpip={40} currentVpip={56} />);
      expect(reportError).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a sanctioned minimum reports nothing', () => {
    render(<VpipRequirementBadge minimumVpip={30} currentVpip={54} />);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('section 25 — the badge never colour-codes pass or fail', () => {
  it('the value carries the same treatment above and below the requirement', () => {
    const { container: under } = render(<VpipRequirementBadge minimumVpip={50} currentVpip={29} />);
    const a = under.querySelector('.vpipBadge__currentValue')!.className;
    cleanup();
    const { container: over } = render(<VpipRequirementBadge minimumVpip={50} currentVpip={99} />);
    const b = over.querySelector('.vpipBadge__currentValue')!.className;
    expect(a).toBe(b);
  });

  it('no green / red / gold pass-fail colouring survives in the stylesheet', () => {
    // The rectangle this replaced coloured its figure five ways. Section 25
    // forbids it: silver, black and blue, whatever the player's standing.
    expect(CSS).not.toMatch(/#3fb950|#ff5c5c|#8fd4ff/i);
    const tracker = read('src/components/table/HeroVpipTracker.css');
    expect(tracker).not.toMatch(/#3fb950|#ff5c5c|#8fd4ff/i);
  });
});

describe('sections 15 + 19 — the number may not move or animate', () => {
  it('tabular figures, so 38 -> 42 -> 54 cannot change the width', () => {
    expect(CSS).toMatch(/\.vpipBadge__currentValue\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
  });

  it('the only permitted transition is a short opacity fade', () => {
    const rule = CSS.slice(
      CSS.indexOf('.vpipBadge__currentValue {'),
      CSS.indexOf('}', CSS.indexOf('.vpipBadge__currentValue {'))
    );
    expect(rule).toMatch(/transition:\s*opacity 120ms ease-out/);
    expect(rule).not.toMatch(/transform|scale|rotate|translate/);
  });

  it('nothing rolls, spins, counts, flips or bounces', () => {
    expect(CSS).not.toMatch(/@keyframes/);
    expect(CSS).not.toMatch(/animation:/);
  });
});

describe('sections 4 + 28 — one square drawing, scaled', () => {
  it('is locked to a 1:1 aspect and driven by a single size variable', () => {
    expect(CSS).toMatch(/aspect-ratio:\s*1;/);
    expect(CSS).toMatch(/--vpip-badge-size/);
  });

  it('declares no breakpoint font sizes of its own', () => {
    // Section 28: desktop and mobile are ONE design scaled, never two designs.
    // Every length in this file is a % of the badge or an em of its own type.
    expect(CSS).not.toMatch(/@media[^{]*\{[^}]*font-size/s);
  });
});

describe('sections 3 + 9 — drawn, not baked; blue only inside the window', () => {
  it('the current value is a real text node, not an image', () => {
    render(<VpipRequirementBadge minimumVpip={30} currentVpip={54} />);
    expect(screen.getByText('54%').tagName).not.toBe('IMG');
    expect(TSX).not.toMatch(/\.png|\.webp|<img/i);
  });

  it('both blue accents live inside the current window and nowhere else', () => {
    const accents = CSS.match(/--vpip-blue\b/g) ?? [];
    expect(accents.length).toBeGreaterThan(0);
    // No blue on the outer frame: section 5 bans an illuminated outer edge.
    const frame = CSS.slice(CSS.indexOf('.vpipBadge {'), CSS.indexOf('.vpipBadge__face'));
    expect(frame).not.toMatch(/box-shadow:[^;]*rgb\(8 123 255/);
  });
});

describe('section 21 — a lost link never blanks the figure', () => {
  it('a stale status keeps the last known value on screen', () => {
    render(<VpipRequirementBadge minimumVpip={30} currentVpip={54} status="stale" />);
    expect(screen.getByText('54%')).toBeTruthy();
    expect(screen.getByTestId('vpip-badge').getAttribute('data-status')).toBe('stale');
  });
});

describe('accessibility — the sentence, and only the number re-announced', () => {
  it('labels the whole plaque and live-regions just the value', () => {
    const { container } = render(<VpipRequirementBadge minimumVpip={50} currentVpip={54} />);
    expect(screen.getByTestId('vpip-badge').getAttribute('aria-label')).toBe(
      // Title Cased: the house copy rule covers attributes a reader speaks.
      'Current VPIP 54%. Minimum Required VPIP 50 Percent.'
    );
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.className).toContain('vpipBadge__currentValue');
  });
});
