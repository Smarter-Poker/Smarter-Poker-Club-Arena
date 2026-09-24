/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NO AUTO TABLE SWITCHING — LAW (Dan 2026-08-28, binding, NO EXCEPTIONS)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verbatim: "SOMETIMES WHEN YOU ARE RUNNING OUT OF TIME ON A TABLE, IT AUTO
 * CHANGES TABLES, OR AUTO SWIPES TO THE TABLE RUNNING OUT OF TIME... THAT CAN
 * NOT HAPPEN. YOU CAN NEVER EVER AUTO CHANGE TABLES FOR A USER, THEY MUST
 * CHANGE IT BY THEM SELF."
 *
 * Two features moved the active table without a user gesture and both are
 * deleted: the urgency auto-switch (yanked focus to any table under 5 seconds
 * on its turn clock) and the action queue (advanced to the next waiting table
 * the moment the hero acted). Every SIGNAL survives — the background-urgency
 * bell, the tab flash and haptics, the browser-tab retitle. Only the MOVE is
 * forbidden.
 *
 * If you are reading this because a pin below went red: you are re-adding
 * behaviour Dan explicitly banned. Do not. A player's view moves when the
 * player moves it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../', p), 'utf8');
const MULTI = read('src/pages/MultiTablePage.tsx');
const SETTINGS_HOOK = read('src/hooks/useUserTableSettings.ts');

describe('the view never moves itself', () => {
  it('MultiTablePage reads neither retired auto-mover setting', () => {
    expect(MULTI).not.toContain('userSettings.multi_auto_switch');
    expect(MULTI).not.toContain('userSettings.multi_action_queue');
  });

  it('the deleted machinery stays deleted', () => {
    for (const tok of ['autoSwitchedRef', 'queueSwitchTimerRef', 'prevActiveTurnRef']) {
      expect(MULTI).not.toContain(tok);
    }
  });

  it('the law is written where the next agent will read it', () => {
    expect(MULTI).toContain('NO AUTO TABLE SWITCHING — LAW');
    expect(MULTI).toContain('CHANGE IT BY THEM SELF');
  });

  it('the settings panel no longer offers the toggles', () => {
    expect(SETTINGS_HOOK).not.toMatch(/key: 'multi_auto_switch'/);
    expect(SETTINGS_HOOK).not.toMatch(/key: 'multi_action_queue'/);
  });

  it('no timer- or urgency-driven setActiveIndex exists', () => {
    // Every setActiveIndex call site must be a user gesture (tap/swipe/open/
    // close/Take Seat), the mount-time restore of the player's OWN last tab,
    // or the bounds repair when the tables array shrinks. The two deleted
    // auto-movers were the only sites keyed off the turn clock; this guards
    // their shape from returning under a new name.
    const sites = MULTI.split('setActiveIndex');
    for (let i = 1; i < sites.length; i++) {
      // Look at the 400 chars BEFORE each call for turn-clock coupling.
      const before = sites[i - 1].slice(-400);
      expect(before).not.toMatch(/secondsLeft\([^)]*\)\s*[<>]/);
      expect(before).not.toMatch(/turnDeadlineMs[^;]{0,80}[<>]/);
    }
  });
});

/**
 * MULTI-DAY: THE DAY 2 SEAT IS AN ALERT, NEVER A MOVE (design section 7).
 *
 * When a bagged event resumes, the player's Day 2 chair appears on the
 * tournament Overview as "Your Day 2 Seat" with an Open Table button. The
 * panel navigates only from that button's onClick, and the details page's
 * start-of-event auto-open stands down for any later day.
 */
describe('the Day 2 seat never moves the player', () => {
  const PANEL = read('src/components/tournament/details/MultiDayStagePanel.tsx');
  const DETAILS = read('src/pages/tournament/TournamentDetails.tsx');

  it('the panel navigates only from the Open Table click', () => {
    const calls = PANEL.match(/navigate\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(PANEL).toMatch(/onClick=\{\(\) => navigate\(`\/table\/\$\{tableId\}`\)\}/);
    expect(PANEL).not.toMatch(/useEffect/);
    expect(PANEL).not.toMatch(/setActiveIndex|TABLE_SEATED|masterBus/);
  });

  it('the details auto-open stands down on a later day', () => {
    const effect = DETAILS.slice(
      DETAILS.indexOf('if (suppressAutoOpenTable) return;'),
      DETAILS.indexOf('autoOpenedTableRef.current = true;')
    );
    expect(effect).toContain('if (laterDay || stageViewLoading) return;');
    expect(DETAILS).toMatch(
      /const laterDay = baggedNow \|\| sawBagged \|\| \(stageView\?\.currentStage\?\.stageNo \?\? 1\) > 1;/
    );
  });
});
