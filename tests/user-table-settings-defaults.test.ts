/**
 * THE TOGGLE MUST NOT LIE.
 *
 * `TableSettingsPanel` renders every switch straight from
 * DEFAULT_USER_TABLE_SETTINGS until the user's row loads. So when a client
 * default disagrees with the column default in `user_table_settings`, a user
 * with no row is shown the OPPOSITE of what is really configured — and their
 * first tap "turns off" something that was never on.
 *
 * Found 2026-08-23 on two settings at once:
 *
 *   multi_shared_socket  client true / DB false
 *   multi_desktop_alerts client true / DB false
 *
 * For the shared socket that is worse than cosmetic. The `ca_ws_mux` mirror is
 * only written inside `if (data)`, so with no row EngineStateClient never sees
 * the flag and keeps opening per-table sockets: the panel said BETA ON, the
 * transport was OFF, and the beta could not be soaked because nobody could
 * tell who was running it. For desktop alerts, an ON switch with no
 * Notification permission behind it contradicts the rule that the app never
 * prompts on its own.
 *
 * AND IT IS NOT ONLY A DISPLAY BUG. The save path is a PER-KEY upsert:
 *
 *     upsert({ user_id, [key]: newValue }, { onConflict: 'user_id' })
 *
 * so for a user with no row, changing ANY one setting inserts the row and
 * every OTHER column takes its column default. Where the two disagreed, the
 * user's unrelated settings silently flipped underneath them and stuck, on
 * every device. `card_slide` and `enhanced_view` did exactly that: on since
 * forever, off the moment you touched anything else.
 *
 * Fixed in the direction that preserves what users already have — the two
 * betas came DOWN to the database (never enrol anyone silently), the two
 * display settings brought the DATABASE up to the client (that is what people
 * have actually been seeing).
 *
 * Every boolean is pinned below, not just the ones that were wrong: the first
 * pass here checked only the four `multi_*` settings and missed the other two.
 * The database is the source of truth — change it in a migration FIRST, then
 * here.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_TABLE_SETTINGS } from '../src/hooks/useUserTableSettings';
import { DEFAULT_TABLE_USER_SETTINGS } from '../src/hooks/useTableSettings';

/**
 * EVERY boolean column's live default, read from information_schema on
 * 2026-08-23. Not just the ones that were wrong — the first pass here checked
 * only the four `multi_*` settings and missed `card_slide` and
 * `enhanced_view`, which were broken in exactly the same way.
 */
const DB_COLUMN_DEFAULTS = {
  auto_time_bank: false,
  card_slide: true,
  card_squeeze: false,
  cards_pre_sort: true,
  emoji_enabled: true,
  enhanced_view: true,
  gestures_enabled: false,
  highlight_active_players: true,
  multi_action_queue: true,
  multi_auto_switch: true,
  multi_desktop_alerts: false,
  // 2026-08-24: flipped to true by 20260824_shared_socket_default_on.sql —
  // the shared socket left beta and became the default transport (Dan's
  // global-connectivity directive). Applied to production before merge.
  multi_shared_socket: true,
  show_avatars: true,
  show_badges: false,
  show_stack_in_bb: false,
  skip_animations: false,
  text_message: true,
  use_alias: false,
  voice_message: true,
} as const;

describe('DEFAULT_USER_TABLE_SETTINGS agrees with the database', () => {
  for (const [key, dbDefault] of Object.entries(DB_COLUMN_DEFAULTS)) {
    it(`${key} defaults to ${dbDefault}, as the column does`, () => {
      expect(DEFAULT_USER_TABLE_SETTINGS[key as keyof typeof DB_COLUMN_DEFAULTS]).toBe(dbDefault);
    });
  }

  it('shared socket defaults ON — it is the transport now, not a beta', () => {
    // 2026-08-24 (Dan, binding): per-join TLS handshakes were costing every
    // table join 300-600ms globally. The mux is the default transport; the
    // settings toggle remains the per-user kill switch (writes ca_ws_mux='0').
    expect(DEFAULT_USER_TABLE_SETTINGS.multi_shared_socket).toBe(true);
  });

  it('never starts desktop alerts ON, because permission is only asked on tap', () => {
    expect(DEFAULT_USER_TABLE_SETTINGS.multi_desktop_alerts).toBe(false);
  });
});

/**
 * THE SAME HAZARD, FOR THE TABLE SETTINGS PANEL.
 *
 * 2026-08-28: the panel's own keys moved off a per-browser localStorage blob and
 * onto this row, so settings follow the user instead of the machine (Dan: "THEY
 * NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL PAGES").
 *
 * They are written by the SAME per-key upsert, so they inherit the same trap
 * described at the top of this file: for a user with no row, changing any ONE
 * setting inserts the row and every OTHER column takes its SQL default. If a
 * column default ever drifts from the client default, unrelated settings flip
 * underneath the player and stick, on every device.
 *
 * The migration that added the columns asserts the pairing at apply time. This
 * asserts it from the client side, which is the half that gets edited.
 *
 * Live column defaults read from information_schema on 2026-08-28.
 */
const TABLE_SETTINGS_COLUMN_DEFAULTS = {
  isSoundEnabled: true, // sound_enabled
  soundVolume: 70, // sound_volume
  isHapticEnabled: true, // haptic_enabled
  animationSpeed: 1, // animation_speed
  theme: 'black', // color_theme
  fourColorDeck: false, // four_color_deck
  showPotOdds: false, // show_pot_odds
  showBetSizePresets: true, // show_bet_size_presets
  showTicker: true, // show_ticker (pre-existing column)
  autoMuck: true, // auto_muck
  autoMuckExplicit: false, // auto_muck_explicit
  autoMuckWinners: false, // auto_muck_winners
  autoPostBlinds: true, // auto_post_blinds
  confirmAllIn: true, // confirm_all_in
  cardBack: 'classic_blue', // card_back
} as const;

describe('DEFAULT_TABLE_USER_SETTINGS agrees with the database', () => {
  for (const [key, dbDefault] of Object.entries(TABLE_SETTINGS_COLUMN_DEFAULTS)) {
    it(`${key} defaults to ${String(dbDefault)}, as its column does`, () => {
      expect(DEFAULT_TABLE_USER_SETTINGS[key as keyof typeof TABLE_SETTINGS_COLUMN_DEFAULTS]).toBe(
        dbDefault
      );
    });
  }

  it('auto-muck is ON by default, and the explicit marker is OFF', () => {
    /* Dan 2026-08-25: "ENABLE AUTO MUCK BY DEFAULT, AND MAKE USERS TURN IT OFF
       MANUALLY." The marker must default false or the load-time migration would
       treat every stored false as a deliberate choice. */
    expect(DEFAULT_TABLE_USER_SETTINGS.autoMuck).toBe(true);
    expect(DEFAULT_TABLE_USER_SETTINGS.autoMuckExplicit).toBe(false);
  });
});
