import type { ReactNode } from 'react';
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
      >
        {label}
      </button>
    );
  };
  return (
    <section className={styles.console} aria-labelledby={titleId} data-game-console>
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
                </button>
              )
          )}
        </div>
      )}
    </details>
  );
}
