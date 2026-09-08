import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from 'react';
import { useFitText } from '../lobby/game-cards/useFitText';
import './SpadeConsole.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SPADE CONSOLE - one approved master, cut into a chassis for pages and popups
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04, on the first two passes: buttons and frames assembled from
 * separate art "feel cheap", a crest "stuck on" a rail is trash, a frame may
 * never sit on a frame, nothing may be copy-pasted, and every font has to
 * look like it belongs to the render it sits in.
 *
 * So this chassis is not assembled. It is Dan's approved spade PLO master
 * (1000 x 1135, the same file every Omaha card on a phone is drawn from),
 * cut into three pieces at full resolution:
 *
 *   top.png            y 0-348    crest seated in the rail, the header well
 *                                 with its title zone, the pill slot and the
 *                                 chrome rule with the blue gem
 *   mid.png            y 336-348  the plain rails, averaged and repeated
 *   bottom-plates.png  y 700-end  the steel and blue-glass plates painted
 *                                 into the foot, and the spade chip
 *   bottom-foot.png    y 878-end  the closing rail and chip only
 *
 * Everything printed on it - title, eyebrow, the word in the pill slot, the
 * labels on the plates - lands in a zone measured in pixels on that master,
 * in the same ink the master paints its own words in. The content between
 * head and foot prints on the black glass; nothing else is drawn.
 */

export const SPADE_CONSOLE_W = 1000;
export const SPADE_CONSOLE_TOP_H = 348;
export const SPADE_CONSOLE_PLATES_H = 435;
export const SPADE_CONSOLE_FOOT_H = 257;

interface Zone {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Zones on the 1000-wide master. The head zones are relative to top.png. */
export const SPADE_CONSOLE_ZONES = {
  eyebrow: { x: 100, y: 128, width: 540, height: 34 },
  title: { x: 100, y: 166, width: 540, height: 86 },
  subtitle: { x: 102, y: 262, width: 540, height: 42 },
  pill: { x: 673, y: 190, width: 197, height: 54 },
  /* Relative to bottom-plates.png (master y minus 700). */
  plateSecondary: { x: 100, y: 46, width: 381, height: 129 },
  platePrimary: { x: 520, y: 46, width: 381, height: 129 },
} satisfies Record<string, Zone>;

export function zonePct(zone: Zone, canvasW: number, canvasH: number): CSSProperties {
  return {
    left: `${(zone.x / canvasW) * 100}%`,
    top: `${(zone.y / canvasH) * 100}%`,
    width: `${(zone.width / canvasW) * 100}%`,
    height: `${(zone.height / canvasH) * 100}%`,
  };
}

export type ConsoleInk = 'silver' | 'white' | 'blue' | 'green' | 'red' | 'gold' | 'muted';

/** Fitted, single-line text in a zone. */
export function ZoneText({
  text,
  className = '',
  as: Tag = 'span',
  id,
  minRatio = 0.5,
  style,
}: {
  text: string;
  className?: string;
  as?: 'span' | 'h2' | 'h3' | 'strong';
  id?: string;
  minRatio?: number;
  style?: CSSProperties;
}) {
  const ref = useFitText<HTMLSpanElement>(text, 1, minRatio);
  return (
    <Tag className={`sc-zone ${className}`.trim()} id={id} style={style}>
      <span ref={ref}>{text}</span>
    </Tag>
  );
}

export function SpadeConsole({
  eyebrow,
  title,
  titleId,
  subtitle,
  pill,
  pillInk = 'blue',
  foot,
  plates,
  children,
  className = '',
  as: Tag = 'section',
  ...rest
}: {
  eyebrow?: string;
  title: string;
  titleId?: string;
  subtitle?: string;
  /** The word printed in the header's painted pill slot. */
  pill?: string;
  pillInk?: ConsoleInk;
  /** 'plates' paints the two action plates into the foot; 'foot' just closes. */
  foot?: 'plates' | 'foot';
  plates?: {
    secondary?: PlateButtonProps;
    primary?: PlateButtonProps;
  };
  children?: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
} & Record<string, unknown>) {
  const footKind = foot ?? (plates ? 'plates' : 'foot');
  const W = SPADE_CONSOLE_W;
  return (
    <Tag className={`sc sc--${footKind} ${className}`.trim()} {...rest}>
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
          style={zonePct(SPADE_CONSOLE_ZONES.title, W, SPADE_CONSOLE_TOP_H)}
        />
        {subtitle && (
          <ZoneText
            text={subtitle}
            className="sc__subtitle sc-ink--muted"
            style={zonePct(SPADE_CONSOLE_ZONES.subtitle, W, SPADE_CONSOLE_TOP_H)}
          />
        )}
        {pill && (
          <ZoneText
            text={pill}
            className={`sc__pill sc-ink--${pillInk}`}
            style={zonePct(SPADE_CONSOLE_ZONES.pill, W, SPADE_CONSOLE_TOP_H)}
          />
        )}
      </div>
      {children !== undefined && children !== null && <div className="sc__body">{children}</div>}
      <div className="sc__foot">
        {footKind === 'plates' && plates?.secondary && (
          <PlateButton
            zone={SPADE_CONSOLE_ZONES.plateSecondary}
            canvasH={SPADE_CONSOLE_PLATES_H}
            {...plates.secondary}
          />
        )}
        {footKind === 'plates' && plates?.primary && (
          <PlateButton
            zone={SPADE_CONSOLE_ZONES.platePrimary}
            canvasH={SPADE_CONSOLE_PLATES_H}
            {...plates.primary}
          />
        )}
      </div>
    </Tag>
  );
}

/**
 * A transparent button laid over a plate painted in the master. It paints
 * nothing: the plate is the art, the label is the only thing it adds.
 */
export type PlateButtonProps = {
  label: string;
  ink?: ConsoleInk;
  /** The button element, for callers that manage focus (ConfirmModal). */
  buttonRef?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function PlateButton({
  zone,
  canvasW = SPADE_CONSOLE_W,
  canvasH,
  label,
  ink = 'silver',
  buttonRef,
  className = '',
  style,
  ...rest
}: {
  zone: Zone;
  canvasW?: number;
  canvasH: number;
} & PlateButtonProps) {
  const ref = useFitText<HTMLSpanElement>(label, 1, 0.5);
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`sc-plate ${className}`.trim()}
      style={{ ...zonePct(zone, canvasW, canvasH), ...style }}
      {...rest}
    >
      <span className="sc-plate__well">
        <span className={`sc-plate__text sc-ink--${ink}`} ref={ref}>
          {label}
        </span>
      </span>
    </button>
  );
}
