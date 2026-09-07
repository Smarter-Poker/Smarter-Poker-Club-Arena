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

/* THE SPEED EXPRESSION (2026-09-05). Every duration multiplies by this, not
   by --animation-speed directly. A server-paced profile writes --rs-speed
   (clamped to <= 1) on the host; everything else falls through to the
   player's own setting. It used to be a bare `var(--animation-speed, 1)` and
   the clamp was applied by REDEFINING --animation-speed in terms of itself,
   which is a self-reference: invalid at computed-value time, measured empty
   in Chromium, so the clamp never ran. See squeezeVars in SqueezeCard.tsx. */
const SPEED = 'var(--rs-speed, var(--animation-speed, 1))';

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

/** Prettier wraps long shorthands, so pins compare on collapsed whitespace. */
const flat = (t: string) => t.replace(/\s+/g, ' ').trim();

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
    expect(flat(r)).toContain(`ccCardMaterialize calc(var(--rs-prepare, 0.05s) * ${SPEED})`);
    expect(flat(r)).toContain(`animation-delay: calc(var(--rs-stagger, 0s) * ${SPEED})`);
    expect(keyframeBody(squeezeCode, 'ccCardMaterialize')).not.toMatch(/translate/);
  });

  it('the flip, the spine and the shadow all start at prepare + hold + stagger', () => {
    for (const sel of ['.card-squeeze', '.card-squeeze__spine', '.card-squeeze__shadow']) {
      const r = rule(squeezeCode, sel);
      expect(r, sel).toMatch(
        /var\(--rs-prepare, 0\.05s\) \+ var\(--rs-hold, 0s\) \+ var\(--rs-stagger, 0s\)/
      );
      expect(flat(r), sel).toContain(`var(--rs-flip, 0.25s) * ${SPEED}`);
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

  it('reduced motion SWAPS the mechanism rather than deleting the reveal', () => {
    // web.dev's own global override uses a 1ms duration rather than
    // `animation: none`, "as some websites depend on an animation to be run
    // in order to work correctly"; MDN's worked example swaps a scale pulse
    // for an opacity dissolve. So: no rotation, no edge, no overshoot - the
    // card cross-fades to its face, and every completion beat still fires.
    const rm = squeezeCode.slice(squeezeCode.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm).toContain('ccCardCrossFade');
    expect(rm).toContain('.card-squeeze-host.card-squeeze-host');
    expect(rm).toContain('.card-squeeze__spine');
    expect(rm).toContain('.card-squeeze__shadow');
    // the resting state is still FACE UP, whichever path ran
    expect(rm).toContain('transform: rotateY(180deg)');
    expect(rule(squeezeCode, '.card-squeeze')).toContain('transform: rotateY(180deg)');
    // and the reveal is opacity only - no movement at all
    const kf = keyframeBody(squeezeCode, 'ccCardCrossFade');
    expect(kf).not.toMatch(/transform|rotate|scale/);
  });

  it('will-change promotes ONE element, and only while it is turning', () => {
    // MDN: "last resort", "excessive use ... excessive memory", "switch it on
    // and off using script code before and after the change", and it applies
    // to the whole subtree. It used to sit in the stylesheet on four elements
    // per card, for the entire mount window.
    const promoted = [...squeezeCode.matchAll(/will-change/g)];
    expect(promoted).toHaveLength(1);
    expect(squeezeCode).toContain(".card-squeeze-host[data-rs-animating='on'] .card-squeeze {");
    // the component has to actually turn it off
    expect(tsx).toContain('setAnimating(false)');
    expect(squeezeCard).toContain("'data-rs-animating': animating ? 'on' : 'off'");
  });

  it('the host class is doubled so a foreign overflow:hidden cannot flatten the flip', () => {
    expect(squeezeCode).toContain('.card-squeeze-host.card-squeeze-host {');
    expect(rule(squeezeCode, '.card-squeeze-host.card-squeeze-host')).toContain(
      'overflow: visible'
    );
  });
});

describe('the reserved slot (spec 11)', () => {
  it('draws nothing and reserves nothing - the board centres on the cards that are out', () => {
    /* Dan 2026-09-07, item 11: "THEY USED TO START OFF CENTER ON THE FLOP, AND
       SHIFT LEFT AS THE TURN AND RIVER CAME OUT, NOW THEY ARE JUST STARTING
       ALL TO THE LEFT." The 2026-09-04 reserve held a card's WIDTH so the
       board was always five positions wide, which puts a flop in the left
       three of them — a full card left of the felt's centreline.

       The width is a variable now, defaulting to zero, so the row centres on
       the dealt cards and drifts left as each new one lands. The rest of the
       rule is unchanged and still load-bearing: the slot must still DRAW
       nothing (the ghost outlines stay gone) and still hold the row's height,
       so an empty board does not collapse. */
    const r = rule(boardCode, '.community-cards__slot-reserve');
    expect(r).toContain('visibility: hidden');
    expect(r).toContain('width: var(--cc-slide-reserve, 0px)');
    expect(r).toContain('height: var(--cc-card-h)');
    expect(rule(boardCode, '.community-cards')).toContain('--cc-slide-reserve: 0px');
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
