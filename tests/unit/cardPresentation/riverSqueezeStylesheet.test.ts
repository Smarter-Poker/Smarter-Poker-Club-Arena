/**
 * RIVER SQUEEZE 2026-09-04 — source-shape pins on the stylesheet and the
 * component, in the style of tests/animations-always-play.law.test.ts:
 * every duration scales with --animation-speed, the JS window outlives the
 * CSS, the retired animations stay retired, and the reserved slot draws
 * nothing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = read('src/components/table/CommunityCards.css');
const cssCode = stripComments(css);
const tsx = read('src/components/table/CommunityCards.tsx');
const tablePageCss = stripComments(read('src/pages/TablePage.css'));

function rule(selector: string): string {
  const i = cssCode.indexOf(selector + ' {');
  expect(i, `rule ${selector}`).toBeGreaterThan(-1);
  return cssCode.slice(i, cssCode.indexOf('}', i));
}

describe('the squeeze is compositor-only and speed-scaled', () => {
  it('the card materialises in place, scaled by --animation-speed, no travel (spec 69)', () => {
    const r = rule('.community-cards__card--squeeze');
    expect(r).toContain(
      'ccRiverMaterialize calc(var(--rs-prepare, 0.08s) * var(--animation-speed, 1))'
    );
    expect(r).toContain('animation-delay: calc(var(--rs-stagger, 0s) * var(--animation-speed, 1))');
    const kf = cssCode.slice(cssCode.indexOf('@keyframes ccRiverMaterialize'));
    const body = kf.slice(0, kf.indexOf('\n}\n'));
    expect(body).not.toMatch(/translate/);
  });

  it('the flip runs on the two-surface markup, delayed by prepare + hold + stagger', () => {
    const r = rule('.community-cards__card--squeeze .community-cards__flip');
    expect(r).toContain('ccRiverSqueeze calc(var(--rs-flip, 0.48s) * var(--animation-speed, 1))');
    expect(r).toMatch(
      /var\(--rs-prepare, 0\.08s\) \+ var\(--rs-hold, 0s\) \+ var\(--rs-stagger, 0s\)/
    );
    expect(r).toContain('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(r).not.toContain('linear');
  });

  it('only transform and opacity are animated - never a layout property (spec 43)', () => {
    for (const name of ['ccRiverMaterialize', 'ccRiverSqueeze']) {
      const kf = cssCode.slice(cssCode.indexOf(`@keyframes ${name}`));
      const body = kf.slice(0, kf.indexOf('\n}\n'));
      expect(body).not.toMatch(
        /\b(width|height|top|left|margin|padding|border-width|filter|box-shadow)\s*:/
      );
    }
  });

  it('no screen shake, no flash: the old brightness-1.4 river is gone (spec 23)', () => {
    expect(cssCode).not.toContain('ccRiverReveal');
    expect(cssCode).not.toContain('--cc-river-duration');
    expect(cssCode).not.toContain('brightness(1.4)');
    expect(cssCode).not.toContain('card--slow-reveal');
    // the all-in !important overrides that would clobber the profile are gone
    expect(tablePageCss).not.toMatch(/allin-mode \.community-cards__card--(river|turn)/);
  });

  it('reduced motion collapses the squeeze; resting state is face up (10.6)', () => {
    const rm = cssCode.slice(cssCode.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm).toContain('.community-cards__card--squeeze,');
    expect(rm).toContain('.community-cards__card--squeeze .community-cards__flip,');
    expect(rule('.community-cards__flip')).toContain('transform: rotateY(180deg)');
  });
});

describe('the reserved slot (spec 11)', () => {
  it('keeps geometry and draws nothing - the ghost outlines stay gone', () => {
    const r = rule('.community-cards__slot-reserve');
    expect(r).toContain('visibility: hidden');
    expect(r).toContain('width: var(--cc-card-w)');
    expect(r).not.toMatch(/border|outline|background/);
    expect(cssCode).not.toContain('.community-cards__placeholder');
    expect(tablePageCss).toMatch(
      /\.table-surface \.community-cards__card,\s*\.table-surface \.community-cards__slot-reserve \{/
    );
    expect(tsx).toMatch(/className="community-cards__slot-reserve"\s+aria-hidden="true"/);
  });
});

describe('the component obeys the engine and the law', () => {
  it('asks the engine before animating a river or an all-in turn', () => {
    expect(tsx).toContain(
      "const squeezes = street === 'river' || (street === 'turn' && slowReveal);"
    );
    expect(tsx).toContain('cardPresentationEngine.presentCard(');
    expect(tsx).toContain("if (result.status === 'started') {");
    // a duplicate / stale / instant answer removes the slot from the newly-dealt set
    expect(tsx).toContain('newIndices.delete(slot);');
  });

  it('the JS mount window is scaled by getAnimationSpeed and outlives the profile', () => {
    expect(tsx).toContain('const speed = getAnimationSpeed();');
    expect(tsx).toContain('windowMs = Math.max(windowMs, Math.round(result.durationMs * speed));');
  });

  it('the profile reaches the stylesheet ONLY through inline --rs-* properties', () => {
    for (const v of ['--rs-prepare', '--rs-hold', '--rs-flip', '--rs-overshoot', '--rs-stagger']) {
      expect(tsx).toContain(`'${v}'`);
    }
    // no duration literal for the squeeze anywhere in the component
    expect(tsx).not.toMatch(/1800/);
  });

  it('interrupts render the authoritative board (spec 66): new hand, hidden, unmount', () => {
    expect(tsx).toContain("cancelActiveSqueeze('new-hand')");
    expect(tsx).toContain("cancelActiveSqueeze('hidden')");
    expect(tsx).toContain("cancelActiveSqueeze('unmount')");
  });

  it('never reads game state: the engine module imports nothing from stores or services', () => {
    const dir = path.join(ROOT, 'src/presentation/cardPresentation');
    for (const f of fs.readdirSync(dir)) {
      const src = read(path.join('src/presentation/cardPresentation', f));
      expect(src, f).not.toMatch(/from '.*\/(stores|services|supabase|engine)\//);
      expect(src, f).not.toMatch(
        /postBlind|advanceTournament|calculatePot|updateStack|matchPlayer/
      );
    }
  });
});
