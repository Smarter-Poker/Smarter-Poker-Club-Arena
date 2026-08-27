/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  GAMEPLAY WEARS THE HOUSE COLOURS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-27: "GAME PLAY MUST LOOK LIKE THE CLUB ARENA".
 *
 * It did not, and no amount of care was going to keep it that way, because the
 * scheme was never written down anywhere a machine could read it. What existed
 * instead was a series of hand sweeps, each one finding "the last" stragglers:
 * #1365 swept "the last three legacy greens" in RunItTwice.css. There were 133
 * more, in 36 different shades, across the rest of the table.
 *
 * THE ROOT CAUSE WAS NOT CARELESSNESS, IT WAS THREE TOKENS.
 *   --success-green  #00d26a   (club-engine.css, 13 consumers)
 *   --success        #31a24c   (globals.css, 20 consumers)
 *   the house green  #3fb950   (Dan's, 47 literals and no token at all)
 * Three semantic "success" greens, all live, none aware of the others. Sweeping
 * literals could never converge while the tokens themselves disagreed.
 *
 * All three are #3fb950 now, and this test is the thing that keeps them there.
 *
 * WHAT IS AND IS NOT A HOUSE GREEN
 * The rule is about SEMANTIC colour - success, profit, win, active, online,
 * check/call/raise. Those are brand. Four other kinds of green are not brand and
 * are deliberately exempt, each one listed below with the file it lives in:
 *   - card suit greens (four-colour deck readability convention)
 *   - casino chip denomination greens (a 25-chip is green everywhere on earth)
 *   - felt, card-back and button skins the user picks from a gallery
 *   - celebration/particle art palettes, and one third-party brand (WhatsApp)
 *
 * Adding a green to the allowlist is a deliberate act with a reason attached.
 * That is the whole point: the next person cannot add a 37th shade by accident.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The smarter.poker scheme green, and the light/dark it ramps to. */
const HOUSE = '#3fb950';
const HOUSE_LIGHT = '#4dc660';
const HOUSE_DARK = '#2ea043';
const HOUSE_FAMILY = new Set([HOUSE, HOUSE_LIGHT, HOUSE_DARK]);

/**
 * Greens that are NOT brand colour. Each entry names the only file allowed to
 * carry it and why it is not a house green.
 */
const EXEMPT: Record<string, { files: string[]; why: string }> = {
  '#22c55e': {
    files: [
      'src/components/table/CardImage.tsx',
      'src/components/table/TableTabBar.css',
      'src/components/table/ChipAnimation.module.css',
      'src/components/table/ConfettiCanvas.tsx',
      'src/components/table/ParticleSystem.tsx',
    ],
    why: 'clubs in the four-colour deck (CardImage SUIT_COLOR is the source of truth), the 25-chip, and confetti art',
  },
  '#15803d': {
    files: ['src/components/table/ChipAnimation.module.css'],
    why: 'the dark half of the 25-chip gradient',
  },
  '#66bb6a': {
    files: [
      'src/components/table/ThrowableSelector.css',
      'src/components/table/ThrowableSignatures.css',
    ],
    why: 'throwable-item artwork (sports category, cash stack)',
  },
  '#a5d6a7': {
    files: ['src/components/table/ThrowableSignatures.css'],
    why: 'cash-stack throwable artwork',
  },
  '#76ff03': {
    files: ['src/components/table/ThrowableSignatures.css'],
    why: 'throwable artwork (lime flare)',
  },
  '#69f0ae': {
    files: ['src/components/table/ThrowableSignatures.css'],
    why: 'throwable artwork (mint flare)',
  },
  '#8bc34a': {
    files: ['src/components/table/ThrowableSignatures.css'],
    why: 'throwable artwork (leaf)',
  },
  '#25d366': {
    files: ['src/components/table/ShareHand.css'],
    why: "WhatsApp's own brand green on its share button",
  },
  '#00ff9f': {
    files: ['src/components/table/CardImage.css', 'src/pages/TablePage.css'],
    why: 'the neon card-back skin the user picks from the gallery',
  },
  '#1d5b3a': {
    files: ['src/components/table/ThemeSettingsModal.css'],
    why: 'the felt-coloured stage the theme gallery previews assets against',
  },
  '#33691e': {
    files: ['src/components/table/ThemeSettingsModal.tsx', 'src/pages/TablePage.css'],
    why: 'the sports-themed dealer button skin',
  },
  '#558b2f': {
    files: ['src/components/table/ThemeSettingsModal.tsx', 'src/pages/TablePage.css'],
    why: 'the sports-themed dealer button skin',
  },
  '#58ad7b': { files: ['src/pages/TablePage.css'], why: 'the jade-seal button skin' },
  '#1b5e20': {
    files: [
      'src/components/table/ThemeSettingsModal.tsx',
      'src/components/table/ThrowableSignatures.css',
    ],
    why: 'theme gallery swatch, and the deep stop of a throwable gradient',
  },
  '#2e7d32': {
    files: ['src/components/table/ThemeSettingsModal.tsx'],
    why: 'theme gallery swatch',
  },
  '#a7e5c2': {
    files: ['src/components/table/ThemeSettingsModal.tsx'],
    why: 'theme gallery swatch',
  },
  '#176344': {
    files: ['src/components/table/ThemeSettingsModal.tsx'],
    why: 'theme gallery swatch',
  },
  '#96ceb4': {
    files: ['src/components/table/BBJCelebration.tsx'],
    why: 'jackpot celebration confetti palette',
  },
  '#27ae60': {
    files: ['src/components/table/ParticleSystem.tsx'],
    why: 'the chip-spray particle palette',
  },
};

/** Every file the player looks at while a hand is being played. */
function gameplayFiles(): string[] {
  const dir = 'src/components/table';
  const out = readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.css') || f.endsWith('.tsx'))
    .map((f) => `${dir}/${f}`);
  out.push('src/pages/TablePage.css');
  return out.sort();
}

/**
 * Comments are stripped before matching. Several of these files deliberately
 * quote the shade they replaced so the next reader knows what not to put back;
 * a test that failed on its own explanation would teach people to delete the
 * explanation.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function isGreen(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return g > r + 25 && g > b + 25 && g > 70;
}

describe('the semantic green tokens all resolve to the house green', () => {
  it('--success-green, --success and --color-success are one colour', () => {
    // These three were #00d26a, #31a24c and #22c55e. Any of them drifting off
    // the house green re-splits the scheme across ~35 consumers at once, which
    // is more damage than any single literal can do.
    expect(read('src/styles/club-engine.css')).toMatch(new RegExp(`--success-green:\\s*${HOUSE};`));
    expect(read('src/styles/globals.css')).toMatch(new RegExp(`--success:\\s*${HOUSE};`));
    expect(read('src/styles/design-tokens.css')).toMatch(
      new RegExp(`--color-success:\\s*${HOUSE};`)
    );
  });

  it('their glow and dim variants are the same colour at lower alpha', () => {
    // rgb(63, 185, 80) is #3fb950. A glow left on the old rgb halos the new
    // green in the old one, which reads as a rendering bug rather than a
    // colour choice.
    for (const f of ['src/styles/club-engine.css', 'src/styles/globals.css']) {
      const src = read(f);
      const glows = src.match(/--success[a-z-]*-(glow|dim):\s*rgba\(([^)]+)\)/g) || [];
      expect(glows.length).toBeGreaterThan(0);
      for (const g of glows) expect(g).toMatch(/rgba\(63,\s*185,\s*80,/);
    }
  });

  it('the stack-healthy ladder uses the house green for a normal stack', () => {
    expect(read('src/styles/design-tokens.css')).toMatch(
      new RegExp(`--stack-normal:\\s*${HOUSE};`)
    );
  });
});

describe('every green on the felt is the house green or a listed exception', () => {
  const files = gameplayFiles();

  it('finds gameplay files to check at all', () => {
    // A rename that emptied this list would turn the whole suite into a
    // no-op that still passed.
    expect(files.length).toBeGreaterThan(60);
  });

  it('carries no unapproved shade of green', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = codeOnly(read(f));
      const seen = new Set<string>();
      for (const m of src.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
        const hex = m[0].toLowerCase();
        if (!isGreen(hex) || HOUSE_FAMILY.has(hex) || seen.has(hex)) continue;
        seen.add(hex);
        const exempt = EXEMPT[hex];
        if (!exempt || !exempt.files.includes(f)) {
          offenders.push(`${f} uses ${hex}`);
        }
      }
    }
    expect(
      offenders,
      `Unapproved greens on the gameplay surface. Use ${HOUSE} (light ${HOUSE_LIGHT}, ` +
        `dark ${HOUSE_DARK}) for anything semantic - success, profit, win, active, ` +
        `online, check/call/raise. If this really is artwork, a card suit, a chip ` +
        `denomination or a user-selectable skin, add it to EXEMPT in this file with ` +
        `the reason.\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('carries no unapproved green rgba() either', () => {
    // A colour laundered through rgba() is the same colour. Both sweeps before
    // this one missed the glows and left the old green haloing the new one.
    const ALLOWED_RGB = new Set(['63,185,80', '77,198,96', '46,160,67']);
    const offenders: string[] = [];
    for (const f of files) {
      const src = codeOnly(read(f));
      for (const m of src.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*[,)]/g)) {
        const [r, g, b] = [+m[1], +m[2], +m[3]];
        if (!(g > r + 25 && g > b + 25 && g > 70)) continue;
        const key = `${r},${g},${b}`;
        if (ALLOWED_RGB.has(key)) continue;
        const hex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
        const exempt = EXEMPT[hex];
        if (!exempt || !exempt.files.includes(f)) offenders.push(`${f} uses rgb(${key})`);
      }
    }
    expect(
      offenders,
      `Unapproved green rgba() on the gameplay surface. The house green is ` +
        `rgba(63, 185, 80, a).\n  ${[...new Set(offenders)].join('\n  ')}`
    ).toEqual([]);
  });
});

describe('the four-colour deck agrees with itself', () => {
  // The tab bar draws a mini preview of the same cards the felt is holding.
  // All four suits had drifted to a second shade, so a card was one colour in
  // the preview and another in the hand it previewed.
  const CARD_IMAGE = read('src/components/table/CardImage.tsx');
  const TAB_BAR = read('src/components/table/TableTabBar.css');

  const canonical: Record<string, string> = {
    s: '#1e293b',
    h: '#ef4444',
    d: '#3b82f6',
    c: '#22c55e',
  };

  it('CardImage remains the source of truth for suit colour', () => {
    for (const [suit, hex] of Object.entries(canonical)) {
      expect(CARD_IMAGE).toMatch(new RegExp(`${suit}:\\s*'${hex}'`));
    }
  });

  it('the tab bar mini-cards paint the same four colours', () => {
    for (const [suit, hex] of Object.entries(canonical)) {
      expect(TAB_BAR).toMatch(new RegExp(`mini-card--${suit}\\s*\\{\\s*color:\\s*${hex};`, 'i'));
    }
  });
});

describe('the action buttons ramp through the house family', () => {
  const PANEL = codeOnly(read('src/components/table/ActionPanel.css'));

  it('raise and all-in use the house light/base/dark ramp', () => {
    // Green on these two is Dan's call (item 8). WHICH green was not: they
    // ramped #34d374 -> #16a34a -> #0b5426, a shade that appeared nowhere else
    // in the product, on the control the player looks at most.
    const ramp = `linear-gradient(180deg, ${HOUSE_LIGHT} 0%, ${HOUSE} 40%, ${HOUSE_DARK} 100%)`;
    const count = PANEL.split(ramp).length - 1;
    expect(count).toBe(2);
  });

  it('check and call stay blue', () => {
    // The blue/green split is the whole point of item 8 - it is how a player
    // tells a passive action from an aggressive one without reading.
    expect(PANEL).toMatch(/action-btn--call\s*\{[\s\S]{0,120}#1587f8/);
    expect(PANEL).not.toMatch(/action-btn--call\s*\{[\s\S]{0,120}#3fb950/);
  });
});
