import { useEffect, useRef, type ReactNode } from 'react';
import { SHORT_LANDSCAPE_QUERY } from '../../hooks/useSceneBudget';
import { TapHaptic } from '../haptics/TapHaptic';
import type { DeckBay } from '../console/DeckConsole';
import type { PlateButtonProps, ConsoleInk } from '../console/SpadeConsole';
import styles from './GameConsole.module.css';

/** The game owns the screen. Controls stay in normal flow and never cover the board. */
export function GameConsole({
  title,
  titleId,
  pill,
  bays,
  secondary,
  primary,
  setup,
  footer,
  children,
}: {
  title: string;
  titleId?: string;
  pill?: string;
  eyebrow?: string;
  pillInk?: ConsoleInk;
  bays: DeckBay[];
  secondary?: PlateButtonProps;
  primary?: PlateButtonProps;
  setup?: ReactNode;
  /**
   * A quiet line that belongs WITH the controls rather than over the game: the
   * day's count and spend. Named footer, never `foot`, which already means a
   * SpadeConsole frame kind. On a phone the console is one column, so anything
   * left in the playfield sits between the header and the board and pushes the
   * plates down by its own height; here it sits under them, where a player
   * reads it after the decision instead of before it.
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
  const action = (button: PlateButtonProps | undefined, main = false) => {
    if (!button) return null;
    const { label, ink, buttonRef, onClick, ...rest } = button;
    const pending = rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
    return (
      <button
        type="button"
        {...rest}
        ref={buttonRef}
        className={main ? styles.primary : styles.secondary}
        onClick={pending ? undefined : onClick}
        data-ink={ink}
        // Which of the console's own two plates this is, beside whatever the
        // setup panel puts in the same aside. The stylesheet and the contrast
        // spec both need to name them without reaching for a hashed class.
        data-plate={main ? 'primary' : 'secondary'}
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
        <div className={styles.actions}>
          {action(secondary)}
          {action(primary, true)}
        </div>
        {footer}
      </aside>
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
