import { useEffect, useRef, type ReactNode } from 'react';
import { SHORT_LANDSCAPE_QUERY } from '../../hooks/useSceneBudget';
import { TapHaptic } from '../haptics/TapHaptic';
import type { DeckBay } from '../console/DeckConsole';
import type { PlateButtonProps, ConsoleInk } from '../console/SpadeConsole';
import styles from './GameConsole.module.css';

/**
 * One of the console's two plates. `flash` lights the plate in a slow gold
 * pulse while it is THE thing to press: Crash's Book The Win through a live,
 * cashable climb (Dan 2026-10-12: "THE STOP BUTTON SHOULD BE FLASHING TO LET
 * THE PLAYER KNOW THIS IS THE BUTTON TO CLICK TO STOP AND BOOK THE WIN").
 */
export type GamePlate = PlateButtonProps & { flash?: boolean };

/**
 * The game owns the screen. The scene, the setup and the bays stay in normal
 * flow; the two plates ride in a bar pinned to the bottom of the game frame.
 *
 * THE PLATES ARE ON THE OPENING SCREEN (Dan 2026-10-12): "THE Start game
 * BUTTON for any of the bonus games INSIDE OF DIAMOND SPINS needs to be
 * clickable on the opening screen. Not scroll down to just click start." On a
 * phone the console is one column - the scene, then the setup, then the bays -
 * and Start sat under all of it, 800 to 1,500px down a 667 to 852px screen in
 * all four games. And for Crash: "THE 'STOP BUTTON' NEEDS TO BE VISUALLY ON
 * THE SAME PAGE AS THE START BUTTON". Start and Book The Win are the same
 * primary plate, so pinning the bar puts both on one spot of the glass.
 *
 * The bar is `position: sticky; bottom: 0` and a DIRECT child of the console
 * section, never of the controls column: a sticky box can only travel inside
 * its parent, and the controls column starts below the fold on a phone, so a
 * bar inside it could never reach the bottom of the first screen. Laid out,
 * not scrolled: nothing here moves the window.
 */
export function GameConsole({
  title,
  titleId,
  pill,
  bays,
  secondary,
  primary,
  setup,
  dock,
  footer,
  children,
}: {
  title: string;
  titleId?: string;
  pill?: string;
  eyebrow?: string;
  pillInk?: ConsoleInk;
  bays: DeckBay[];
  secondary?: GamePlate;
  primary?: GamePlate;
  setup?: ReactNode;
  /**
   * A choice the primary plate cannot be pressed without, printed in the
   * pinned bar above the plates so the choice and the press share the first
   * screen: Plinko's Diamonds Per Drop (R6, nothing is pre-selected, so Drop
   * Diamonds is dead until it is answered).
   */
  dock?: ReactNode;
  /**
   * A quiet line that belongs WITH the controls rather than over the game: the
   * day's count and spend. Named footer, never `foot`, which already means a
   * SpadeConsole frame kind. On a phone the console is one column, so anything
   * left in the playfield sits between the header and the board and pushes the
   * scene down by its own height; here it closes the controls column, where a
   * player reads it after the bays instead of before the board.
   */
  footer?: ReactNode;
  children?: ReactNode;
} & Record<string, unknown>) {
  /**
   * A PLATE WHOSE MOVE IS IN FLIGHT KEEPS ITS FOCUS. The native disabled
   * attribute takes focus off the element - the HTML focus-fixup rule sends it
   * to <body> - so a keyboard or switch-control player who pressed Cross had
   * to find the plate again on every street. A caller that means "this press
   * is already out" passes aria-disabled instead: assistive technology hears
   * the same thing, GameConsole.module.css dims it the same way, the focus
   * stays where the player put it, and the press is refused here as well as by
   * the page's own guard. Native disabled still says "there is nothing here to
   * press", which is a plate worth leaving.
   */
  /**
   * A PHONE ON ITS SIDE IS A GAME SCREEN (2026-09-26). Held sideways, the
   * console is exactly one screen tall (GameConsole.module.css), and the page
   * chrome above it - the back link - would push its plates under the fold by
   * its own height. So the console brings itself to the top of the screen
   * when the page opens sideways and whenever the phone turns onto its side.
   * The back link is one small scroll up. Nothing else moves, and upright
   * nothing happens at all.
   */
  const consoleRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(SHORT_LANDSCAPE_QUERY);
    const frame = () => {
      if (query.matches) consoleRef.current?.scrollIntoView?.({ block: 'start' });
    };
    frame();
    query.addEventListener?.('change', frame);
    return () => query.removeEventListener?.('change', frame);
  }, []);
  const action = (button: GamePlate | undefined, main = false) => {
    if (!button) return null;
    // `haptic` is a PlateButton option; these plates always carry TapHaptic.
    const { label, ink, buttonRef, onClick, haptic: _plateHaptic, flash, ...rest } = button;
    const pending = rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
    const lit = Boolean(flash) && !rest.disabled && !pending;
    return (
      <button
        type="button"
        {...rest}
        ref={buttonRef}
        className={main ? styles.primary : styles.secondary}
        onClick={pending ? undefined : onClick}
        data-ink={ink}
        // Which of the console's own two plates this is, beside whatever the
        // setup panel puts in the controls. The stylesheet and the contrast
        // spec both need to name them without reaching for a hashed class.
        data-plate={main ? 'primary' : 'secondary'}
        // The pulse IS the message ("this is the button that books the win"),
        // so reduced motion keeps it (src/styles/reducedMotion.css): it is
        // light on the plate's edge, never movement, and its period is the
        // player's own Animation Speed (GameConsole.module.css).
        data-flash={lit ? 'live' : undefined}
        data-motion={lit ? 'keep' : undefined}
      >
        {label}
        <TapHaptic disabled={Boolean(rest.disabled) || pending} radius="4px" />
      </button>
    );
  };
  return (
    <section
      ref={consoleRef}
      className={styles.console}
      aria-labelledby={titleId}
      data-game-console
    >
      <header className={styles.header}>
        <h1 id={titleId}>{title}</h1>
        <span className={styles.status}>{pill}</span>
      </header>
      <div className={styles.playfield}>{children}</div>
      <aside className={styles.controls} aria-label={`${title} Controls`}>
        {setup}
        <dl className={styles.metrics}>
          {bays.map((bay) => (
            <div key={bay.label}>
              <dt>{bay.label}</dt>
              <dd data-ink={bay.ink}>
                {bay.onPress ? (
                  <button
                    type="button"
                    onClick={bay.onPress}
                    disabled={bay.disabled}
                    aria-label={bay.pressLabel ?? `Change ${bay.label}`}
                  >
                    {bay.value}
                    <span aria-hidden="true"> ↻</span>
                    <TapHaptic disabled={bay.disabled} radius="4px" />
                  </button>
                ) : (
                  bay.value
                )}
              </dd>
            </div>
          ))}
        </dl>
        {footer}
      </aside>
      <div className={styles.bar} role="group" aria-label={`${title} Actions`} data-game-actions>
        {dock}
        <div className={styles.actions}>
          {action(secondary)}
          {action(primary, true)}
        </div>
      </div>
    </section>
  );
}

/** Secondary information stays available without putting another frame around the game. */
export function GamePanel({
  title,
  children,
  plates,
}: {
  title: string;
  children?: ReactNode;
  plates?: { primary?: PlateButtonProps; secondary?: PlateButtonProps };
} & Record<string, unknown>) {
  return (
    <details className={styles.panel}>
      <summary>{title}</summary>
      <div>{children}</div>
      {plates && (
        <div className={styles.actions}>
          {[plates.secondary, plates.primary].map(
            (button, index) =>
              button && (
                <button
                  key={index}
                  type="button"
                  className={index === 1 ? styles.primary : styles.secondary}
                  disabled={button.disabled}
                  onClick={button.onClick}
                >
                  {button.label}
                  <TapHaptic disabled={button.disabled} radius="4px" />
                </button>
              )
          )}
        </div>
      )}
    </details>
  );
}
