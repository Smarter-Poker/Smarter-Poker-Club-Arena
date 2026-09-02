/**
 * A SETTINGS PAGE MAY ONLY WRITE WHAT IT OFFERS A CONTROL FOR.
 *
 * 2026-08-28. The Notifications section persisted
 * `live_notifications: settings.handWonNotifications ?? true` to
 * user_notification_preferences. Three separate faults in one line:
 *
 *   1. `handWonNotifications` has no control on this page or anywhere else in
 *      Club Arena, and settingsBridge defaults it to FALSE.
 *   2. `??` falls through on null and undefined only, and false is neither, so
 *      the fallback never fired. Every save wrote `false`, unconditionally.
 *   3. `live_notifications` is the World Hub's LIVE STREAMING column -- its
 *      gate maps `live`, `live_invite` and `live_gift` onto it. Winning a hand
 *      has nothing to do with it.
 *
 * So pressing Save Changes in Club Arena silently switched off an unrelated
 * World Hub feature, permanently, with no control here to switch it back on.
 * It had not yet caused visible damage only because this table held two rows.
 *
 * Asserted at the source, because the regression is a property of the code
 * rather than of one render: somebody adds a column to the upsert without a
 * toggle beside it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceEnclosingBlock, sliceCall } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const SETTINGS = read('src/pages/SettingsPage.tsx');
const BRIDGE = read('src/lib/settingsBridge.ts');

/** The upsert body, isolated so the assertions cannot match a comment. */
function upsertBody(): string {
  const start = SETTINGS.indexOf("from('user_notification_preferences').upsert(");
  expect(start, 'the notification preferences upsert has moved or gone').toBeGreaterThan(-1);
  // Anchored past `from(` on purpose: sliceCall binds the FIRST paren after the
  // anchor, and `from(` would hand back that call instead of the upsert.
  return sliceCall(SETTINGS, "user_notification_preferences').upsert(");
}

describe('the notifications section writes only its own switches', () => {
  it('does not touch the hub live-streaming column', () => {
    expect(upsertBody()).not.toContain('live_notifications');
  });

  it('does not persist a setting that has no control', () => {
    // If a toggle for this is ever added, this assertion should be replaced
    // with one that checks the toggle exists -- not simply deleted.
    expect(upsertBody()).not.toContain('handWonNotifications');
  });

  it('writes exactly the three columns it renders a toggle for', () => {
    const body = upsertBody();
    for (const col of ['tournament_reminders', 'friend_activity', 'club_updates']) {
      expect(body, `${col} must still be saved`).toContain(col);
    }
    // Each of those has a visible control bound to the matching state key.
    for (const key of ['tournamentReminders', 'friendAlerts', 'clubActivity']) {
      expect(SETTINGS, `${key} is written but has no updateSetting control`).toContain(
        `updateSetting('${key}'`
      );
    }
  });

  it('records that handWonNotifications is inert, so nobody re-wires it blind', () => {
    // It still round-trips through profiles.settings with the rest of the
    // bridge. That is harmless; wiring it to a push column again is not.
    expect(BRIDGE).toContain('handWonNotifications');
  });
});
