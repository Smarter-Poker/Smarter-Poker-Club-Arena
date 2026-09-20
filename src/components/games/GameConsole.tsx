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
  children?: ReactNode;
} & Record<string, unknown>) {
  const action = (button: PlateButtonProps | undefined, main = false) =>
    button && (
      <button
        type="button"
        className={main ? styles.primary : styles.secondary}
        onClick={button.onClick}
        disabled={button.disabled}
        data-ink={button.ink}
      >
        {button.label}
      </button>
    );
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
