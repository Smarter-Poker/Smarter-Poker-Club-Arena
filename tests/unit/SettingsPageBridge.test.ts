/**
 * THE SETTINGS PAGE MUST REACH THE TABLE (2026-08-18).
 *
 * /settings persisted ~30 options to localStorage and to profiles.settings,
 * showed "Settings saved!", and changed nothing at the table. The table reads a
 * different store — useTableSettings, backed by the club-arena-table-settings
 * key — and TablePage's SETTINGS_UPDATED listener forwarded exactly two keys,
 * one of which the page never sent.
 *
 * Two separate defects hid inside that, and both are pinned here:
 *
 *   1. The bridge itself. saveSettings now feeds updateSettings() on the table's
 *      own store, so every mapped key lands where the table looks.
 *   2. Card Back Style offered 'classic' | 'modern' | 'minimal' | 'premium'.
 *      The renderer emits a `.card-back--<id>` class, and CardImage.css defines
 *      none of those four ids — so the control reached a real consumer and
 *      still did nothing visible for every option. That is the failure mode a
 *      pure wiring test would miss, so this file reads the CSS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  toTableSettings,
  fromTableSettings,
  rollbackFailedCardBack,
  CARD_BACKS,
  DEFAULT_SETTINGS,
  type UserSettings,
} from '../../src/lib/settingsBridge';
import type { TableUserSettings } from '../../src/hooks/useTableSettings';

/** Keys of the table store that TablePage genuinely reads today. */
const TABLE_CONSUMES = [
  'isSoundEnabled',
  'soundVolume',
  'cardBack',
  'fourColorDeck',
  'animationSpeed',
  'showPotOdds',
  'confirmAllIn',
  // Dan 2026-08-28: consumed by TournamentStartingTicker (the scrolling
  // announcement marquee bails out when this is false).
  'showTicker',
] as const;

/* `autoMuckWinners` LEFT THIS LIST 2026-08-29, and its control left the page
   with it. It was never really "consumed by the table": the prompt it governs
   sits behind `const ASK_TO_SHOW_ON_UNCONTESTED_WIN = false` in TablePage and
   has done since 2026-08-23, on Dan's ruling that the prompt should not exist.
   So it belonged in TABLE_IGNORES all along — this file's own words, "mapping a
   page control onto one of these would recreate the original bug in a form that
   looks wired", describe exactly what was happening. Writing it is now pinned
   as a regression by tests/unit/settingsHaveOneOwner.test.ts. */

/**
 * Keys that exist on the table store but that nothing at the table reads.
 * Mapping a page control onto one of these would recreate the original bug in
 * a form that looks wired.
 */
const TABLE_IGNORES = [
  'autoMuck',
  'autoPostBlinds',
  'showBetSizePresets',
  'autoMuckWinners',
] as const;

const sample: UserSettings = {
  ...DEFAULT_SETTINGS,
  soundEnabled: false,
  soundVolume: 42,
  cardBack: 'dragon',
  fourColorDeck: true,
  animationSpeed: 'fast',
  showPotOdds: true,
  confirmAllIn: false,
};

describe('the settings page writes into the store the table reads', () => {
  it('maps every shared control onto a key the table actually consumes', () => {
    const mapped = toTableSettings(sample);
    for (const key of Object.keys(mapped)) {
      expect(TABLE_CONSUMES).toContain(key);
    }
    // and covers all of them — a control silently dropped from the mapping is
    // the same bug as no mapping at all
    for (const key of TABLE_CONSUMES) {
      expect(mapped).toHaveProperty(key);
    }
  });

  it('never writes a table-store key that nothing at the table reads', () => {
    const mapped = toTableSettings(sample) as Record<string, unknown>;
    for (const dead of TABLE_IGNORES) {
      expect(mapped[dead]).toBeUndefined();
    }
  });

  it('carries the values through unchanged', () => {
    const m = toTableSettings(sample);
    expect(m.isSoundEnabled).toBe(false);
    expect(m.soundVolume).toBe(42);
    expect(m.cardBack).toBe('dragon');
    expect(m.fourColorDeck).toBe(true);
    expect(m.showPotOdds).toBe(true);
    expect(m.confirmAllIn).toBe(false);
  });

  it('does not invert animation speed — the CSS value is a duration multiplier', () => {
    const slow = toTableSettings({ ...sample, animationSpeed: 'slow' }).animationSpeed!;
    const normal = toTableSettings({ ...sample, animationSpeed: 'normal' }).animationSpeed!;
    const fast = toTableSettings({ ...sample, animationSpeed: 'fast' }).animationSpeed!;
    // --animation-speed multiplies the duration: bigger = slower.
    expect(slow).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(fast);
    expect(fast).toBeGreaterThan(0);
  });

  it('round-trips, so opening the page shows what the table is using', () => {
    const table = {
      ...toTableSettings(sample),
    } as TableUserSettings;
    const back = fromTableSettings(table, DEFAULT_SETTINGS);
    expect(back.soundEnabled).toBe(sample.soundEnabled);
    expect(back.soundVolume).toBe(sample.soundVolume);
    expect(back.cardBack).toBe(sample.cardBack);
    expect(back.fourColorDeck).toBe(sample.fourColorDeck);
    expect(back.animationSpeed).toBe(sample.animationSpeed);
    expect(back.showPotOdds).toBe(sample.showPotOdds);
    expect(back.confirmAllIn).toBe(sample.confirmAllIn);
  });

  it('falls back rather than showing a card back the renderer cannot draw', () => {
    const table = { ...toTableSettings(sample), cardBack: 'not_a_real_back' } as TableUserSettings;
    expect(fromTableSettings(table, DEFAULT_SETTINGS).cardBack).toBe(DEFAULT_SETTINGS.cardBack);
  });

  it('restores the durable card back when the cloud appearance write fails', () => {
    const restored = rollbackFailedCardBack({ ...sample, cardBack: 'gold' }, 'classic_red');
    expect(restored.cardBack).toBe('classic_red');
    expect(restored.soundVolume).toBe(sample.soundVolume);
  });

  it('sends table visuals to the one live Table Studio instead of a duplicate dropdown', () => {
    const page = readFileSync(resolve(__dirname, '../../src/pages/SettingsPage.tsx'), 'utf-8');
    expect(page).toContain('<ThemeSettingsModal');
    expect(page).toContain('Table Studio');
    expect(page).not.toContain('Card Back Style');
    expect(page).not.toContain('applyTableAppearance');
  });
});

describe('every card back on offer is one the renderer can actually draw', () => {
  const css = readFileSync(resolve(__dirname, '../../src/components/table/CardImage.css'), 'utf-8');

  it('has a .card-back--<id> rule for each option', () => {
    expect(CARD_BACKS.length).toBeGreaterThan(0);
    const missing = CARD_BACKS.filter((b) => !css.includes(`.card-back--${b.id}`)).map((b) => b.id);
    expect(missing).toEqual([]);
  });

  it('the default is one of the offered options', () => {
    expect(CARD_BACKS.map((b) => b.id)).toContain(DEFAULT_SETTINGS.cardBack);
  });
});
