/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DECK CONSOLE - the spade master with its four bays and two plates
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The chassis for "four figures and two actions" (#ClubArenaConsole §4): the
 * console's own head (top.png), a body on the rails, and the master's deck
 * (popups/buy-in-v1/deck-d5664b815000.png: rows 350-1135 of the approved PLO master, the
 * four bays with their labels lifted, the steel and blue-glass plates, the
 * flat cap). Nothing is drawn. Every word lands in a zone measured in pixels
 * on that master; a bay that is also a control paints nothing and changes
 * only its ink.
 *
 * Zones are the master's (the same numbers BuyInModal prints into), kept here
 * so a game page never imports a table modal.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useFitText } from '../lobby/game-cards/useFitText';
import {
  SPADE_CONSOLE_TOP_H,
  SPADE_CONSOLE_W,
  SPADE_CONSOLE_ZONES,
  PlateButton,
  ZoneText,
  zonePct,
  type ConsoleInk,
  type PlateButtonProps,
} from './SpadeConsole';
import './SpadeConsole.css';
import './DeckConsole.css';

export const DECK_H = 627;

interface Zone {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The zones are the ART's, measured off deck.png itself rather than copied
 * from a note: the four bay modules are centred on x 183 / 391 / 599 / 807
 * (208 apart), each a label strip at y 62-123 over a window at y 134-297, and
 * the two plates are x 111-474 and x 530-885 at y 401-529. Printing into a
 * zone the paint does not have is how text ends up over a bevel.
 */
const bay = (cx: number) => ({
  label: { x: cx - 66, y: 70, width: 132, height: 44 } as Zone,
  value: { x: cx - 67, y: 150, width: 134, height: 130 } as Zone,
});

export const DECK_ZONES = {
  bays: [bay(183), bay(391), bay(599), bay(807)],
  secondaryAction: { x: 111, y: 401, width: 363, height: 128 } as Zone,
  primaryAction: { x: 530, y: 401, width: 355, height: 128 } as Zone,
} as const;

export interface DeckBay {
  label: string;
  value: string;
  ink?: ConsoleInk;
  /** A bay that is a control: tapping it fires this. Its state is its ink. */
  onPress?: () => void;
  pressLabel?: string;
  disabled?: boolean;
}

export function DeckConsole({
  eyebrow,
  title,
  titleId,
  pill,
  pillInk = 'blue',
  bays,
  secondary,
  primary,
  children,
  className = '',
  stageClassName = '',
  ...rest
}: {
  eyebrow?: string;
  title: string;
  titleId?: string;
  pill?: string;
  pillInk?: ConsoleInk;
  bays: [DeckBay, DeckBay, DeckBay, DeckBay];
  secondary?: PlateButtonProps;
  primary?: PlateButtonProps;
  children?: ReactNode;
  className?: string;
  stageClassName?: string;
} & Record<string, unknown>) {
  const W = SPADE_CONSOLE_W;
  return (
    <section className={`sc dk ${className}`.trim()} {...rest}>
      <div className="sc__head">
        {eyebrow && (
          <ZoneText
            text={eyebrow}
            className="sc__eyebrow sc-ink--blue"
            style={zonePct(SPADE_CONSOLE_ZONES.eyebrow, W, SPADE_CONSOLE_TOP_H)}
          />
        )}
        <ZoneText
          as="h2"
          id={titleId}
          text={title}
          className="sc__title sc-ink--silver"
          style={zonePct(
            pill ? SPADE_CONSOLE_ZONES.titleBesidePill : SPADE_CONSOLE_ZONES.title,
            W,
            SPADE_CONSOLE_TOP_H
          )}
        />
        {pill && (
          <ZoneText
            text={pill}
            className={`sc__pill sc-ink--${pillInk}`}
            style={zonePct(SPADE_CONSOLE_ZONES.pill, W, SPADE_CONSOLE_TOP_H)}
          />
        )}
      </div>
      <div className={`dk__stage ${stageClassName}`.trim()}>{children}</div>
      <div className="dk__deck">
        {bays.map((b, i) => (
          <DeckBayPrint key={i} zone={DECK_ZONES.bays[i]} bay={b} />
        ))}
        {secondary && (
          <PlateButton zone={DECK_ZONES.secondaryAction} canvasH={DECK_H} {...secondary} />
        )}
        {primary && <PlateButton zone={DECK_ZONES.primaryAction} canvasH={DECK_H} {...primary} />}
      </div>
    </section>
  );
}

function DeckBayPrint({ zone, bay: b }: { zone: { label: Zone; value: Zone }; bay: DeckBay }) {
  const ink = b.ink ?? 'silver';
  return (
    <>
      <ZoneText
        text={b.label}
        className="dk__bay-label sc-ink--blue"
        style={zonePct(zone.label, SPADE_CONSOLE_W, DECK_H)}
      />
      {b.onPress ? (
        <DeckBayButton
          style={zonePct(zone.value, SPADE_CONSOLE_W, DECK_H)}
          text={b.value}
          ink={ink}
          label={b.pressLabel ?? `Change ${b.label}`}
          onClick={b.onPress}
          disabled={b.disabled}
        />
      ) : (
        <ZoneText
          as="strong"
          text={b.value}
          className={`dk__bay-value sc-ink--${ink}`}
          style={zonePct(zone.value, SPADE_CONSOLE_W, DECK_H)}
          minRatio={0.4}
        />
      )}
    </>
  );
}

function DeckBayButton({
  style,
  text,
  ink,
  label,
  onClick,
  disabled,
}: {
  style: CSSProperties;
  text: string;
  ink: ConsoleInk;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const ref = useFitText<HTMLSpanElement>(text, 1, 0.4);
  return (
    <button
      type="button"
      className="dk__bay-button"
      style={style}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {/* The well is what the label is fitted to, exactly as PlateButton does
          it: the face never measures itself against the window's bevel. */}
      <span className="dk__bay-well">
        <strong className={`dk__bay-face sc-ink--${ink}`} ref={ref}>
          {text}
        </strong>
      </span>
    </button>
  );
}
