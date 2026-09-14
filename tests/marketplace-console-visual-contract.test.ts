import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path));
const text = (path: string) => read(path).toString('utf8');

describe('Marketplace Console Visual Contract', () => {
  it('does not ship rejected destination or VIP master panels', () => {
    expect(existsSync(resolve(root, 'public/assets/marketplace/console-v1'))).toBe(false);

    const sources = [
      text('src/pages/MarketplacePage.tsx'),
      text('src/pages/marketplace/StoreTab.tsx'),
      text('src/pages/marketplace/DiamondsTab.tsx'),
      text('src/pages/marketplace/MembershipTab.tsx'),
      text('src/pages/marketplace/ItemArt.tsx'),
    ].join('\n');

    expect(sources).not.toContain('console-v1');
    expect(sources).not.toContain('vip-monthly.png');
    expect(sources).not.toContain('vip-yearly.png');
    expect(sources).not.toContain('vip-lifetime.png');
    expect(sources).not.toContain('diamond-packages.webp');
    expect(sources).not.toContain('product-atlas.webp');
  });

  it('keeps the established gold VIP card untouched and plan details live', () => {
    const membership = text('src/pages/marketplace/MembershipTab.tsx');
    const itemArt = text('src/pages/marketplace/ItemArt.tsx');
    const card = read('public/images/vip-card.png');

    expect(createHash('sha256').update(card).digest('hex')).toBe(
      '74bc159749bc8a4326ee9e07f84560b0aab366b85375d8ff5bd80ced109a3098'
    );
    expect(membership).toContain('images/vip-card.png');
    expect(membership).toContain('className={styles.planArtImage}');
    expect(membership).toContain('className={styles.planName}');
    expect(membership).toContain('className={styles.planPrice}');
    expect(membership).not.toContain('VipArt');
    expect(itemArt).not.toContain('export function VipArt');
  });

  it('does not add decorative icon overlays to Marketplace controls', () => {
    const storeSource = text('src/pages/marketplace/StoreTab.tsx');
    const diamondsSource = text('src/pages/marketplace/DiamondsTab.tsx');
    const marketplaceCss = text('src/pages/MarketplacePage.module.css');
    const diamondsCss = text('src/pages/marketplace/DiamondsTab.module.css');

    expect(storeSource).not.toContain('styles.searchIcon');
    expect(marketplaceCss).not.toContain('.searchIcon');
    expect(marketplaceCss).not.toContain("url('/images/diamond-icon.webp')");
    expect(diamondsCss).not.toContain("url('/images/diamond-icon.webp')");
    expect(diamondsSource).not.toContain('className={styles.ctaIcon}');
    expect(diamondsCss).not.toContain('.ctaIcon');
    expect(diamondsSource.match(/src=\{DIAMOND_ICON\}/g)).toHaveLength(1);
  });

  it('keeps Hub store links in the current browser page', () => {
    const source = text('src/pages/marketplace/DiamondsTab.tsx');

    expect(source).not.toContain('target="_blank"');
    expect(source).not.toContain('window.open');
    expect(source).toContain("href: '/hub/merch-store'");
    expect(source).toContain("href: '/hub/smarter-rewards'");
    expect(source).toContain('leaveForHub(link.href)');
  });

  it('pins the approved all-throwables cutout and uses it as the product fallback', () => {
    const art = read('public/images/marketplace/throwables/all-throwables-access-v1.png');
    const digest = createHash('sha256').update(art).digest('hex');
    const source = text('src/pages/marketplace/ItemArt.tsx');

    expect(digest).toBe('2abc1609b1e6b68118e0d8a6df255867d6866fce4a7efe48a4416a144722edc8');
    expect(source).toContain('images/marketplace/throwables/all-throwables-access-v1.png');
    expect(source).toContain("normalizedCategory.includes('throw')");
  });

  it('upgrades existing cards and controls as independent framed objects', () => {
    const marketplaceCss = text('src/pages/MarketplacePage.module.css');
    const diamondsCss = text('src/pages/marketplace/DiamondsTab.module.css');

    expect(marketplaceCss).toContain('club-utility-shell.webp');
    expect(marketplaceCss).toContain('shark-panel-v1/button-primary.png');
    expect(marketplaceCss).toContain('shark-panel-v1/button-secondary.png');
    expect(diamondsCss).toContain('action-primary-shell.webp');
    expect(diamondsCss).not.toContain("content: '♦'");
    expect(`${marketplaceCss}\n${text('src/pages/marketplace/ItemArt.tsx')}`).not.toMatch(
      /#4ade80|#15803d|rgba\(74, 222, 128/i
    );
  });
});
