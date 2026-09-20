import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  LobbyEntry,
  LobbyTableRow,
  LobbyTournamentRow,
  RuleMedallion,
} from '../src/components/lobby/lobbyEntries';
import {
  arenaGameCardDataFromEntry,
  compactCashBuyInLabel,
} from '../src/components/lobby/game-cards/arenaGameCardAdapter';
import { arenaGameCardActionsForEntry } from '../src/components/lobby/game-cards/ArenaLobbyGameCard';
import {
  ARENA_GAME_CARD_TEMPLATE_REGISTRY,
  resolveArenaGameCardTemplate,
  validateArenaGameCardRegistry,
} from '../src/components/lobby/game-cards/arenaGameCardRegistry';
import type { LobbyRowContext } from '../src/components/lobby/lobbyCardContext';
import { SpadePloCard } from '../src/components/lobby/game-cards/SpadePloCard';

const ROOT = resolve(__dirname, '..');
const CARD_CSS = readFileSync(
  resolve(ROOT, 'src/components/lobby/game-cards/ArenaGameCard.css'),
  'utf8'
);
const TABLE_CSS = readFileSync(resolve(ROOT, 'src/components/lobby/LobbyTable.css'), 'utf8');

const rule = (key: string, label = key): RuleMedallion => ({ key, label, tip: label });

function cashEntry(gameLabel: string, rules: RuleMedallion[] = []): LobbyEntry {
  const raw: LobbyTableRow = {
    id: `cash-${gameLabel}`,
    name: `${gameLabel} 1/2`,
    game_variant: gameLabel,
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 80,
    max_buy_in: 400,
    current_players: 4,
    max_players: 6,
    status: 'open',
  };
  return {
    id: raw.id,
    kind: 'cash',
    name: raw.name,
    gameLabel,
    variantLabel: gameLabel,
    stakesLabel: '$1 / $2',
    stakesValue: 2,
    buyInLabel: '$80 – $400',
    buyInValue: 80,
    guaranteeLabel: null,
    guaranteeValue: 0,
    players: 4,
    capacity: 6,
    startTime: null,
    startValue: Number.POSITIVE_INFINITY,
    speedLabel: null,
    status: 'open',
    statusLabel: 'Open',
    live: true,
    rules,
    featured: false,
    isNew: false,
    vipOnly: false,
    hideClubName: false,
    clubLabel: null,
    raw,
  };
}

function tournamentEntry(kind: 'mtt' | 'spin' | 'sng', capacity: number): LobbyEntry {
  const raw: LobbyTournamentRow = {
    id: `${kind}-game`,
    name: `${kind.toUpperCase()} Game`,
    game_type: 'NLH',
    buy_in_amount: 50,
    buy_in_fee: 5,
    guaranteed_prize: 20_000,
    start_time: '2026-08-30T17:00:00.000Z',
    status: 'registering',
    current_players: 1,
    max_players: capacity,
    starting_chips: 30_000,
    blind_structure: JSON.stringify({ durationMinutes: 3 }),
  };
  return {
    id: raw.id,
    kind,
    name: raw.name,
    gameLabel: 'NLH',
    variantLabel: 'No Limit Hold’em',
    stakesLabel: null,
    stakesValue: 55,
    buyInLabel: '$50 + $5',
    buyInValue: 55,
    guaranteeLabel: '$20,000 GTD',
    guaranteeValue: 20_000,
    players: 1,
    capacity,
    startTime: raw.start_time,
    startValue: Date.parse(raw.start_time),
    speedLabel: 'Turbo',
    status: 'registering',
    statusLabel: 'Registering',
    live: true,
    rules: [rule('pko', 'PKO'), rule('rebuy', 'REBUY')],
    featured: true,
    isNew: false,
    vipOnly: false,
    hideClubName: false,
    clubLabel: null,
    raw,
  };
}

function lobbyContext(overrides: Partial<LobbyRowContext> = {}): LobbyRowContext {
  return {
    waitlistedIds: new Set(),
    seatedIds: new Set(),
    registeredIds: new Set(),
    favoriteIds: new Set(),
    onRegister: () => undefined,
    onUnregister: () => undefined,
    onSpinJoin: () => undefined,
    onJoinTable: () => undefined,
    onViewTable: () => undefined,
    onWaitlistToggle: () => undefined,
    ...overrides,
  };
}

describe('Arena game-card creation', () => {
  it('preserves the PLO chassis bytes already served under the original permanent URL', () => {
    const bytes = readFileSync(
      resolve(ROOT, 'public/assets/club-buttons/game-cards/plo/spade-plo-premium-v1/chassis.png')
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '9411a09e2a61040170b87300652239013677ffe75ec26f77d110d235372e8eb3'
    );
  });

  it('renders the approved replacement through its new URL and the same registry entry', () => {
    const file = 'plo/spade-plo-premium-v1/chassis-b0b05b302c99.png';
    const bytes = readFileSync(resolve(ROOT, 'public/assets/club-buttons/game-cards', file));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '460b8a9858ce5601e32d6ba20789bd0d48fedd9f0798f3f1aee561369424b4b2'
    );
    const asset = resolveArenaGameCardTemplate({ family: 'plo', presentation: 'mobile' }).skin
      .mobile.asset;
    expect(asset).toBe(`${import.meta.env.BASE_URL}assets/club-buttons/game-cards/${file}`);
    const html = renderToStaticMarkup(
      createElement(SpadePloCard, {
        data: arenaGameCardDataFromEntry(cashEntry('PLO')),
        actions: { primaryLabel: 'Join Table', secondaryLabel: 'View Table' },
      })
    );
    expect(html).toContain(`src="${asset}"`);
    expect(html).not.toContain('spade-plo-premium-v1/chassis.png');
  });

  it('automatically selects all five card families from existing lobby data', () => {
    expect(arenaGameCardDataFromEntry(tournamentEntry('mtt', 200)).family).toBe('mtt');
    expect(arenaGameCardDataFromEntry(cashEntry('NLH')).family).toBe('nlh');
    expect(arenaGameCardDataFromEntry(cashEntry('PLO8')).family).toBe('plo');
    expect(arenaGameCardDataFromEntry(tournamentEntry('spin', 3)).family).toBe('spins');
    expect(arenaGameCardDataFromEntry(tournamentEntry('sng', 2)).family).toBe('heads-up');
  });

  it('carries the real configured cash and MTT icons onto the generated card', () => {
    const cashRules = [rule('insurance'), rule('rit'), rule('nit_game'), rule('straddle')];
    expect(
      arenaGameCardDataFromEntry(cashEntry('NLH', cashRules)).rules.map(({ key }) => key)
    ).toEqual(['insurance', 'rit', 'nit_game', 'straddle']);
    expect(
      arenaGameCardDataFromEntry(tournamentEntry('mtt', 200)).rules.map(({ key }) => key)
    ).toEqual(['pko', 'rebuy']);
  });

  it('compacts four-digit cash buy-ins without rounding away useful hundreds', () => {
    expect(compactCashBuyInLabel('1,000 - 5,000')).toBe('1K - 5K');
    expect(compactCashBuyInLabel('400 - 1,200')).toBe('400 - 1.2K');
    expect(compactCashBuyInLabel('80 - 400')).toBe('80 - 400');
  });

  it('keeps one central desktop/mobile hardware definition for every family', () => {
    expect(Object.keys(ARENA_GAME_CARD_TEMPLATE_REGISTRY).sort()).toEqual([
      'heads-up',
      'mtt',
      'nlh',
      'plo',
      'spins',
    ]);
    expect(validateArenaGameCardRegistry()).toEqual([]);
    const approvedDefaults = {
      mtt: {
        id: 'shark-mtt-v2',
        version: 2,
        mobileAsset: /mtt\/shell-mobile-v4-reference-clean\.png$/,
      },
      nlh: {
        id: 'spade-nlh-premium-v1',
        version: 1,
        mobileAsset: /nlh\/spade-nlh-premium-v1\/chassis\.png$/,
      },
      plo: {
        id: 'spade-plo-premium-v1',
        version: 1,
        mobileAsset: /plo\/spade-plo-premium-v1\/chassis-b0b05b302c99\.png$/,
      },
      spins: {
        id: 'shark-spins-premium-v1',
        version: 1,
        mobileAsset: /spins\/shark-spins-premium-v1\/chassis\.png$/,
      },
      'heads-up': {
        id: 'shark-headsup-premium-v1',
        version: 1,
        mobileAsset: /heads-up\/shark-headsup-premium-v1\/chassis\.png$/,
      },
    } as const;

    for (const family of Object.keys(ARENA_GAME_CARD_TEMPLATE_REGISTRY) as Array<
      keyof typeof ARENA_GAME_CARD_TEMPLATE_REGISTRY
    >) {
      const resolved = resolveArenaGameCardTemplate({ family, presentation: 'mobile' });
      const approved = approvedDefaults[family];
      expect(resolved.skinId).toBe(approved.id);
      expect(resolved.skin.lifecycle).toBe('approved');
      expect(resolved.skin.version).toBe(approved.version);
      expect(resolved.skin.desktop.asset).toMatch(/shell-desktop-v2\.webp$/);
      expect(resolved.skin.mobile.asset).toMatch(approved.mobileAsset);
      expect(Object.keys(resolved.template.zones).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('centers every family on one visible-hardware rail and keeps live fills inside the chrome', () => {
    expect(TABLE_CSS).toMatch(/\.arena-lobby-card-list\s*\{[^}]*justify-items:\s*center/s);
    expect(TABLE_CSS).toMatch(/\.arena-lobby-card-list > div\s*\{[^}]*justify-items:\s*center/s);

    for (const family of ['mtt', 'nlh', 'plo', 'spins', 'heads-up']) {
      expect(CARD_CSS).toContain(`.arena-game-card--${family}[data-skin`);
      expect(CARD_CSS).toMatch(
        new RegExp(
          `\\.arena-game-card--${family}\\[data-skin[^}]+--agc-mobile-canvas-width:\\s*[0-9.]+%`,
          's'
        )
      );
    }

    expect(CARD_CSS).toMatch(
      /\[data-skin\$='-v2'\] \.agc-action\s*\{[^}]*background:\s*transparent[^}]*box-shadow:\s*none/s
    );
    expect(CARD_CSS).toMatch(
      /\[data-skin\$='-v2'\] \.agc-action::before\s*\{[^}]*inset:\s*var\(--agc-action-fill-inset,/s
    );
  });

  it('maps live MTT player state to blue, red, gold, and disabled actions', () => {
    const entry = tournamentEntry('mtt', 200);
    const ctx = (registered: boolean) =>
      lobbyContext({ registeredIds: registered ? new Set([entry.id]) : new Set() });

    expect(arenaGameCardActionsForEntry(entry, ctx(false))).toMatchObject({
      primaryLabel: 'Register',
      primaryTone: 'blue',
    });
    expect(arenaGameCardActionsForEntry(entry, ctx(true))).toMatchObject({
      primaryLabel: 'Unregister',
      primaryTone: 'red',
    });

    const lateReg = { ...entry, status: 'late_reg' as const, statusLabel: 'Late Reg' };
    expect(arenaGameCardActionsForEntry(lateReg, ctx(false))).toMatchObject({
      primaryLabel: 'Late Register',
      primaryTone: 'gold',
    });
    expect(arenaGameCardActionsForEntry(lateReg, ctx(true))).toMatchObject({
      primaryLabel: 'Return To Tournament',
      primaryTone: 'gold',
    });

    const full = {
      ...entry,
      players: entry.capacity,
      status: 'full' as const,
      statusLabel: 'Full',
    };
    expect(arenaGameCardActionsForEntry(full, ctx(false))).toMatchObject({
      primaryLabel: 'Tournament Full',
      primaryTone: 'neutral',
      primaryDisabled: true,
    });
  });

  it('keeps cash, waitlist, spin, and heads-up actions live and state-driven', () => {
    const cash = cashEntry('NLH');
    expect(arenaGameCardActionsForEntry(cash, lobbyContext())).toMatchObject({
      primaryLabel: 'Join Table',
      primaryTone: 'blue',
      primaryDisabled: false,
    });
    expect(
      arenaGameCardActionsForEntry(cash, lobbyContext({ seatedIds: new Set([cash.id]) }))
    ).toMatchObject({ primaryLabel: 'Return To Game', primaryTone: 'green' });

    const fullCash = { ...cash, status: 'full' as const, statusLabel: 'Full' };
    expect(arenaGameCardActionsForEntry(fullCash, lobbyContext())).toMatchObject({
      primaryLabel: 'Join Waitlist',
      primaryTone: 'blue',
      primaryDisabled: false,
    });
    expect(
      arenaGameCardActionsForEntry(
        fullCash,
        lobbyContext({ waitlistedIds: new Set([fullCash.id]) })
      )
    ).toMatchObject({ primaryLabel: 'Leave Waitlist', primaryTone: 'red' });

    const spin = tournamentEntry('spin', 3);
    expect(arenaGameCardActionsForEntry(spin, lobbyContext())).toMatchObject({
      primaryLabel: 'Sit Down',
      primaryTone: 'blue',
      primaryDisabled: false,
    });
    expect(
      arenaGameCardActionsForEntry(spin, lobbyContext({ registeredIds: new Set([spin.id]) }))
    ).toMatchObject({ primaryLabel: 'Return To Game', primaryTone: 'green' });
    expect(
      arenaGameCardActionsForEntry(
        { ...spin, status: 'running' as const, statusLabel: 'Running' },
        lobbyContext()
      )
    ).toMatchObject({ primaryLabel: 'Watch', primaryTone: 'neutral' });

    const headsUp = tournamentEntry('sng', 2);
    expect(arenaGameCardActionsForEntry(headsUp, lobbyContext())).toMatchObject({
      primaryLabel: 'Sit Down',
      primaryTone: 'blue',
    });
    expect(
      arenaGameCardActionsForEntry(headsUp, lobbyContext({ registeredIds: new Set([headsUp.id]) }))
    ).toMatchObject({ primaryLabel: 'Return To Game', primaryTone: 'green' });
  });
});
