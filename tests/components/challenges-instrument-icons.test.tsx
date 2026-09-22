import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CASINO_CONTROL_ICON_STATES,
  CASINO_CONTROL_ICON_VARIANTS,
  CasinoControlIcon,
} from '../../src/components/challenges/CasinoControlIcon';
import { MissionInstrumentGlyph } from '../../src/components/challenges/MissionInstrumentGlyph';
import { CHALLENGE_TYPES } from '../../src/services/DailyChallengeService';

const root = process.cwd();
const controlSource = readFileSync(
  resolve(root, 'src/components/challenges/CasinoControlIcon.tsx'),
  'utf8'
);
const controlCss = readFileSync(
  resolve(root, 'src/components/challenges/CasinoControlIcon.module.css'),
  'utf8'
);
const missionSource = readFileSync(
  resolve(root, 'src/components/challenges/MissionInstrumentGlyph.tsx'),
  'utf8'
);
const missionCss = readFileSync(
  resolve(root, 'src/components/challenges/MissionInstrumentGlyph.module.css'),
  'utf8'
);

afterEach(cleanup);

describe('CasinoControlIcon', () => {
  it('renders every Daily Challenges action as a distinct instrument mechanism', () => {
    const signatures = new Set<string>();

    for (const variant of CASINO_CONTROL_ICON_VARIANTS) {
      const view = render(<CasinoControlIcon variant={variant} />);
      const instrument = view.container.querySelector('[data-casino-control-icon]');
      const mechanism = view.container.querySelector(`[data-icon-mechanism="${variant}"]`);

      expect(instrument).toHaveAttribute('data-variant', variant);
      expect(mechanism).toBeInTheDocument();
      signatures.add(mechanism?.innerHTML ?? '');
      view.unmount();
    }

    expect(CASINO_CONTROL_ICON_VARIANTS).toHaveLength(19);
    expect(signatures.size).toBe(CASINO_CONTROL_ICON_VARIANTS.length);
  });

  it('gives Daily, Weekly, and Monthly their own animated physical mechanism', () => {
    const variants = ['cycle-daily', 'cycle-weekly', 'cycle-monthly'] as const;
    const signatures = variants.map((variant) => {
      const view = render(<CasinoControlIcon variant={variant} state="active" />);
      const mechanism = view.container.querySelector(
        `[data-cycle-mechanism="${variant.slice(6)}"]`
      );
      expect(mechanism).toBeInTheDocument();
      const signature = mechanism?.innerHTML ?? '';
      view.unmount();
      return signature;
    });

    expect(new Set(signatures).size).toBe(variants.length);
    expect(controlCss).toContain("[data-variant='cycle-daily'] .cycleDial");
    expect(controlCss).toContain("[data-variant='cycle-weekly'] .cycleWheel");
    expect(controlCss).toContain("[data-variant='cycle-monthly'] .cycleSeal");
  });

  it.each(CASINO_CONTROL_ICON_STATES)('exposes the %s state to the visual system', (state) => {
    const { container } = render(
      <CasinoControlIcon variant="sync" state={state} size="lg" className="integration-class" />
    );
    const instrument = container.querySelector('[data-casino-control-icon]');

    expect(instrument).toHaveAttribute('data-state', state);
    expect(instrument).toHaveAttribute('data-size', 'lg');
    expect(instrument).toHaveClass('integration-class');
  });

  it('is strictly decorative so the labelled parent control owns accessibility', () => {
    const { container } = render(<CasinoControlIcon variant="claim" />);
    const instrument = container.querySelector('[data-casino-control-icon]');
    const svg = container.querySelector('svg');

    expect(instrument).toHaveAttribute('aria-hidden', 'true');
    expect(instrument).not.toHaveAttribute('tabindex');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(container.querySelector('title, text')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('keeps metallic paint definitions isolated when many instruments share a card grid', () => {
    const { container } = render(
      <div>
        {CASINO_CONTROL_ICON_VARIANTS.map((variant) => (
          <CasinoControlIcon key={variant} variant={variant} />
        ))}
        {CHALLENGE_TYPES.map((type) => (
          <MissionInstrumentGlyph key={type} type={type} />
        ))}
      </div>
    );
    const ids = [...container.querySelectorAll('linearGradient, radialGradient')].map(
      (definition) => definition.id
    );

    expect(ids).toHaveLength(CASINO_CONTROL_ICON_VARIANTS.length * 2 + CHALLENGE_TYPES.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
  });
});

describe('MissionInstrumentGlyph', () => {
  it('covers all ten countable challenge types with unique SVG mechanisms', () => {
    const signatures = new Set<string>();

    for (const type of CHALLENGE_TYPES) {
      const view = render(<MissionInstrumentGlyph type={type} progress={42} />);
      const instrument = view.container.querySelector('[data-mission-instrument]');
      const mechanism = view.container.querySelector(`[data-mission-mechanism="${type}"]`);

      expect(instrument).toHaveAttribute('data-mission-type', type);
      expect(mechanism).toBeInTheDocument();
      signatures.add(mechanism?.innerHTML ?? '');
      view.unmount();
    }

    expect(CHALLENGE_TYPES).toHaveLength(10);
    expect(signatures.size).toBe(CHALLENGE_TYPES.length);
  });

  it('clamps and paints real mission progress without text glyphs', () => {
    const view = render(
      <MissionInstrumentGlyph type="big_pots" state="complete" progress={140} size="lg" />
    );
    const instrument = view.container.querySelector('[data-mission-instrument]');
    const progressArc = view.container.querySelector('[class*="progressArc"]');

    expect(instrument).toHaveAttribute('data-state', 'complete');
    expect(instrument).toHaveAttribute('data-size', 'lg');
    expect(instrument).toHaveAttribute('data-progress', '100');
    expect(progressArc).toHaveAttribute('stroke-dasharray', '100 0');

    view.rerender(<MissionInstrumentGlyph type="big_pots" progress={Number.NaN} />);
    expect(view.container.querySelector('[data-mission-instrument]')).toHaveAttribute(
      'data-progress',
      '0'
    );
  });

  it('is decorative and leaves the challenge card text as the accessible description', () => {
    const { container } = render(<MissionInstrumentGlyph type="friends_added" />);
    const instrument = container.querySelector('[data-mission-instrument]');
    const svg = container.querySelector('svg');

    expect(instrument).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(container.querySelector('title, text')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('Daily Challenges instrument source contract', () => {
  it('uses CSS modules, layered physical materials, and no font or emoji glyphs', () => {
    expect(controlSource).toContain("import styles from './CasinoControlIcon.module.css'");
    expect(missionSource).toContain("import styles from './MissionInstrumentGlyph.module.css'");
    expect(controlSource).toContain('data-layer="metal-bezel"');
    expect(controlSource).toContain('data-layer="instrument-light"');
    expect(missionSource).toContain('data-layer="instrument-face"');
    expect(missionSource).toContain('data-layer="mission-mechanism"');
    expect(controlCss).toContain('conic-gradient(');
    expect(controlCss).toContain('radial-gradient(');
    expect(missionCss).toContain('drop-shadow(');
    expect(`${controlSource}${missionSource}`).not.toMatch(/<text\b|\\u[\da-f]{4}/i);
    expect(`${controlSource}${missionSource}`).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('ties motion to semantic state and supplies reduced-motion and forced-color fallbacks', () => {
    expect(controlCss).toContain("[data-state='pending'] .rotor");
    expect(controlCss).toContain("[data-state='success'] .lightSweep");
    expect(controlCss).toContain("[data-state='attention'][data-variant='alert-on']");
    expect(missionCss).toContain("[data-state='active'][data-mission-type='hands_played']");
    expect(missionCss).toContain("[data-state='complete'] .completionRay");
    expect(controlCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(missionCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(controlCss).toContain('@media (forced-colors: active)');
    expect(missionCss).toContain('@media (forced-colors: active)');
    expect(`${controlCss}${missionCss}`).not.toContain(':hover');
  });
});
