import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/pages/MarketplacePage.module.css', 'utf8');
const store = readFileSync('src/pages/marketplace/StoreTab.tsx', 'utf8');
const diamonds = readFileSync('src/pages/marketplace/DiamondsTab.tsx', 'utf8');

describe('Marketplace mobile-first visual contracts', () => {
  it('starts with one product column and expands at intentional breakpoints', () => {
    expect(css).toMatch(/\.itemGrid\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/@media \(min-width: 520px\)[\s\S]*?\.itemGrid[\s\S]*?repeat\(2/);
    expect(css).toMatch(/@media \(min-width: 1020px\)[\s\S]*?\.itemGrid[\s\S]*?repeat\(3/);
  });

  it('shows complete custom artwork instead of cropping it', () => {
    expect(css).toMatch(/\.itemCover\s*\{[\s\S]*?object-fit:\s*contain;/);
    expect(css).toMatch(/\.itemImg\s*\{[\s\S]*?object-fit:\s*contain;/);
  });

  it('uses a mobile bottom sheet, light-mode surfaces, and 44px controls', () => {
    expect(css).toMatch(/\.modalOverlay\s*\{[\s\S]*?align-items:\s*flex-end;/);
    expect(css).toContain(":global([data-theme='light']) .page");
    expect(css).toMatch(/\.btnPrimary,[\s\S]*?min-height:\s*44px;/);
  });

  it('keeps left and right merchandise badges in separate non-overlapping rails', () => {
    expect(store).toContain('styles.itemBadgesLeft');
    expect(store).toContain('styles.itemBadgesRight');
  });

  it('names the direct checkout action truthfully and keeps internal links in-app', () => {
    expect(diamonds).toContain("'Buy Securely'");
    expect(diamonds).not.toContain('Add to Cart');
    expect(diamonds).toContain('<Link key={link.href}');
  });
});
