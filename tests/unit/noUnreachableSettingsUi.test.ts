/**
 * A CONTROL THAT NOBODY CAN REACH IS WORSE THAN A MISSING ONE.
 *
 * Dan 2026-08-26, across the settings and mobile passes: "make sure they all
 * work, change and update in real time... every single functionality, feature
 * and detail... working, built, and functional when clicked."
 *
 * The settings audit found an entire parallel settings UI that no route could
 * reach — `components/settings/{SettingsPanel,AppearanceSettings,Sound,
 * Notification,Privacy,Gameplay}` — plus two correct-but-orphaned pickers
 * (`customization/TableFeltSelector`, two `ThemeSelector`s). They formed a
 * CLOSED LOOP: each barrel exported the components, the components imported
 * each other, and nothing outside the folder imported the barrel.
 *
 * That is not merely dead weight. `AppearanceSettings` wrote
 * `localStorage['sp_appearance_settings']` — a key whose only reader was its
 * own line 35 — and then rendered "Settings Saved". A future reader finding it
 * would reasonably conclude the felt-colour feature exists. It does not; the
 * real one is ThemeSettingsModal.
 *
 * All of it was deleted. These tests stop it coming back, and stop the same
 * shape appearing somewhere new.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = (p: string) => resolve(__dirname, '../..', p);

/** Files removed in the 2026-08-26 sweep. Each was verifiably unreachable. */
const DELETED = [
  'src/components/settings/SettingsPanel.tsx',
  'src/components/settings/AppearanceSettings.tsx',
  'src/components/settings/SoundSettings.tsx',
  'src/components/settings/NotificationSettings.tsx',
  'src/components/settings/PrivacySettings.tsx',
  'src/components/settings/GameplaySettings.tsx',
  'src/components/settings/index.ts',
  'src/components/customization/TableFeltSelector.tsx',
  'src/components/customization/ThemeSelector.tsx',
  'src/components/table/ThemeSelector.tsx',
];

describe('the unreachable settings UI stays deleted', () => {
  it.each(DELETED)('%s does not exist', (file) => {
    expect(
      existsSync(root(file)),
      `${file} is back. It had no call site — check whether it is actually ` +
        `mounted this time, or whether the closed loop has simply been recreated.`
    ).toBe(false);
  });

  it('the fake-save storage key is gone with it', () => {
    /* Its only reader was the file that wrote it. A key like that is how a
       "saved" toast ends up meaning nothing. */
    const src = readdirSync(root('src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => typeof f === 'string' && /\.(ts|tsx)$/.test(f))
      .map((f) => readFileSync(root(`src/${f}`), 'utf8'))
      .join('\n');
    expect(src, 'sp_appearance_settings is back — is anything READING it?').not.toContain(
      'sp_appearance_settings'
    );
  });
});

describe('the customization barrel only exports things that are reachable', () => {
  const raw = readFileSync(root('src/components/customization/index.ts'), 'utf8');
  /* Comments are stripped before asserting: the barrel's own note NAMES the
     two deleted pickers so the next reader knows where the felt picker went,
     and an assertion against raw text would match that explanation and fail
     on correct code. Assert the export statements. */
  const barrel = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('no longer re-exports the deleted pickers', () => {
    expect(barrel).not.toMatch(/ThemeSelector/);
    expect(barrel).not.toMatch(/TableFeltSelector/);
  });

  it('still exports the avatar customizer that IS mounted', () => {
    expect(barrel).not.toMatch(/CardBackSelector/);
    expect(barrel).toMatch(/AvatarCustomizer/);
  });
});

describe('the board no longer carries rules for markup it deleted', () => {
  /* The ghost turn/river slots were removed (Dan: "remove the ghost place
     holders for the turn and river that appear after the flop") and their
     styles went with them, in three stylesheets. A rule for an element that
     cannot render is the CSS version of the same lie. */
  const cssFiles = [
    'src/components/table/CommunityCards.css',
    'src/components/table/TableVisualHotfix.css',
    'src/pages/TablePage.css',
  ];

  it.each(cssFiles)('%s has no live .community-cards__placeholder rule', (file) => {
    const css = readFileSync(root(file), 'utf8');
    // Comments explaining the deletion are expected and fine; a SELECTOR is not.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/\.community-cards__placeholder/);
  });
});
