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
 *   bottom-plates.png             the steel and blue-glass plates painted
 *                                 into the foot, closed by the flat cap
 *   bottom-foot.png               the flat closing cap on its own
 *
 * THE BOTTOM IS FLAT AND CARRIES NOTHING (Dan 2026-09-08): "I ACTUALLY
 * PREFER IT WITH ONLY AN ICON AT THE TOP, IM NOT A HUGE FAN OF THE CHIP ON
 * THE BOTTOM. AND WITH NO ICON ON THE BOTTOM, IT SHOULDN'T POINT OUT STILL
 * ON THE BOTTOM. IT SHOULD BE A FLAT BOTTOM." So the closing cap is the
 * master's OWN top rails turned over - the same rails, the same four corner
 * chamfers, no chip and no dive to the centre. The spade stays at the top.
 *
 * Everything printed on it - title, eyebrow, the word in the pill slot, the
 * labels on the plates - lands in a zone measured in pixels on that master,
 * in the same ink the master paints its own words in. The content between
 * head and foot prints on the black glass; nothing else is drawn.
 */

export const SPADE_CONSOLE_W = 1000;
export const SPADE_CONSOLE_TOP_H = 348;
export const SPADE_CONSOLE_PLATES_H = 277;
export const SPADE_CONSOLE_FOOT_H = 72;

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
  /* A long title beside a pill: it stops with air before the pill's slot
     rather than running up against its rim (ANNOUNCEMENTS did). */
  titleBesidePill: { x: 100, y: 166, width: 470, height: 86 },
  subtitle: { x: 102, y: 262, width: 540, height: 42 },
  pill: { x: 673, y: 190, width: 197, height: 54 },
  /* Relative to bottom-plates.png (master y minus 700). */
  plateSecondary: { x: 100, y: 46, width: 381, height: 129 },
  platePrimary: { x: 520, y: 46, width: 381, height: 129 },
} satisfies Record<string, Zone>;

/**
 * THE SHARK FAMILY. Dan's shark heads-up master, cut into head / rails / foot
 * like the spade (Dan 2026-09-13: not every card the same frame). One plate in
 * the foot, the shark crest below it, the diamond crest in the head. All zone
 * maths is in this master's own pixels: 733 wide.
 */
export const SHARK_CONSOLE_W = 733;
export const SHARK_CONSOLE_TOP_H = 154;
export const SHARK_CONSOLE_FOOT_H = 172;
export const SHARK_CONSOLE_ZONES = {
  eyebrow: { x: 70, y: 50, width: 440, height: 26 },
  title: { x: 70, y: 76, width: 590, height: 66 },
  titleBesidePill: { x: 70, y: 76, width: 440, height: 66 },
  subtitle: { x: 70, y: 126, width: 440, height: 22 },
  /** The rounded slot at the right of the well, x 527-642 y 70-122. */
  pill: { x: 537, y: 79, width: 96, height: 36 },
  /** The one blue plate's face, inside its chamfered rim. */
  plate: { x: 110, y: 18, width: 512, height: 76 },
} as const;

export type ConsoleFamily = 'spade' | 'shark';

export function zonePct(zone: Zone, canvasW: number, canvasH: number): CSSProperties {
  return {
    left: `${(zone.x / canvasW) * 100}%`,
    top: `${(zone.y / canvasH) * 100}%`,
    width: `${(zone.width / canvasW) * 100}%`,
    height: `${(zone.height / canvasH) * 100}%`,
  };
}

export type ConsoleInk = 'silver' | 'white' | 'blue' | 'green' | 'red' | 'gold' | 'muted';

/**
 * THE DRESS MAY VARY; THE STRUCTURE MAY NOT (Dan 2026-09-09): "ALL FRAMES
 * SHOULD NOT BE EXACTLY 100% THE SAME WITH THE SPADE AT THE TOP ... SOME
 * SHOULD BE FLAT AT THE TOP AND JUST A DYNAMIC FRAME, SOME SHOULD HAVE OTHER
 * ICONS THAT ARE RELEVANT TO THE CARD OR POP UP."
 *
 * AND NO ICON BORROWS ANOTHER'S HOUSING (Dan 2026-09-09): "LOOK HOW THE SPADE
 * HAS A CUSTOM FRAME AROUND IT ... EVERY ICON NEEDS ITS OWN CUSTOM HOLDER LIKE
 * THE SPADE HAS. ANYTIME YOU USE A CUSTOM ICON, OR ADD A CUSTOM ICON, YOU MUST
 * BUILD A NEW FRAME HOLDER AND COMPLETELY REDESIGN THE TOP FRAME (NEVER JUST
 * COPY AND PASTE)."
 *
 * So the spade's shield is the spade's alone. Every other crest is PAINTED -
 * by the image model, from the master crest as its style reference, with a
 * thin clean chrome border (Dan: thick borders are not allowed) - then seated
 * by scripts/art/seat-console-crest.py, which re-mitres the rails into that
 * crest row by row so the master's own chrome mitre meets whatever edge the
 * new crest has. The recipe and the painted sources live in the kit's
 * source/ folder; outside the crest window every head is the master, pixel
 * for pixel:
 *
 *   spade    the master as approved: the pointed shield
 *   flat     no crest at all - lifted out and the rails bridged with their
 *            own median cross-section, so the frame closes flat
 *   diamond  a hexagonal bezel holding a chrome diamond
 *   vip      a wide keystone holding a chrome crown
 *   club     a round medallion holding a chrome club
 */
export type ConsoleCrest = 'spade' | 'flat' | 'diamond' | 'vip' | 'club';

/** Fitted, single-line text in a zone. */
export function ZoneText({
  text,
  className = '',
  as: Tag = 'span',
  id,
  minRatio = 0.5,
  headroom = 1,
  style,
}: {
  text: string;
  className?: string;
  as?: 'span' | 'h2' | 'h3' | 'strong';
  id?: string;
  minRatio?: number;
  /**
   * Width safety factor. useFitText derives its ratio from ONE measurement of
   * the unscaled text, so the scaled result lands a couple of percent wide -
   * hinting at the smaller size, and the trailing letter-space. Measured on the
   * header 2026-09-09: a 185px zone got a 190px title, and the zone (which hides
   * its overflow) ate the last letter. Inflating `needed` shrinks the ratio by
   * the same margin, so the line lands inside its zone with air.
   */
  headroom?: number;
  style?: CSSProperties;
}) {
  const ref = useFitText<HTMLSpanElement>(text, headroom, minRatio);
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
  crest = 'spade',
  family = 'spade',
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
  /** Which emblem the head wears. Same structure, different dress. */
  crest?: ConsoleCrest;
  /** Which approved master the frame is cut from. 'shark' carries ONE plate. */
  family?: ConsoleFamily;
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
  const shark = family === 'shark';
  const W = shark ? SHARK_CONSOLE_W : SPADE_CONSOLE_W;
  const TOP_H = shark ? SHARK_CONSOLE_TOP_H : SPADE_CONSOLE_TOP_H;
  const Z = shark ? SHARK_CONSOLE_ZONES : SPADE_CONSOLE_ZONES;
  return (
    <Tag
      className={`sc sc--${footKind} sc--crest-${crest} sc--family-${family} ${className}`.trim()}
      {...rest}
    >
      <div className="sc__head">
        {eyebrow && (
          <ZoneText
            text={eyebrow}
            className="sc__eyebrow sc-ink--blue"
            style={zonePct(Z.eyebrow, W, TOP_H)}
          />
        )}
        <ZoneText
          as="h2"
          id={titleId}
          text={title}
          className="sc__title sc-ink--silver"
          /* A title shrinks rather than gets chopped. ZoneText's default floor
             is half size, and the zone hides its overflow, so a long name
             ("Achievement Archive", "Transaction Ledger", "Announcements") hit
             the floor and then lost its last letters to the zone edge - the one
             thing the fit exists to prevent. The floor drops for titles only;
             every other zone keeps the default. */
          minRatio={0.44}
          headroom={1.06}
          style={zonePct(pill ? Z.titleBesidePill : Z.title, W, TOP_H)}
        />
        {subtitle && (
          <ZoneText
            text={subtitle}
            className="sc__subtitle sc-ink--muted"
            style={zonePct(Z.subtitle, W, TOP_H)}
          />
        )}
        {pill && (
          <ZoneText
            text={pill}
            className={`sc__pill sc-ink--${pillInk}`}
            headroom={1.06}
            style={zonePct(Z.pill, W, TOP_H)}
          />
        )}
      </div>
      {children !== undefined && children !== null && <div className="sc__body">{children}</div>}
      <div className="sc__foot">
        {shark && plates?.primary && (
          <PlateButton
            zone={SHARK_CONSOLE_ZONES.plate}
            canvasW={SHARK_CONSOLE_W}
            canvasH={SHARK_CONSOLE_FOOT_H}
            {...plates.primary}
          />
        )}
        {!shark && footKind === 'plates' && plates?.secondary && (
          <PlateButton
            zone={SPADE_CONSOLE_ZONES.plateSecondary}
            canvasH={SPADE_CONSOLE_PLATES_H}
            {...plates.secondary}
          />
        )}
        {!shark && footKind === 'plates' && plates?.primary && (
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
