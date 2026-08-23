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
 * The database is the source of truth. These values are the live column
 * defaults, read from information_schema on 2026-08-23:
 *
 *   multi_auto_switch     NOT NULL DEFAULT true
 *   multi_action_queue    NOT NULL DEFAULT true
 *   multi_desktop_alerts  NOT NULL DEFAULT false
 *   multi_shared_socket   NOT NULL DEFAULT false
 *
 * If you change one, change it in a migration FIRST and then here.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_TABLE_SETTINGS } from '../src/hooks/useUserTableSettings';

/** The live `user_table_settings` column defaults. */
const DB_COLUMN_DEFAULTS = {
  multi_auto_switch: true,
  multi_action_queue: true,
  multi_desktop_alerts: false,
  multi_shared_socket: false,
} as const;

describe('DEFAULT_USER_TABLE_SETTINGS agrees with the database', () => {
  for (const [key, dbDefault] of Object.entries(DB_COLUMN_DEFAULTS)) {
    it(`${key} defaults to ${dbDefault}, as the column does`, () => {
      expect(DEFAULT_USER_TABLE_SETTINGS[key as keyof typeof DB_COLUMN_DEFAULTS]).toBe(dbDefault);
    });
  }

  it('keeps the shared-socket beta OFF until somebody opts in', () => {
    // The whole point of a beta flag. A default of true would enrol every user
    // with no settings row into an unsoaked transport change.
    expect(DEFAULT_USER_TABLE_SETTINGS.multi_shared_socket).toBe(false);
  });

  it('never starts desktop alerts ON, because permission is only asked on tap', () => {
    expect(DEFAULT_USER_TABLE_SETTINGS.multi_desktop_alerts).toBe(false);
  });
});
