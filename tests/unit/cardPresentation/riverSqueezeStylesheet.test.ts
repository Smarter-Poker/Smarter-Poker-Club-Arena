/**
 * RIVER SQUEEZE 2026-09-04 / ROUND 2 2026-09-05 — source-shape pins on the
 * shared squeeze stylesheet and the board, in the style of
 * tests/animations-always-play.law.test.ts: every duration scales with
 * --animation-speed, the JS window outlives the CSS, the retired animations
 * stay retired, and the reserved slot draws nothing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const squeezeCss = read('src/presentation/cardPresentation/cardSqueeze.css');
const squeezeCode = stripComments(squeezeCss);
const boardCss = read('src/components/table/CommunityCards.css');
const boardCode = stripComments(boardCss);
const tsx = read('src/components/table/CommunityCards.tsx');
const squeezeCard = read('src/presentation/cardPresentation/SqueezeCard.tsx');
const tablePageCss = stripComments(read('src/pages/TablePage.css'));

function rule(css: string, selector: string): string {
  const i = css.indexOf(selector + ' {');
  expect(i, `rule ${selector}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
}

function keyframeBody(css: string, name: string): string {
  const i = css.indexOf(`@keyframes ${name}`);
  expect(i, `@keyframes ${name}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('\n}\n', i));
}

describe('the squeeze is compositor-only and speed-scaled', () => {
  it('the card materialises in place, scaled by --animation-speed, no travel (spec 69)', () => {
    const r = rule(squeezeCode, '.card-squeeze-host.card-squeeze-host');
    expect(r).toContain(
      'ccCardMaterialize calc(var(--rs-prepare, 0.08s) * var(--animation-speed, 1))'
    );
    expect(r).toContain('animation-delay: calc(var(--rs-stagger, 0s) * var(--animation-speed, 1))');
    expect(keyframeBody(squeezeCode, 'ccCardMaterialize')).not.toMatch(/translate/);
  });

  it('the flip, the spine and the shadow all start at prepare + hold + stagger', () => {
    for (const sel of ['.card-squeeze', '.card-squeeze__spine', '.card-squeeze__shadow']) {
      const r = rule(squeezeCode, sel);
      expect(r, sel).toMatch(
        /var\(--rs-prepare, 0\.08s\) \+ var\(--rs-hold, 0s\) \+ var\(--rs-stagger, 0s\)/
      );
      expect(r, sel).toContain('var(--rs-flip, 0.48s) * var(--animation-speed, 1)');
    }
    expect(rule(squeezeCode, '.card-squeeze')).toContain('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(rule(squeezeCode, '.card-squeeze')).not.toContain('linear');
  });

  it('only transform and opacity are animated - never a layout property (spec 43)', () => {
    for (const name of ['ccCardMaterialize', 'ccCardSqueeze', 'ccCardSpine', 'ccCardShadow']) {
      expect(keyframeBody(squeezeCode, name), name).not.toMatch(
        /\b(width|height|top|left|margin|padding|border-width|filter|box-shadow)\s*:/
      );
    }
  });

  it('the spine appears at the edge-on instant and nowhere else (spec 73)', () => {
    const spine = rule(squeezeCode, '.card-squeeze__spine');
    expect(spine).toContain('opacity: 0');
    expect(spine).toContain('width: 2px');
    const body = keyframeBody(squeezeCode, 'ccCardSpine');
    // Invisible until the squeeze is nearly edge-on, full AT the swap, gone
    // again as the face widens.
    expect(body).toMatch(/0%,\s*28% \{\s*opacity: 0;/);
    expect(body).toMatch(/37\.5% \{\s*opacity: 1;/);
    expect(body).toMatch(/47%,\s*100% \{\s*opacity: 0;/);
  });

  it('the shadow thins by OPACITY, so no blur radius ever changes (spec 72)', () => {
    expect(rule(squeezeCode, '.card-squeeze__shadow')).toContain('box-shadow: var(--rs-shadow)');
    const body = keyframeBody(squeezeCode, 'ccCardShadow');
    expect(body).toMatch(/37\.5% \{\s*opacity: 0\.3;/);
    expect(body).not.toMatch(/box-shadow/);
  });

  it('colours come from theme tokens, never hard-coded in the keyframes (spec 51, 53)', () => {
    expect(rule(squeezeCode, '.card-squeeze__spine')).toContain('var(--rs-edge');
    expect(squeezeCode).toContain('--rs-edge:');
    expect(squeezeCode).toContain('--rs-shadow:');
  });

  it('no screen shake, no flash: the old river and turn reveals are gone (spec 23)', () => {
    for (const gone of [
      'ccRiverReveal',
      'ccTurnReveal',
      '--cc-river-duration',
      '--cc-turn-duration',
      'card--slow-reveal',
      'brightness(1.4)',
    ]) {
      expect(boardCode, gone).not.toContain(gone);
    }
    expect(squeezeCode).not.toContain('brightness(');
    // the all-in !important overrides that would clobber the profile are gone
    expect(tablePageCss).not.toMatch(/allin-mode \.community-cards__card--(river|turn)/);
  });

  it('reduced motion collapses the squeeze; resting state is face up (10.6)', () => {
    const rm = squeezeCode.slice(squeezeCode.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const sel of [
      '.card-squeeze-host',
      '.card-squeeze,',
      '.card-squeeze__spine',
      '.card-squeeze__shadow',
    ]) {
      expect(rm, sel).toContain(sel);
    }
    expect(rm).toContain('transform: rotateY(180deg)');
    expect(rule(squeezeCode, '.card-squeeze')).toContain('transform: rotateY(180deg)');
  });

  it('the host class is doubled so a foreign overflow:hidden cannot flatten the flip', () => {
    expect(squeezeCode).toContain('.card-squeeze-host.card-squeeze-host {');
    expect(rule(squeezeCode, '.card-squeeze-host.card-squeeze-host')).toContain(
      'overflow: visible'
    );
  });
});

describe('the reserved slot (spec 11)', () => {
  it('keeps geometry and draws nothing - the ghost outlines stay gone', () => {
    const r = rule(boardCode, '.community-cards__slot-reserve');
    expect(r).toContain('visibility: hidden');
    expect(r).toContain('width: var(--cc-card-w)');
    expect(r).not.toMatch(/border|outline|background/);
    expect(boardCode).not.toContain('.community-cards__placeholder');
    expect(tablePageCss).toMatch(
      /\.table-surface \.community-cards__card,\s*\.table-surface \.community-cards__slot-reserve \{/
    );
    expect(tsx).toMatch(/className="community-cards__slot-reserve"\s+aria-hidden="true"/);
  });
});

describe('the component obeys the engine and the law', () => {
  it('asks the engine before animating a river OR a turn', () => {
    expect(tsx).toContain("const squeezes = street === 'river' || street === 'turn';");
    expect(tsx).toContain('cardPresentationEngine.presentCard(');
    expect(tsx).toContain("if (result.status === 'started') {");
    // a duplicate / stale / instant answer removes the slot from the newly-dealt set
    expect(tsx).toContain('newIndices.delete(slot);');
  });

  it('the JS mount window is scaled by getAnimationSpeed and outlives the profile', () => {
    expect(tsx).toContain('const speed = getAnimationSpeed();');
    expect(tsx).toContain('windowMs = Math.max(windowMs, Math.round(result.durationMs * speed));');
  });

  it('the profile reaches the stylesheet ONLY through the shared inline bridge', () => {
    for (const v of ['--rs-prepare', '--rs-hold', '--rs-flip', '--rs-overshoot', '--rs-stagger']) {
      expect(squeezeCard, v).toContain(`'${v}'`);
    }
    // the board no longer writes them itself - one bridge, shared with replay
    expect(tsx).toContain('squeezeHostProps(');
    expect(tsx).not.toContain("'--rs-flip'");
    // no duration literal for the squeeze anywhere in the component
    expect(tsx).not.toMatch(/1800/);
  });

  it('the snap is OWED at the street and PAID at the reveal beat', () => {
    expect(tsx).toContain('snapOwedRef');
    expect(tsx).toContain('pendingRevealKeyRef');
    expect(tsx).toContain('cardPresentationEngine.subscribe(');
    // cancelled and complete pay it too: a card that appears in silence is
    // the cue being dropped (CLAUDE.md 10.6).
    expect(tsx).toMatch(/phase !== 'reveal' && phase !== 'cancelled' && phase !== 'complete'/);
    expect(tsx).toContain('if (!pendingRevealKeyRef.current) payStreetSnap();');
  });

  it('interrupts render the authoritative board (spec 66): new hand, hidden, unmount', () => {
    expect(tsx).toContain("cancelActiveSqueeze('new-hand')");
    expect(tsx).toContain("cancelActiveSqueeze('hidden')");
    expect(tsx).toContain("cancelActiveSqueeze('unmount')");
  });

  it('never reads game state: the engine module imports nothing from stores or services', () => {
    const dir = path.join(ROOT, 'src/presentation/cardPresentation');
    for (const f of fs.readdirSync(dir)) {
      if (!/\.tsx?$/.test(f)) continue;
      const src = read(path.join('src/presentation/cardPresentation', f));
      expect(src, f).not.toMatch(/from '.*\/(stores|services|supabase|engine)\//);
      expect(src, f).not.toMatch(
        /postBlind|advanceTournament|calculatePot|updateStack|matchPlayer/
      );
    }
  });
});
