import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/**
 * Source with its comments stripped.
 *
 * This codebase explains its fixes IN the file, so a NEGATIVE pin that greps
 * raw text matches the note describing the thing that was removed and reports
 * it as still present. That has cost four red runs in two days now.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const page = read('src/pages/ClubHomePage.tsx');
const pageCss = read('src/pages/ClubHomePage.css');
const identityCard = read('src/components/club-buttons/ClubIdentityCard.tsx');
const identityCardCss = read('src/components/club-buttons/ClubIdentityCard.css');
const wallet = read('src/components/wallet/DynamicWallet.tsx');
const walletCss = read('src/components/wallet/DynamicWallet.css');
const walletArtwork = read('src/components/wallet/ClubWalletArtwork.tsx');
const layout = read('src/components/layouts/AppLayout.tsx');
const filters = read('src/components/lobby/AdvancedFilters.tsx');
const filtersCss = read('src/components/lobby/AdvancedFilters.css');
const tableCss = read('src/components/lobby/LobbyTable.css');

describe('Club Arena Tournament Board lobby design', () => {
  it('keeps the global header and renders the approved dynamic Club Identity Card', () => {
    expect(layout).toContain('{showGlobalHeader && <GlobalHeader />}');
    expect(page).toContain('<ClubIdentityCard');
    expect(page).toContain('className="lobby-top__identity"');
    expect(page).toContain('club.logo_url || club.avatar_url');
    /* WAS a pin on `currentUser?.display_name || currentUser?.username ||
       'Player'` - which recorded the DEFECT. `display_name` is exactly
       `full_name` on 264 of 1,308 production rows, so that chain printed the
       player's legal name on the club card; Dan's own row is one of them, which
       is why his card read "Dan Bekavac" while his alias "KingFish" sat unread
       one column away.

       Dan 2026-09-02: "THE REAL NAME SHOULD NEVER BE DISPLAYED, IT SHOULD
       ALWAYS BE USING THE POKER ALIAS." The pin now guards the rule instead of
       the string: the card resolves through the house resolver, and never
       reaches for display_name itself. */
    expect(page).toContain("pokerAlias={playerDisplayName(currentUser, 'arena')}");
    expect(code(page)).not.toMatch(/currentUser\?\.display_name/);
    expect(page).toContain('playerId={currentUser?.player_number}');
    expect(page).toContain('playersPlaying={playersPlaying}');
    /* v5, not v3. The silver logo frame is gone from the ARTWORK now, and the
       black `__logo-mask` div that used to cover it went with it - Dan
       2026-09-03: "THERE IS A BLACK BARCKGROUND BENIND THE SHARK CLUB LOGO
       THAT NEEDS TO BE REMOVED". Masking a painted box on a textured ground
       only ever swaps one visible rectangle for another. */
    expect(identityCard).toContain('club-identity-template-no-level-v5.png');
    expect(identityCard).not.toMatch(/className="club-identity__logo-mask"/);
    expect(identityCardCss).not.toMatch(/^\.club-identity__logo-mask\s*\{/m);
    /* Dan 2026-09-01, verbatim: "ANYTIME A NEW CLUB IS CREATED, IT NEEDS TO
       START AT LEVEL 1, THAT NEEDS TO BE BELOW THE LOGO INSIDE A BLUE BOX,
       NOT OVERLAPPING THE LOGO." #2509 cured the old overlap by deleting the
       level and pinned the deletion here; the order was the other cure. The
       pin now guards the ordered state: the level RENDERS, in its own blue
       box, in the logo's column, starting beneath the logo square. */
    expect(identityCard).toContain('club-identity__level');
    expect(identityCardCss).toContain('.club-identity__level');
    expect(identityCardCss).toContain('linear-gradient(180deg, #1c4fd8 0%, #0f2f8c 100%)');
    /* ── THE COPY BUTTON IS THE PAINTED FRAME (Dan 2026-09-03) ─────────────
       "THE COPY LINK NEEDS TO BE INSIDE THE FRAME AND CENTERED."

       The old box (75.92-85.59% x 65.19-81.07%) came from the file header's
       ARTWORK ANCHORS, which measured the frame PLUS its blue outer glow. The
       glow is not symmetric about the silver, so a box fitted to it cannot
       centre on it - the icon sat 1.33 points left and 1.22 points high, about
       5px and 2px on a 383px card, and Dan reported it twice.

       These four are the silver stroke itself, thresholded at luminance > 150
       in club-identity-template-no-level-v5.png (1653x951): x 1299-1414,
       y 650-763. Do not "tidy" them toward the glow box again. */
    expect(identityCardCss).toContain('left: 78.58%');
    expect(identityCardCss).toContain('top: 68.35%');
    expect(identityCardCss).toContain('width: 7.02%');
    expect(identityCardCss).toContain('height: 11.99%');

    /* ── THE COUNT LINE IS MEASURED, NOT GUESSED (Dan 2026-09-03) ──────────
       "THE W IN PLAYING NOW IS CUT OFF." The bay had already been widened
       twice for this same complaint and cannot be widened again - its right
       edge now stops at the copy frame above. A fixed `cqw` cannot fit a
       string that changes with the player count, so the size is measured from
       the text the browser laid out, exactly as the club name already was. */
    expect(identityCard).toContain('fittedPlayingSizeCqw');
    expect(identityCard).toContain('club-identity__playing-fit');
    expect(identityCardCss).toContain('font-size: var(--playing-size, 3.15cqw)');

    /* ── BOTH TOP LINES SIT HIGHER (Dan 2026-09-03) ────────────────────────
       "SHARK CLUB NEEDS TO BE UP HIGHER" and "DAN BEKAVAC NEEDS TO BE UP
       HIGHER". The name's band is also TALLER than its own line box now: at
       `height: 11%` on a 2.4/1 card the 26.8px text did not fit the 17.6px
       band, grid centring fell back to start alignment, and the name hung
       below the box it was supposedly centred in. Nudging `top` was moving an
       overflow, which is why it kept reading low. */
    expect(identityCardCss).toContain('top: 9.2%');
    expect(identityCardCss).toContain('height: 18%');
    expect(identityCardCss).toContain('top: 26%');

    expect(identityCard).toContain('Copy Referral Link');
    expect(identityCardCss).toContain('aspect-ratio: 1650 / 953');
    expect(identityCardCss).toContain('line-height: 1.18');

    /* ── THE STACK (Dan 2026-09-02) ────────────────────────────────────────
       "the club name should be across the very top of the card, all the way
       left to right, with the logo under it ... UNDER THAT SHOULD BE DAN
       BEKAVAC, NEXT LINE CLUB ID, NEXT LINE PLAYER ID LAST LIKE 192 PLAYING
       AND THE COPY LINK."

       This block replaces two bare pins - `top: 52%` (the logo) and
       `top: 72.8%` (the level) - which recorded where those boxes sat while
       the club name was a column BESIDE the logo. Both rose when the name
       became a band of its own, so the pins move with them in the same commit,
       and are stated as the ORDER Dan asked for rather than as two loose
       numbers that say nothing about why they are what they are. */
    /* Declarations only. This stylesheet explains every position in a comment
       beside it, so a NEGATIVE pin that greps raw text matches the note about
       the value that was removed and reports it as still present. That has now
       cost three separate red runs in two days - a CSS function name, the
       phrase "Game Unavailable", and `bottom: 15%` below. */
    const identityDeclarations = identityCardCss.replace(/\/\*[\s\S]*?\*\//g, '');

    const topOf = (selector: string) => {
      const rule = identityDeclarations.match(
        new RegExp(`\\${selector}\\s*\\{[^}]*?top:\\s*([\\d.]+)%`, 's')
      );
      expect(rule, `no top declared for ${selector}`).toBeTruthy();
      return Number(rule![1]);
    };

    /* Row 1 spans the card edge to edge. The exact `top` is deliberately not
       pinned to a literal - it was nudged once already, after the rendered
       card showed the caps grazing the painted top rail on the squat 2.4/1
       lobby variant - so what is pinned is the span, and the ORDER below. */
    expect(identityDeclarations).toMatch(
      /\.club-identity__name\s*\{[^}]*left:\s*7\.5%[^}]*right:\s*7\.5%[^}]*top:\s*[\d.]+%/s
    );
    // One line, and never an ellipsis: the club name is the one string Dan has
    // said twice must always be shown in full.
    expect(identityDeclarations).toMatch(
      /\.club-identity__name\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*clip/s
    );
    expect(identityDeclarations).not.toMatch(
      /\.club-identity__name\s*\{[^}]*text-overflow:\s*ellipsis/s
    );

    // Top to bottom: name, then logo, then level; and name, alias, the IDs.
    expect(topOf('.club-identity__name')).toBeLessThan(topOf('.club-identity__logo'));
    expect(topOf('.club-identity__logo')).toBeLessThan(topOf('.club-identity__level'));
    expect(topOf('.club-identity__name')).toBeLessThan(topOf('.club-identity__alias'));
    expect(topOf('.club-identity__alias')).toBeLessThan(topOf('.club-identity__ids'));

    /* The count and the copy link are the LAST line, so they share one band.
       They were already the last two things on the card, but the count was
       anchored `bottom: 15%` and the share to the painted frame at 65.19%, so
       they were never actually on the same line. */
    expect(identityDeclarations).toMatch(
      /\.club-identity__playing\s*\{[^}]*top:\s*65\.19%[^}]*height:\s*15\.88%/s
    );
    expect(identityDeclarations).not.toMatch(/\.club-identity__playing\s*\{[^}]*bottom:\s*15%/s);

    /* The alias carries the same 7.2cqw gutter as the two ID lines below it,
       so those three read as one column past the painted icons.

       The playing line deliberately does NOT. It was given the gutter for a
       straight edge and the copy was cut off - it holds the longest string on
       the card ("1,204 PLAYING NOW") in the narrowest bay, and Dan has already
       reported that symptom once: "NEVER CUTTING OFF THE 446 PLAYING NOW
       FONT". A tidier left edge is not worth re-shipping it. */
    expect(identityDeclarations).toMatch(
      /\.club-identity__alias\s*\{[^}]*padding-left:\s*7\.2cqw/s
    );
    expect(identityDeclarations).not.toMatch(/\.club-identity__playing\s*\{[^}]*padding-left/s);

    /* ── THE CARD ONLY SHRINKS (Dan, 2026-09-01) ───────────────────────────
       These four pins replace `translateY(1.65cqw)`, `margin-top: 1.4cqw`,
       and the `@media (pointer: coarse)` block that sized the share BUTTON to
       44x44px. Each of those was a width-derived nudge or a pixel size applied
       to a card whose height comes from its aspect ratio, so the card laid
       itself out differently at 375px than at 1024px - measured live before
       this pass: the club ID line sat 3.37% below its icon on desktop and
       8.09% below it on mobile, and the share button was 61% of the card's
       height with its icon 3.7% outside the painted copy frame.

       What is pinned now is the cure: the ID lines have their own bay pinned
       to the artwork icons, the share button occupies the painted frame in
       percentages, and the 44px thumb target is an invisible `::after` band
       that paints nothing and so cannot move anything. */
    expect(identityCardCss).toMatch(
      /\.club-identity__ids\s*\{[^}]*top:\s*47\.06%[^}]*height:\s*21\.46%/s
    );
    /* The share box moved on 2026-09-03, and this pin moves with it rather
       than being weakened. 75.92/65.19/9.68/15.88 was the frame PLUS its blue
       glow; the numbers below are the silver stroke. The rule being guarded is
       unchanged - the button occupies the painted frame in percentages - only
       the measurement of "the painted frame" is corrected. Full reasoning at
       the assertions further down and in ClubIdentityCard.css. */
    expect(identityCardCss).toMatch(
      /\.club-identity__share\s*\{[^}]*left:\s*78\.58%[^}]*top:\s*68\.35%[^}]*width:\s*7\.02%[^}]*height:\s*11\.99%/s
    );
    expect(identityCardCss).toMatch(
      /\.club-identity__share::after\s*\{[^}]*width:\s*max\(100%, 44px\)[^}]*height:\s*max\(100%, 44px\)/s
    );
    /* 3.7cqw, trimmed from 4 on 2026-09-03. The button is the frame's own
       rectangle now rather than the glow's, so the opening the icon sits in is
       19.1px tall at 383px; 4cqw was 15.3px of that and read as filling it. */
    expect(identityCardCss).toMatch(
      /\.club-identity__share svg\s*\{[^}]*width:\s*3\.7cqw[^}]*height:\s*3\.7cqw/s
    );
    /* No breakpoint may rearrange this card, and no painted size may stop
       scaling. A `clamp()` with a rem or px bound is a rearrangement waiting
       for a narrow enough card - that is exactly what shipped the bug. */
    const identityRules = identityCardCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(identityRules).not.toContain('@media (max-width');
    expect(identityRules).not.toContain('@media (pointer: coarse)');
    expect(identityRules).not.toContain('rem)');
    expect(identityCardCss).not.toContain('translateY(1.44cqw)');
  });

  it('spells out Bad Beat Jackpot and opens the existing detail modal', () => {
    expect(page).toContain('className="lobby-bbj"');
    expect(page).toContain('>Bad Beat Jackpot</span>');
    expect(page).toContain('setShowBBJInfo(true)');
    expect(page).toContain('showBBJ={false}');
  });

  it('stacks the approved long wallet art beneath the BBJ with live values', () => {
    expect(page).toContain('compactLobby');
    expect(wallet).toContain('clubLobbyWalletRows(rowRole)');
    expect(wallet).toContain("row.key === 'union_bank' || row.key === 'union_rake'");
    expect(wallet).toContain('ClubWalletShell');
    expect(walletArtwork).toContain('CLUB_WALLET_ARTWORK');
    expect(walletArtwork).toContain('wallets/desktop/${filename}-v1.webp');
    expect(walletArtwork).toContain('wallets/mobile/${filename}-v1.webp');
    expect(pageCss).toContain('grid-column: 2');

    const lobbyWalletCss = walletCss.slice(
      walletCss.indexOf('APPROVED CLUB ARENA WALLET + BBJ ART')
    );
    expect(lobbyWalletCss).toContain('flex-direction: column');
    expect(lobbyWalletCss).toContain('aspect-ratio: 1800 / 380');
    expect(lobbyWalletCss).toContain('@media (min-width: 641px)');
    expect(lobbyWalletCss).toContain('aspect-ratio: 1800 / 273');
    expect(lobbyWalletCss).toContain('font-variant-numeric: tabular-nums');
    expect(lobbyWalletCss).not.toContain('linear-gradient');
  });

  it('uses the approved BBJ plaque without baking the live jackpot amount into the image', () => {
    expect(page).toContain('<ClubBBJShell className="lobby-bbj__shell" />');
    expect(walletArtwork).toContain('bbj-dynamic-plaque-v1.webp');
    expect(page).toContain('className="lobby-bbj__amount"');
    expect(pageCss).toContain('aspect-ratio: 1600 / 560');
  });

  it('removes the redundant result-count strip and cashier prompt', () => {
    expect(page).not.toMatch(/Showing\s*<strong>/);
    expect(page).not.toContain('Cashier For More');
  });

  it('fits every mobile control without a horizontal reveal row', () => {
    const mobileConsole = pageCss.slice(pageCss.lastIndexOf('MOBILE LOBBY FINAL CONTRACT'));
    expect(mobileConsole).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    expect(pageCss).toContain('display: contents');
    expect(mobileConsole).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(mobileConsole).toContain('overflow: visible');
  });

  it('uses the same self-contained identity card on mobile and a smaller two-line club notice', () => {
    const mobileConsole = pageCss.slice(pageCss.lastIndexOf('MOBILE LOBBY FINAL CONTRACT'));
    expect(pageCss).toContain('@media (max-width: 480px)');
    expect(pageCss).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(identityCardCss).toContain('@media (max-width: 360px)');
    expect(mobileConsole).toContain('-webkit-line-clamp: 2');
  });

  it('rebuilds Filters as a solid tournament-board console', () => {
    expect(filters).toContain('Tournament Board');
    expect(filters).toContain("Apply {activeCount > 0 ? `${activeCount} ` : ''}Filters");
    expect(filters).toContain('Reset {activeTypeLabel}');
    expect(filters).toContain('Only Show Games With Every Selected Feature.');
    expect(filtersCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(filtersCss).toContain('background: #08111d');
    expect(filtersCss).toContain('z-index: 9620');
    expect(filtersCss).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(filtersCss).not.toContain('overflow-x: auto');
  });

  it('gives mobile game cards solid raised depth and balanced data bays', () => {
    const cards = tableCss.slice(tableCss.indexOf('MOBILE TOURNAMENT-BOARD CARDS'));
    expect(cards).toContain('background: #0d1928');
    expect(cards).toContain('flex: 1 1 82px');
    expect(cards).toContain('background: #07111d');
    expect(cards).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });
});
