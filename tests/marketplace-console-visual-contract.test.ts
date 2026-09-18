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
    expect(diamondsSource).not.toContain('DIAMOND_ICON');
  });

  it('uses six distinct premium Diamond package portraits from the pinned atlas', () => {
    const diamondsSource = text('src/pages/marketplace/DiamondsTab.tsx');
    const diamondsCss = text('src/pages/marketplace/DiamondsTab.module.css');
    const atlas = read('public/images/marketplace/diamond-packages/diamond-package-atlas-v1.webp');

    expect(createHash('sha256').update(atlas).digest('hex')).toBe(
      'dcf06b5598186916271cb839efd8327981dc92463304bf27970ef3421662ad4a'
    );
    expect(diamondsSource).toContain('diamond-package-atlas-v1.webp');
    expect(diamondsSource).toContain('<DiamondPackageArt tier={idx} />');
    expect(diamondsSource).not.toContain('images/diamond-icon.webp');
    expect(diamondsCss).toContain('background-size: 300% 200%');
    for (const tier of ['0', '1', '2', '3', '4', '5']) {
      expect(diamondsCss).toContain(`.packageArt[data-tier='${tier}']`);
    }
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
    expect(source).toContain('isThrowableIdentity(identity)');
    expect(source).toContain("normalizedArtKey(value).includes('throw')");
  });

  it('keeps VIP perks on approved premium icons and the all-throwables artwork', () => {
    const grid = text('src/components/vip/VIPPerksGrid.tsx');
    const gridCss = text('src/components/vip/VIPPerksGrid.css');
    const page = text('src/pages/VIPPage.tsx');
    const perkData = page.slice(
      page.indexOf('const membershipPerks'),
      page.indexOf('// VIP entrance animation')
    );

    expect(grid).toContain('import { ClubIcon, type ClubIconName }');
    expect(grid).toContain('import { formatPopupText }');
    expect(grid).toContain('name={perk.icon}');
    expect(grid).toContain('onError={() => setArtworkFailed(true)}');
    expect(grid).not.toMatch(/[◆◷▦◈]/u);
    expect(grid).not.toContain('currentTier');
    expect(perkData).not.toMatch(/icon:\s*['"]\\u25/i);
    expect(page).toContain('images/marketplace/throwables/all-throwables-access-v1.png');
    expect(page).toContain('artworkSrc: ALL_THROWABLES_ART');
    expect(page).toContain('<VIPPerksGrid perks={membershipPerks} />');
    expect(gridCss).toContain('wallet-row-shell.png');
    expect(gridCss).toContain('shark-panel-v1/button-primary.png');
    expect(gridCss).toContain('shark-panel-v1/button-secondary.png');
    expect(gridCss).toContain("[data-theme='light'] .vip-perks-grid");
    expect(gridCss).not.toMatch(/(?:linear|radial)-gradient/i);
    expect(gridCss).not.toContain('clip-path:');
    expect(gridCss).not.toContain(':hover');
    expect(gridCss).not.toMatch(/font-family:[^;]*(?:monospace|courier)/i);
    expect(gridCss).not.toMatch(/#4ade80|#22c55e|#8b5cf6|#a855f7/i);
    expect(gridCss).not.toMatch(/border-radius:\s*(?:12|14|16|20|9999)px/i);
  });

  it('uses the approved photoreal product portraits instead of legacy flat SVG covers', () => {
    const artSource = text('src/pages/marketplace/ItemArt.tsx');
    const storeSource = text('src/pages/marketplace/StoreTab.tsx');
    const css = text('src/pages/MarketplacePage.module.css');

    expect(artSource).toContain('club-shop-product-atlas-v2.webp');
    expect(artSource).toContain("'royal monarch avatar': '100% 100%'");
    expect(artSource).toContain("'royal gold table skin': '100% 50%'");
    expect(artSource).toContain("'premium emote pack': '33.333% 100%'");
    expect(artSource).toContain("'time bank bundle 100s': '66.667% 0%'");
    expect(artSource).toContain('CLUB_PRODUCT_ATLAS_REFS');
    expect(css).toContain('aspect-ratio: 1 / 1');
    expect(artSource).not.toContain('throwable-tomato.svg');
    expect(artSource).not.toContain('throwable-snowball.svg');
    expect(artSource).not.toContain('throwable-golden-egg.svg');
    expect(css).toContain('.itemArtMediaLayer');
    expect(artSource).toContain('data-art-state={status}');
    expect(artSource).toContain('onError={() => setThrowableArtFailed(true)}');
    expect(artSource).toContain("onError={() => setAtlasState('failed')}");
    expect(artSource).toContain('<NeutralArtState status="unavailable" />');
    expect(artSource).not.toContain('function DefaultScene');
    expect(artSource).not.toContain('function sceneFor');
    expect(storeSource).toContain('item.item_type,');
    expect(storeSource).toContain('item.grant_spec?.type,');
    expect(storeSource).toContain(
      'artRef={item.grant_spec?.avatar_id || item.grant_spec?.theme_id}'
    );
    expect(storeSource).toContain('name={item.name}');
    expect(storeSource).toContain('{modalImg && (');
    expect(storeSource).toContain("style.display = 'none'");
    expect(css).toMatch(/\.purchaseImage\s*\{[\s\S]*?position:\s*relative/);
    expect(css).toMatch(/\.itemImg\s*\{[\s\S]*?position:\s*absolute/);

    const inventorySource = text('src/pages/marketplace/MyItemsTab.tsx');
    expect(inventorySource).toContain('name={it.item_name}');
  });

  it('keeps unavailable art neutral and preserves case-sensitive admin identifiers', () => {
    const artSource = text('src/pages/marketplace/ItemArt.tsx');
    const manageSource = text('src/pages/marketplace/ManageTab.tsx');
    const css = text('src/pages/MarketplacePage.module.css');

    expect(artSource).toContain('Artwork Unavailable');
    expect(artSource).toContain('Verified Image Required');
    expect(css).toContain('shark-panel-v1/bay.png');
    expect(css).toMatch(/\.identifierInput\s*\{[\s\S]*?text-transform:\s*none/);
    expect(manageSource.match(/styles\.identifierInput/g)).toHaveLength(6);
    expect(manageSource.match(/autoCapitalize="none"/g)).toHaveLength(2);
    expect(manageSource.match(/spellCheck=\{false\}/g)).toHaveLength(2);
  });

  it('keeps purchase actions explicit, same-page, and free of floating glyph overlays', () => {
    const shared = text('src/pages/marketplace/marketplaceShared.ts');
    const store = text('src/pages/marketplace/StoreTab.tsx');
    const membership = text('src/pages/marketplace/MembershipTab.tsx');
    const css = text('src/pages/MarketplacePage.module.css');

    expect(store).toContain('const itemPath = encodeURIComponent(item.id)');
    expect(store).toContain('const clubQuery = encodeURIComponent(clubId)');
    expect(store).toContain('leaveForHub(`/hub/club-shop/${itemPath}?clubId=${clubQuery}`)');
    expect(store).toContain('Buy With Diamonds');
    expect(store).toContain('Buy With Card');
    expect(store).not.toContain('window.open');
    expect(store).not.toContain('<path d="M6 6 18 18M18 6 6 18"');
    expect(css).toContain('.itemPurchaseActions');
    expect(css).not.toContain('.emptyIcon');
    expect(css).not.toContain('.deliveryStatus > span');
    expect(css).not.toContain("content: '✓'");
    expect(shared).toContain('idempotencyKey: requestId,');
    expect(shared).not.toContain('items,\n        idempotencyKey,');
    expect(shared).toContain("typeof (p as VipPlan).cardCheckoutReady === 'boolean'");
    expect(membership).toContain('cardCheckoutIsReady(plan)');
    expect(membership).toContain('wallet.loaded &&');
    expect(membership).toContain('!isLifetime &&');
    expect(membership).toContain("nativePurchaseRequestFor('subscription'");
    expect(membership).toContain('if (!wallet.loaded)');
    expect(membership).toContain('if (isLifetime)');
    expect(membership).toContain('Your Membership Status Is Unavailable Right Now');
  });

  it('revalidates server pricing at purchase time and handles repeated in-page returns', () => {
    const page = text('src/pages/MarketplacePage.tsx');
    const shared = text('src/pages/marketplace/marketplaceShared.ts');
    const diamonds = text('src/pages/marketplace/DiamondsTab.tsx');
    const membership = text('src/pages/marketplace/MembershipTab.tsx');
    const store = text('src/pages/marketplace/StoreTab.tsx');

    expect(shared).toContain("'/api/club-arena/store-catalog?strict=1'");
    expect(shared).toContain('!raw.every(guard)');
    expect(shared).toContain("throw new Error('catalog response failed validation')");
    expect(shared).toContain("data.diamondCatalogSource !== 'database'");
    expect(shared).toContain('data.warnings.length !== 0');
    expect(shared).toContain('verifiedStripeCheckoutResponse(data, requestId, offerConfirmation)');
    expect(page).toContain('loadStoreCatalog({ force: true })');
    expect(page).toContain('refreshCatalogForPurchase={refreshCatalogForPurchase}');
    expect(diamonds).toContain('await refreshCatalogForPurchase()');
    expect(diamonds).toContain('currentPackage.priceUsd !== pkg.priceUsd');
    expect(membership.match(/await refreshCatalogForPurchase\(\)/g)).toHaveLength(2);
    expect(membership).toContain('currentPlan.priceDiamonds !== plan.priceDiamonds');
    expect(membership).toContain('verifiedVipDiamondPurchaseReceipt(');
    expect(membership).toContain('isVerifiedVipPurchasePrecommitRefusal(err, {');
    expect(diamonds).toContain('readOrCreateMarketplacePurchaseIntent(');
    expect(store).toContain('item.card_checkout_available !== true');
    expect(page).toContain('purchaseHandledRef.current = returnIdentity');
    expect(page).toContain('pollTimersRef.current.push(timer)');
    expect(page).toContain('verifiedMarketplaceCardCheckoutStatus(raw, {');
    expect(page).toContain('retireMarketplacePurchaseIntentByRequestId(receipt.requestId)');
    expect(
      page.match(/currentMarketplaceCheckoutUserMatches\(user\.id, statusController\.signal\)/g)
    ).toHaveLength(2);
    expect(page).toContain('const current = locationRef.current;');
    expect(page).toContain('hash: current.hash');
    expect(page).toContain('endStatusDeadline();');
    expect(page).toContain(
      'clearReturnUrl();\n        void loadWalletRef.current(receipt.accountId);'
    );
    expect(page).toContain('verifiedContinuation?.ownerId === user?.id');
    expect(page).toContain('verifiedContinuation?.path === nextPath');
    expect(page).toContain('activeUserIdRef.current === expectedAccountId');
    expect(page).toContain('myReq === walletReqRef.current');
    expect(page).toContain('setWallet(EMPTY_WALLET)');
    expect(page).not.toContain('pollTimersRef.current = [1500, 5000, 12000]');
  });

  it('keeps premium light-mode controls and commerce recovery states readable', () => {
    const css = text('src/pages/MarketplacePage.module.css');
    const diamondsCss = text('src/pages/marketplace/DiamondsTab.module.css');
    const manage = text('src/pages/marketplace/ManageTab.tsx');
    const inventory = text('src/pages/marketplace/MyItemsTab.tsx');
    const ledger = text('src/pages/marketplace/PurchaseLedger.tsx');

    const flatLightGroup =
      css.match(/:global\(\[data-theme='light'\]\) \.tabNav,[\s\S]*?\.tableScroll\s*\{/)?.[0] || '';
    expect(flatLightGroup).not.toContain('.modalClose');
    expect(css).toContain('shark-panel-v1/button-secondary.png');
    expect(diamondsCss).toContain('.catalogNotice');
    expect(manage).toContain('Live Catalog Verification Is Temporarily Unavailable');
    expect(inventory).toContain('All Throwables Uses');
    expect(inventory).not.toContain('Free Throws');
    expect(ledger).toContain('refund:${expectedClubId}:${row.id}');
    expect(ledger).toContain('refundingRef.current = true');
  });

  it('upgrades existing cards and controls as independent framed objects', () => {
    const marketplaceCss = text('src/pages/MarketplacePage.module.css');
    const diamondsCss = text('src/pages/marketplace/DiamondsTab.module.css');

    expect(marketplaceCss).toContain('club-utility-shell.webp');
    expect(diamondsCss).toContain('club-utility-shell.webp');
    expect(marketplaceCss).toContain('shark-panel-v1/top.png');
    expect(marketplaceCss).toContain('shark-panel-v1/mid.png');
    expect(marketplaceCss).toContain('shark-panel-v1/bottom.png');
    expect(marketplaceCss).toContain('wallet-row-shell.webp');
    expect(marketplaceCss).toContain('action-primary-shell.webp');
    expect(marketplaceCss).not.toContain('border-left: 3px');
    expect(diamondsCss).toContain('shark-panel-v1/top.png');
    expect(diamondsCss).toContain('shark-panel-v1/mid.png');
    expect(diamondsCss).toContain('shark-panel-v1/bottom.png');
    expect(diamondsCss).not.toContain('border-left:');
    expect(marketplaceCss).toContain('shark-panel-v1/button-primary.png');
    expect(marketplaceCss).toContain('shark-panel-v1/button-secondary.png');
    expect(diamondsCss).toContain('action-primary-shell.webp');
    expect(diamondsCss).not.toContain("content: '♦'");
    expect(marketplaceCss).not.toContain('text-transform: uppercase');
    expect(diamondsCss).not.toContain('text-transform: uppercase');
    expect(marketplaceCss).toMatch(/\.page\s*\{[\s\S]*?text-transform:\s*capitalize/);
    const storeTab = text('src/pages/marketplace/StoreTab.tsx');
    expect(storeTab).toContain('return sortMarketplaceItems(result, sortMode)');
    expect(storeTab).toContain('readOrCreateSessionPurchaseRequest(');
    expect(storeTab).toContain('readSessionPurchaseRequest(scope)');
    expect(storeTab).toContain(
      'clearSessionPurchaseRequestIfMatches(purchaseScope, purchaseIntent.requestId)'
    );
    expect(storeTab).not.toContain('purchaseKeyRef');
    expect(storeTab).not.toContain('Math.random()');
    const shared = text('src/pages/marketplace/marketplaceShared.ts');
    expect(shared).toContain("case 'price-low':");
    expect(shared).toContain('return effectivePrice(a) - effectivePrice(b)');
    expect(shared).toContain("case 'price-high':");
    expect(shared).toContain('return effectivePrice(b) - effectivePrice(a)');
    expect(marketplaceCss).not.toMatch(/ui-monospace|JetBrains|Rajdhani/);
    expect(marketplaceCss).not.toMatch(/(?:linear|radial)-gradient/i);
    expect(marketplaceCss).not.toContain('data:image/svg+xml');
    expect(marketplaceCss).not.toContain(':hover');
    expect(diamondsCss).not.toMatch(/ui-monospace|JetBrains|Rajdhani/);
    expect(diamondsCss).not.toMatch(/(?:linear|radial)-gradient/i);
    expect(diamondsCss).not.toContain(':hover');
    expect(`${marketplaceCss}\n${text('src/pages/marketplace/ItemArt.tsx')}`).not.toMatch(
      /#4ade80|#15803d|rgba\(74, 222, 128/i
    );
  });

  it('uses premium wallet and top-up art without floating typographic icons', () => {
    const page = text('src/pages/VIPPage.tsx');
    const pageCss = text('src/pages/VIPPage.css');
    const topUp = text('src/components/vip/DiamondTopUpModal.tsx');
    const topUpCss = text('src/components/vip/DiamondTopUpModal.css');
    const wallet = text('src/components/wallet/DiamondWalletModal.tsx');
    const walletCss = text('src/components/wallet/DiamondWalletModal.css');

    expect(page).toContain('images/diamond-icon.webp');
    expect(page).toContain('diamond-buy-btn--primary');
    expect(page).toContain('diamond-buy-btn--secondary');
    expect(page).not.toMatch(/[◆◈♛★▲▼]/u);
    expect(page).not.toContain("style={{ background: 'rgba(255,255,255,0.08)'");
    expect(pageCss).toContain('wallet-row-shell.webp');
    expect(pageCss).toContain('shark-panel-v1/top.png');
    expect(pageCss).toContain('shark-panel-v1/mid.png');
    expect(pageCss).toContain('shark-panel-v1/bottom.png');
    expect(pageCss).toContain('shark-panel-v1/button-primary.png');
    expect(pageCss).toContain('shark-panel-v1/button-secondary.png');
    expect(pageCss).toContain('.purchase-card');
    expect(pageCss).toContain('.purchase-btn');
    expect(pageCss).not.toMatch(/(?:linear|radial)-gradient/i);
    expect(pageCss).not.toContain('border-left:');
    expect(pageCss).not.toContain(':hover');
    expect(pageCss).not.toMatch(/\.current-status|\.tier-badge|\.progress-bar/);
    expect(page).toContain('{pricing.cost} Diamonds');
    expect(page).toContain("purchasing === feature ? 'Processing' : 'Buy'");

    expect(topUp).toContain('images/marketplace/diamond-packages/diamond-package-atlas-v1.webp');
    expect(topUp).toContain('className="diamond-package__art"');
    expect(topUp).not.toContain('images/diamond-icon.webp');
    expect(topUp).toContain('Opening Checkout');
    expect(topUp).toContain('Close');
    expect(topUp).not.toMatch(/[◆×]/u);
    expect(topUpCss).toContain('shark-panel-v1/button-primary.png');
    expect(topUpCss).toContain('shark-panel-v1/button-secondary.png');
    expect(topUpCss).toContain('shark-panel-v1/top.png');
    expect(topUpCss).toContain('shark-panel-v1/mid.png');
    expect(topUpCss).toContain('shark-panel-v1/bottom.png');
    expect(topUpCss).toContain('club-utility-shell.webp');
    expect(topUpCss).toContain('background-size: 300% 200%');
    for (const tier of ['0', '1', '2', '3', '4', '5']) {
      expect(topUpCss).toContain(`.diamond-package__art[data-tier='${tier}']`);
    }
    expect(topUpCss).not.toContain("content: ' ◆'");
    expect(topUpCss).not.toMatch(/ui-monospace|JetBrains|Courier|Rajdhani/i);
    expect(topUpCss).not.toMatch(/(?:linear|radial)-gradient/i);
    expect(topUpCss).not.toContain(':hover');

    expect(wallet).toContain('crest="flat"');
    expect(wallet).toContain('Balance {tx.balance_after.toLocaleString()}');
    expect(wallet).not.toContain('ICON_GLYPHS');
    expect(wallet).not.toContain('iconGlyph');
    expect(wallet).not.toContain('dwc__tx-glyph');
    expect(wallet).not.toContain('sc-ink--green');
    expect(walletCss).not.toContain('.dwc__tx-glyph');
  });

  it('scopes painted notifications to the VIP Marketplace route', () => {
    const page = text('src/pages/VIPPage.tsx');
    const toast = text('src/components/common/Toast.tsx');
    const toastCss = text('src/components/common/Toast.css');

    expect(page).toContain("document.body.classList.add('marketplace-color-scope')");
    expect(page).toContain("document.body.classList.remove('marketplace-color-scope')");
    expect(toast).toContain('className="toast__close-label"');
    expect(toastCss).toContain('body.marketplace-color-scope .toast');
    expect(toastCss).toContain('shark-panel-v1/top.png');
    expect(toastCss).toContain('shark-panel-v1/mid.png');
    expect(toastCss).toContain('shark-panel-v1/bottom.png');
    expect(toastCss).toContain('shark-panel-v1/button-secondary.png');
    expect(toastCss).toMatch(
      /body\.marketplace-color-scope \.toast__icon\s*\{[\s\S]*?display:\s*none/
    );
    expect(toastCss).toMatch(
      /body\.marketplace-color-scope \.toast__close svg\s*\{[\s\S]*?display:\s*none/
    );
  });

  it('renders the VIP membership plate from painted masters without generic typography', () => {
    const source = text('src/components/vip/VIPMembershipPlate.tsx');
    const css = text('src/components/vip/VIPMembershipPlate.css');

    expect(source).toContain('className="vmp__cap"');
    expect(source).toContain('className="vmp__body"');
    expect(source).toContain('className="vmp__foot"');
    expect(css).toContain('shark-panel-v1/top.png');
    expect(css).toContain('shark-panel-v1/mid.png');
    expect(css).toContain('shark-panel-v1/bottom.png');
    expect(css).toContain('wallet-row-shell.webp');
    expect(css).toContain('action-primary-shell.webp');
    expect(css).toContain('aspect-ratio: 900 / 143');
    expect(css).toContain('aspect-ratio: 900 / 139');
    expect(css).toContain('aspect-ratio: 1800 / 386');
    expect(css).toContain('aspect-ratio: 1000 / 246');
    expect(css).not.toMatch(/(?:linear|radial)-gradient/i);
    expect(css).not.toMatch(/ui-monospace|JetBrains|Courier|Rajdhani|monospace/i);
    expect(css).not.toContain(':hover');
    expect(css).not.toMatch(/#4ade80|#22c55e|#15803d/i);
  });

  it('keeps VIP rewards on honest previews and painted master controls', () => {
    const source = text('src/components/vip/RewardsMarketplace.tsx');
    const css = text('src/components/vip/RewardsMarketplace.css');

    expect(source).toContain('import { formatPopupText }');
    expect(source).toContain('grant_type, grant_ref');
    expect(source).toContain('normalizeThemePresetId(reward.grantRef)');
    expect(source).toContain('src={resolveSkin(themeId)}');
    expect(source).toContain('onError={() => setThemePreviewFailed(true)}');
    expect(source).toContain('default-avatar.png');
    expect(source).toContain('className="reward-preview__avatar-art"');
    expect(source).toContain('<AvatarCosmetics frame={frame.id} still />');
    expect(source).toContain('Preview Unavailable');
    expect(source).toContain('{formatPopupText(featuredReward.name)}');
    expect(source).toContain('{formatPopupText(featuredReward.description)}');
    expect(source).toContain('{formatPopupText(reward.name)}');
    expect(source).toContain('{formatPopupText(reward.description)}');
    expect(source).not.toMatch(/[★◆♛◐▲◈]/u);
    expect(source).not.toMatch(/[–—]/u);
    expect(source).not.toContain('reward-icon-box');
    expect(source).not.toContain('featured-icon');
    expect(source).not.toContain('ClubIcon');

    expect(css).toContain('shark-panel-v1/button-primary.png');
    expect(css).toContain('shark-panel-v1/button-secondary.png');
    expect(css).toContain('wallet-row-shell.png');
    expect(css).toContain('club-utility-shell.webp');
    expect(css).toContain('club-nav-shell.webp');
    expect(css).toContain("[data-theme='light'] .rewards-marketplace");
    expect(css).toMatch(/\.reward-card\s*\{[\s\S]*?border-radius:\s*0/);
    expect(css).toMatch(/\.category-tab\s*\{[\s\S]*?border-radius:\s*0/);
    expect(css).not.toMatch(/(?:linear|radial)-gradient/i);
    expect(css).not.toContain('clip-path:');
    expect(css).not.toContain(':hover');
    expect(css).not.toMatch(/#4ade80|#22c55e|#15803d|#8b5cf6|#a855f7|rgba\(155,\s*89,\s*182/i);
    expect(css).not.toContain('.reward-icon-box');
    expect(css).not.toContain('.featured-icon');
    expect(css).not.toContain('.card-glow');
  });

  it('keeps VIP activity summaries and timeline rows on painted master surfaces', () => {
    const source = text('src/components/vip/VIPActivityHistory.tsx');
    const css = text('src/components/vip/VIPActivityHistory.css');

    expect(source).toContain('images/diamond-icon.webp');
    expect(source).toContain('<img src={DIAMOND_ACTIVITY_ART}');
    expect(source).not.toContain('ClubIcon');
    expect(source).not.toMatch(/[◆◈♛★▲▼]/u);

    expect(css).toContain('wallet-row-shell.png');
    expect(css).toContain('club-utility-shell.webp');
    expect(css).toContain('club-nav-shell.webp');
    expect(css).toContain('shark-panel-v1/button-primary.png');
    expect(css).toContain('shark-panel-v1/button-secondary.png');
    expect(css).not.toMatch(/(?:linear|radial)-gradient/i);
    expect(css).not.toContain(':hover');
    expect(css).not.toMatch(/#4ade80|#22c55e|#15803d|rgba\(74,\s*222,\s*128/i);
    expect(css).not.toMatch(/prefers-reduced-motion[\s\S]*animation:\s*none/i);
  });
});
