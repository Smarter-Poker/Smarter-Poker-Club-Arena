/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTHING THE PLAYER OPENED EVER CLOSES ITSELF — LAW (Dan 2026-08-31, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verbatim: "WHEN YOU ARE PLAYING ON THE LIVE PAGE... YOU CANT CLICK ON THE
 * STATS, OR HIT ANYTHING INSIDE THE AVATAR SELECTION AND KEEP IT UP, IT AUTO
 * CLOSES WHEN ACTION IS ON YOU AND THAT SHOULDN'T HAPPEN... IT SHOULD NEVER
 * AUTO CLOSE."
 *
 * A panel closes when the PLAYER closes it: the X, the Escape key, or a tap on
 * the backdrop. Nothing else. Not the turn arriving, not a new hand, not a
 * street changing, and not a stray click that only LOOKS like it landed
 * outside.
 *
 * Three separate mechanisms were breaking this rule on 2026-08-31 and they had
 * nothing in common, which is why fixing one never fixed the complaint:
 *
 *   1. HeroHubPanel called onClose() from an effect keyed on `isHeroTurn`. The
 *      hub is the entry point for Stats, Profile, the avatar picker, Identity
 *      and Table Settings, so that single effect closed all five.
 *   2. TableMenu's native click-outside listener treated clicks INSIDE the
 *      avatar picker as outside, because AvatarGallery is a React child that
 *      portals to document.body and so lives outside `menuRef`.
 *   3. SettingsPanel's backdrop onClick fired for the same clicks by the
 *      opposite route: a React portal still bubbles up the REACT tree, so a
 *      tap on an avatar tile reached the backdrop past the panel's own
 *      stopPropagation.
 *
 * The hazard that produced #1 was real — the hub covers the action bar, and a
 * covered Fold button costs a hand. The answer is to YIELD (drop the backdrop's
 * pointer-events and lift the panel above `--sp-action-reserve`), never to take
 * the panel away from the player who opened it.
 *
 * If a pin below goes red you are re-shipping one of those three bugs. Fix your
 * change. If you deliberately replace a mechanism with a better one, move the
 * pin to the new mechanism IN THE SAME COMMIT and say so in the PR.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const HERO_HUB = read('src/components/table/HeroHubPanel.tsx');
const HERO_HUB_CSS = read('src/components/table/HeroHubPanel.css');
const TABLE_MENU = read('src/components/table/TableMenu.tsx');
const SETTINGS_PANEL = read('src/components/table/SettingsPanel.tsx');

/** Every .tsx under src/, so a new panel is covered the day it is written. */
function allTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allTsx(full, out);
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * The turn clock, by every name this codebase gives it. A dep array mentioning
 * one of these is an effect that fires BECAUSE the action moved.
 */
const TURN_TOKENS =
  /\b(isHeroTurn|isHeroTurnContext|isMyTurn|currentPlayerSeat|actionOn|toAct|activeSeat|turnDeadlineMs)\b/;

/** Closing, by every name this codebase gives it. */
const CLOSES = /\bonClose\(\)|\bset(?:Show|Is|Open)\w*\(\s*false\s*\)|\bsetActiveModal\(\s*null\s*\)/;

/**
 * Pull out every `useEffect(() => { ... }, [deps])` with its dependency array.
 *
 * The non-greedy body plus the indented `}, [` terminator is the shape this
 * codebase actually writes; the self-test below proves the matcher fires on the
 * real deleted code rather than quietly matching nothing, which is how a
 * source-scanning law goes vacuous without anyone noticing.
 */
function effectsOf(source: string): Array<{ body: string; deps: string }> {
  const found: Array<{ body: string; deps: string }> = [];
  const re = /useEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*\[([^\]]*)\]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) found.push({ body: m[1], deps: m[2] });
  return found;
}

describe('the detector is not vacuous', () => {
  /**
   * A law that scans source can pass because the codebase is clean or because
   * the scanner is broken, and those look identical from the outside. This is
   * the exact code deleted from HeroHubPanel on 2026-08-31; if the matcher
   * stops recognising it, every other pin in this file is worthless and this
   * test says so first.
   */
  const THE_DELETED_BUG = `
  useEffect(() => {
    if (isOpen && isHeroTurn) onClose();
  }, [isOpen, isHeroTurn, onClose]);
`;

  it('recognises the effect that was deleted', () => {
    const effects = effectsOf(THE_DELETED_BUG);
    expect(effects, 'the useEffect matcher no longer parses this codebase').toHaveLength(1);
    expect(TURN_TOKENS.test(effects[0].deps)).toBe(true);
    expect(CLOSES.test(effects[0].body)).toBe(true);
  });

  it('the ActionPanel carve-out is shaped tightly enough to stay honest', () => {
    // The sanctioned shape must match the real line...
    const real = `
  useEffect(() => {
    if (!isMyTurn) {
      setIsRaiseMode(false);
    }
  }, [isMyTurn]);
`;
    const [sane] = effectsOf(real);
    expect(/if\s*\(\s*!isMyTurn\s*\)\s*\{?\s*setIsRaiseMode\(\s*false\s*\)/.test(sane.body)).toBe(
      true
    );
    // ...and must NOT match the banned inversion, where the turn ARRIVING is
    // what dismisses. Drop the `!` and the exemption has to stop applying.
    const banned = `
  useEffect(() => {
    if (isMyTurn) {
      setIsRaiseMode(false);
    }
  }, [isMyTurn]);
`;
    const [bad] = effectsOf(banned);
    expect(/if\s*\(\s*!isMyTurn\s*\)\s*\{?\s*setIsRaiseMode\(\s*false\s*\)/.test(bad.body)).toBe(
      false
    );
    expect(CLOSES.test(bad.body)).toBe(true);
  });

  it('does not flag an effect that merely reads the turn without closing', () => {
    const benign = `
  useEffect(() => {
    if (isHeroTurn) pulse();
  }, [isHeroTurn]);
`;
    const [e] = effectsOf(benign);
    expect(TURN_TOKENS.test(e.deps)).toBe(true);
    expect(CLOSES.test(e.body)).toBe(false);
  });

  it('finds real effects in the real files it guards', () => {
    // If these ever parse to zero effects, the pins below are asleep.
    expect(effectsOf(HERO_HUB).length).toBeGreaterThan(0);
    expect(effectsOf(TABLE_MENU).length).toBeGreaterThan(0);
  });
});

describe('no panel closes itself because the turn arrived', () => {
  it('HeroHubPanel has no turn-keyed close', () => {
    for (const { body, deps } of effectsOf(HERO_HUB)) {
      if (!TURN_TOKENS.test(deps)) continue;
      expect(
        CLOSES.test(body),
        'HeroHubPanel is closing itself from an effect keyed on the turn clock. ' +
          'That is the 2026-08-29 bug Dan banned on 2026-08-31. Yield instead - ' +
          'see .hero-hub__overlay--yield.'
      ).toBe(false);
    }
  });

  /**
   * THE ONE SANCTIONED CARVE-OUT, named rather than regex'd away.
   *
   * ActionPanel resets its own raise slider when the turn ENDS:
   *
   *     useEffect(() => { if (!isMyTurn) setIsRaiseMode(false); }, [isMyTurn]);
   *
   * This is not a panel the player opened being taken from them. It is the
   * action bar's own transient mode returning to default at the moment there is
   * nothing left to act on — leaving a half-dragged raise amount armed across
   * the turn boundary is the bug, not the fix. Note the guard is `!isMyTurn`:
   * it fires when the turn LEAVES, never while the player is deciding.
   *
   * An exemption is a promise about a specific line, so this list carries the
   * reason with it. If you add an entry here, add the paragraph too. If you
   * cannot write the paragraph, you are looking at a bug.
   */
  const SANCTIONED: Array<{ file: string; shape: RegExp }> = [
    {
      file: 'src/components/table/ActionPanel.tsx',
      // The `!` is the whole exemption. An effect that closed something when
      // the turn ARRIVES is the banned shape and would not match this.
      shape: /if\s*\(\s*!isMyTurn\s*\)\s*\{?\s*setIsRaiseMode\(\s*false\s*\)/,
    },
  ];
  const isSanctioned = (rel: string, body: string) =>
    SANCTIONED.some((s) => s.file === rel && s.shape.test(body));

  it('no component anywhere closes on the turn clock', () => {
    const offenders: string[] = [];
    for (const file of allTsx(resolve(ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (!TURN_TOKENS.test(source)) continue;
      const rel = file.replace(ROOT + '/', '');
      for (const { body, deps } of effectsOf(source)) {
        if (TURN_TOKENS.test(deps) && CLOSES.test(body) && !isSanctioned(rel, body)) {
          offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      'these files dismiss something because the action moved: ' + offenders.join(', ')
    ).toEqual([]);
  });

  it('the hub yields the felt rather than closing', () => {
    expect(HERO_HUB).toContain('hero-hub__overlay--yield');
    expect(HERO_HUB_CSS).toContain('.hero-hub__overlay--yield');
    // Yielding is precisely: stop taking clicks, and clear the action bar.
    const yieldRule = HERO_HUB_CSS.slice(HERO_HUB_CSS.indexOf('.hero-hub__overlay--yield'));
    expect(yieldRule).toMatch(/pointer-events:\s*none/);
    expect(yieldRule).toContain('--sp-action-reserve');
    // ...while the panel itself stays usable. A yield that also went inert
    // would be an auto-close wearing a different hat.
    expect(yieldRule).toMatch(/\.hero-hub\s*\{[^}]*pointer-events:\s*auto/);
  });

  it('the law is written where the next agent will read it', () => {
    expect(HERO_HUB).toContain('NEVER auto close');
  });
});

describe('a click inside a picker is not a click outside its parent', () => {
  it('TableMenu stands down both dismissals while the avatar picker is open', () => {
    const dismissals = effectsOf(TABLE_MENU).filter(
      ({ body }) => /handleClickOutside|handleEscape/.test(body) && /onClose\(\)/.test(body)
    );
    expect(
      dismissals.length,
      'TableMenu no longer has the two dismissal effects this law guards'
    ).toBe(2);
    for (const { body } of dismissals) {
      expect(
        body,
        'a TableMenu dismissal still fires while AvatarGallery is open. That ' +
          'gallery portals to document.body, so every click inside it reads ' +
          'as a click outside this menu.'
      ).toMatch(/if\s*\(showAvatarGallery\)\s*return;/);
    }
  });

  it('SettingsPanel only dismisses for a click that landed on the backdrop', () => {
    expect(
      SETTINGS_PANEL,
      'SettingsPanel went back to a bare onClick={onClose} backdrop. Its ' +
        'portaled children (AvatarGallery, ThemeSettingsModal) bubble up the ' +
        'REACT tree and would close the whole panel.'
    ).toMatch(/e\.target === e\.currentTarget/);
    expect(SETTINGS_PANEL).not.toMatch(/className="settings-overlay"\s+onClick=\{onClose\}/);
  });

  /**
   * The generalisable form of the two bugs above, and the reason this pin is
   * worth more than the two specific ones: an overlay whose backdrop closes on
   * click must not let its CONTENT close it by bubbling. Every backdrop in the
   * repo satisfies this today (38 of 38, measured 2026-08-31) — either the
   * panel stops the bubble or the backdrop compares target to currentTarget.
   * The next one written must too.
   */
  it('every overlay backdrop that closes on click is guarded against its own content', () => {
    const unguarded: string[] = [];
    for (const file of allTsx(resolve(ROOT, 'src'))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/<div className="[a-z-]*overlay"[^>]*onClick=\{onClose\}>/.test(line)) return;
        // The child's opening tag follows within a couple of dozen lines, house
        // comments included. Either it stops the bubble, or the backdrop above
        // already narrowed itself to a direct hit.
        const window = lines.slice(i + 1, i + 26).join('\n');
        if (!/stopPropagation/.test(window)) {
          unguarded.push(`${file.replace(ROOT + '/', '')}:${i + 1}`);
        }
      });
    }
    expect(
      unguarded,
      'these backdrops close when their own content is clicked: ' + unguarded.join(', ')
    ).toEqual([]);
  });
});
