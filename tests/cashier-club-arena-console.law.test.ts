import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * #ClubArenaConsole IS THE CASHIER'S VISUAL AUTHORITY (Dan, September 2026).
 *
 * Every Cashier page and every Cashier-owned dialog is rendered ON the approved
 * painted master through `SpadeConsole`, directly: no wrapper framework, no
 * retired vault picture, no flat `x` close glyph, no CSS-built frame, plate or
 * pill on the glass, no browser number spinner, and the console's own crest
 * (the spade, the one crest Dan approved). This file reads the source and the
 * stylesheets so a regression fails before it can be rendered.
 *
 * The retired Cashier-only wrapper (`CashierConsoleSurface`) was deleted on
 * 2026-09-22; a surface that reintroduces it, or any second console framework,
 * fails here.
 */

const read = (path: string) => readFileSync(path, 'utf8');

/** Every Cashier surface, paired with the stylesheet that dresses its glass. */
const CASHIER_SURFACES: ReadonlyArray<{ tsx: string; css: string; consoles: number }> = [
  {
    tsx: 'src/pages/CashierTradePage.tsx',
    css: 'src/pages/CashierTradePage.module.css',
    consoles: 5,
  },
  { tsx: 'src/pages/CashierPage.tsx', css: 'src/pages/CashierPage.module.css', consoles: 3 },
  {
    tsx: 'src/components/wallet/WalletCashierModal.tsx',
    css: 'src/components/wallet/WalletCashierModal.css',
    consoles: 2,
  },
  {
    tsx: 'src/components/wallet/PlayerWalletModal.tsx',
    css: 'src/components/wallet/WalletCashierModal.css',
    consoles: 1,
  },
  {
    tsx: 'src/components/wallet/CashoutRequestModal.tsx',
    css: 'src/components/wallet/CashoutRequestModal.css',
    consoles: 1,
  },
  {
    tsx: 'src/components/wallet/ChipMintModal.tsx',
    css: 'src/components/wallet/ChipMintModal.css',
    consoles: 1,
  },
  {
    tsx: 'src/components/table/CashierModal.tsx',
    css: 'src/components/table/CashierModal.css',
    consoles: 1,
  },
  {
    tsx: 'src/components/union/UnionWalletModal.tsx',
    css: 'src/components/union/UnionWalletModal.css',
    consoles: 1,
  },
];

const CASHIER_STYLESHEETS = [
  ...new Set(CASHIER_SURFACES.map((s) => s.css)),
  'src/components/club/CashierClubSwitcher.module.css',
];

/**
 * CashoutRequestModal.css still carries three legacy GLOBAL rules
 * (`.close-btn`, `.submit-btn` and the `.modal-header` block) that other,
 * non-Cashier components use without defining them. The Cashout console
 * renders none of those classes. They are pinned here by exact count so the
 * number of painted radii and gradients in a Cashier stylesheet can only fall.
 */
const LEGACY_GLOBAL_ALLOWANCE: Record<string, { radius: number; gradient: number }> = {
  'src/components/wallet/CashoutRequestModal.css': { radius: 2, gradient: 1 },
};

const count = (source: string, pattern: RegExp) => (source.match(pattern) ?? []).length;

/**
 * Every `<SpadeConsole` opening tag in a file, through the `>` that closes the
 * tag itself: a `>` inside a `{...}` prop expression (an arrow, a comparison)
 * belongs to the expression, so braces are tracked and only a bare `>` at
 * brace depth zero ends the tag.
 */
const consoleTags = (source: string): string[] => {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('<SpadeConsole', from);
    if (start < 0) return tags;
    let depth = 0;
    let end = -1;
    for (let i = start + '<SpadeConsole'.length; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0 && source[i - 1] !== '=') {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error(`unterminated <SpadeConsole at ${start}`);
    tags.push(source.slice(start, end + 1));
    from = end + 1;
  }
};

describe('#ClubArenaConsole is the Cashier visual authority', () => {
  it.each(CASHIER_SURFACES)(
    '$tsx renders $consoles console(s) directly on SpadeConsole',
    ({ tsx, consoles }) => {
      const source = read(tsx);
      expect(source).toMatch(
        /import \{[^}]*\bSpadeConsole\b[^}]*\} from '[^']*\/console\/SpadeConsole'/
      );
      expect(consoleTags(source)).toHaveLength(consoles);
    }
  );

  it('never reintroduces a second console framework, the vault picture or a flat close glyph', () => {
    for (const { tsx } of CASHIER_SURFACES) {
      const source = read(tsx);
      expect(source, tsx).not.toContain('CashierConsoleSurface');
      expect(source, tsx).not.toContain('cashier-vault-hero');
      expect(source, tsx).not.toContain('&times;');
      expect(source, tsx).not.toContain('>×<');
      expect(source, tsx).not.toMatch(/[◆▾▸►✓]/);
    }
  });

  it('keeps every Cashier console on the approved crest', () => {
    // Dan 2026-09-13: the spade is the only crest that passed; the club, diamond
    // and crown crests are to be repainted. Until they are, the Cashier prints
    // on the console's default crest and never asks for one of the rejected ones.
    for (const { tsx } of CASHIER_SURFACES) {
      for (const tag of consoleTags(read(tsx))) {
        expect(tag, tsx).not.toMatch(/\bcrest=/);
      }
    }
  });

  it('gives every routed page console its legacy-flattening class, dialogs included', () => {
    for (const tsx of ['src/pages/CashierTradePage.tsx', 'src/pages/CashierPage.tsx']) {
      for (const tag of consoleTags(read(tsx))) {
        expect(tag, tsx).toContain('className={styles.console}');
      }
    }
  });

  it('fills both plates or prints a single word control, never an empty plate', () => {
    for (const { tsx } of CASHIER_SURFACES) {
      for (const tag of consoleTags(read(tsx))) {
        if (/foot=["']plates["']/.test(tag) || /\bplates=\{/.test(tag)) {
          expect(tag, tsx).toMatch(/\bsecondary\b/);
          expect(tag, tsx).toMatch(/\bprimary\b/);
        }
      }
    }
  });

  it('suppresses the browser number spinner wherever a Cashier surface takes a number', () => {
    for (const { tsx, css } of CASHIER_SURFACES) {
      if (!read(tsx).includes('type="number"')) continue;
      expect(read(css), `${css} for ${tsx}`).toContain('::-webkit-inner-spin-button');
      expect(read(css), `${css} for ${tsx}`).toMatch(/appearance:\s*textfield/);
    }
  });

  it('paints no frame, pill or plate in CSS on the Cashier glass', () => {
    for (const css of CASHIER_STYLESHEETS) {
      const source = read(css);
      const allowance = LEGACY_GLOBAL_ALLOWANCE[css] ?? { radius: 0, gradient: 0 };
      expect(count(source, /border-radius:\s*[1-9]/g), css).toBe(allowance.radius);
      expect(count(source, /(linear|radial|conic)-gradient\(/g), css).toBe(allowance.gradient);
      expect(source, css).not.toMatch(/^\s*[^*\n]*:hover\b[^\n]*\{/m);
    }
  });

  it('does not flatten the master rails while flattening legacy content', () => {
    const tradeCss = read('src/pages/CashierTradePage.module.css');
    const classicCss = read('src/pages/CashierPage.module.css');
    expect(tradeCss).toContain(':not(:global(.sc__head))');
    expect(tradeCss).toContain(':global(.sc__body)');
    expect(classicCss).toContain(':global(.sc__foot)');
    for (const css of [tradeCss, classicCss]) {
      expect(css).toMatch(/:where\(button:not\(:global\(\.sc-plate\)\)/);
    }
  });

  it('keeps both routed Cashier pages behind the console authority', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('path="clubs/:clubId/cashier"');
    expect(app).toContain('path="clubs/:clubId/cashier-classic"');
    expect(read('src/pages/CashierTradePage.tsx')).toContain('title="Cashier"');
    expect(read('src/pages/CashierPage.tsx')).toContain('title="Cashier"');
  });

  it('puts every Trade Cashier dialog on the painted authority', () => {
    const trade = read('src/pages/CashierTradePage.tsx');
    for (const title of ['Transaction Receipt', 'Request Chips', 'Send Out', 'Claim Back']) {
      expect(trade).toContain(title);
    }
  });

  it('prints painted head zones through compactChips, never a raw locale figure', () => {
    for (const { tsx } of CASHIER_SURFACES) {
      for (const tag of consoleTags(read(tsx))) {
        for (const zone of ['eyebrow', 'subtitle', 'pill']) {
          const value = tag.match(new RegExp(`\\b${zone}=\\{([^}]*)\\}`))?.[1] ?? '';
          expect(value, `${tsx} ${zone}`).not.toMatch(/toLocaleString|toFixed/);
        }
      }
    }
  });
});
