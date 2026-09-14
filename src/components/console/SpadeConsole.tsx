import { Fragment } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
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

/**
 * THE RIVETED FAMILY. Dan's spade NLH master (game-cards/nlh/spade-nlh-premium-v1,
 * 729 wide): bolted corners, a wider base that steps out around two plates,
 * and the spade chip medallion in the bottom rail. Cut at the glass gap
 * between the header well and the first bay (rows 246-256 are the plain
 * rail), and again at the gap above the base (row 582). Two plates, like the
 * spade console, on a heavier frame - for money.
 */
export const RIVETED_CONSOLE_W = 729;
export const RIVETED_CONSOLE_TOP_H = 209;
export const RIVETED_CONSOLE_FOOT_H = 333;
export const RIVETED_CONSOLE_ZONES = {
  eyebrow: { x: 88, y: 72, width: 350, height: 26 },
  title: { x: 88, y: 100, width: 555, height: 72 },
  titleBesidePill: { x: 88, y: 100, width: 350, height: 72 },
  subtitle: { x: 88, y: 168, width: 350, height: 24 },
  /** The chrome capsule at the right of the well, x 455-645 y 85-145. */
  pill: { x: 472, y: 97, width: 156, height: 38 },
  /** The two bolted plates' faces, inside their rims. */
  plateSecondary: { x: 80, y: 82, width: 235, height: 98 },
  platePrimary: { x: 380, y: 82, width: 260, height: 98 },
} as const;

/**
 * THE FOUR-BAY DECK - the buy-in family's, and nobody else's (Dan 2026-09-09).
 * His shark four-bay master (game-cards/plo/shark-four-bay-v1, 900 wide), cut
 * so the header well is the body: the head is the crest, the top of the well
 * and its pill slot; the rails are a median of well rows 238-276 (flat to
 * within 2/255); the foot is the well's bottom edge, the four bays and the
 * two plates. A buy-in prints its figures into the bays and its slider into
 * the well. Zone maths in this master's own 900px.
 */
export const FOURBAY_CONSOLE_W = 900;
export const FOURBAY_CONSOLE_TOP_H = 205;
export const FOURBAY_CONSOLE_FOOT_H = 568;
export const FOURBAY_CONSOLE_ZONES = {
  /* Zone heights follow the kit's type, not the glyphs alone: an eyebrow is
     a 2.6cqw face in a 1.6 line box, so its zone needs 3.4% of the canvas
     (the spade's 34/1000) or the baseline lands under the zone's edge and the
     letters lose their feet. Measured 2026-09-14: a 24px zone cut them. */
  eyebrow: { x: 80, y: 96, width: 500, height: 32 },
  title: { x: 80, y: 126, width: 520, height: 74 },
  titleBesidePill: { x: 80, y: 126, width: 520, height: 74 },
  subtitle: { x: 80, y: 176, width: 500, height: 38 },
  /** The slot at the right of the well, x 610-815 y 120-190. */
  pill: { x: 628, y: 132, width: 170, height: 46 },
  /** Painted faces y 400-478. The button over each bleeds PLATE_BLEED above
      and below the face (the label stays centred on the paint): at 375px the
      face is 32px tall, under the 44px a thumb needs. Nothing else is printed
      within the bleed. */
  /** Four bays: the label sits over the inner well, the value inside it. */
  bays: [
    {
      label: { x: 105, y: 64, width: 130, height: 44 },
      value: { x: 109, y: 128, width: 122, height: 112 },
    },
    {
      label: { x: 290, y: 64, width: 130, height: 44 },
      value: { x: 294, y: 128, width: 122, height: 112 },
    },
    {
      label: { x: 475, y: 64, width: 130, height: 44 },
      value: { x: 479, y: 128, width: 122, height: 112 },
    },
    {
      label: { x: 660, y: 64, width: 130, height: 44 },
      value: { x: 664, y: 128, width: 122, height: 112 },
    },
  ],
  plateSecondary: { x: 115, y: 400, width: 285, height: 78 },
  platePrimary: { x: 490, y: 400, width: 295, height: 78 },
} as const;

export type ConsoleFamily = 'spade' | 'shark' | 'riveted' | 'fourbay';

/** One printed bay on the four-bay deck. */
export type ConsoleBay = { label: string; value: string; ink?: ConsoleInk };

/** Everything that differs between families. Structure varies BETWEEN
 *  families, never within one - each row here is one approved master. */
const FAMILY = {
  spade: {
    W: SPADE_CONSOLE_W,
    TOP_H: SPADE_CONSOLE_TOP_H,
    FOOT_H: SPADE_CONSOLE_PLATES_H,
    zones: SPADE_CONSOLE_ZONES,
    plates: 2,
  },
  shark: {
    W: SHARK_CONSOLE_W,
    TOP_H: SHARK_CONSOLE_TOP_H,
    FOOT_H: SHARK_CONSOLE_FOOT_H,
    zones: SHARK_CONSOLE_ZONES,
    plates: 1,
  },
  riveted: {
    W: RIVETED_CONSOLE_W,
    TOP_H: RIVETED_CONSOLE_TOP_H,
    FOOT_H: RIVETED_CONSOLE_FOOT_H,
    zones: RIVETED_CONSOLE_ZONES,
    plates: 2,
  },
  fourbay: {
    W: FOURBAY_CONSOLE_W,
    TOP_H: FOURBAY_CONSOLE_TOP_H,
    FOOT_H: FOURBAY_CONSOLE_FOOT_H,
    zones: FOURBAY_CONSOLE_ZONES,
    plates: 2,
    /* The narrowest plates in the kit: a long honest label wraps to two
       lines rather than shrinking under 72% (see useFitText's wrapBelow). */
    plateWrapBelow: 0.72,
    plateBleed: 14,
  },
} as const;

/** Grow a plate zone above and below its painted face for the thumb. */
function bleedZone(zone: Zone, bleed: number): Zone {
  return { ...zone, y: zone.y - bleed, height: zone.height + bleed * 2 };
}

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
  wrapBelow,
  style,
  attrs,
}: {
  text: string;
  className?: string;
  as?: 'span' | 'h2' | 'h3' | 'strong';
  id?: string;
  minRatio?: number;
  /**
   * Horizontal stretch this zone's stylesheet applies via `transform: scaleX()`,
   * which is invisible to scrollWidth and so has to be declared here. Leave it
   * at 1 unless the zone really is stretched.
   *
   * It is NOT a safety margin. It was used as one until 2026-09-13, because
   * useFitText trusted a single measurement and landed a few per cent wide;
   * the hook now measures what it actually rendered and corrects, so inflating
   * this only makes the line smaller than its zone allows.
   */
  headroom?: number;
  /**
   * Let the line take a second line instead of shrinking under this ratio
   * (useFitText's wrapBelow). Off by default: a zone is one line. The bay
   * labels on the four-bay deck opt in, because a receipt's honest labels
   * ("Total Charged", "Wallet Balance") do not fit a bay's width on one.
   */
  wrapBelow?: number;
  style?: CSSProperties;
  /** Attributes for the zone element itself: a role, an aria-label. */
  attrs?: HTMLAttributes<HTMLElement>;
}) {
  const ref = useFitText<HTMLSpanElement>(text, headroom, minRatio, { wrapBelow });
  return (
    <Tag
      {...attrs}
      className={`sc-zone ${className} ${attrs?.className ?? ''}`.trim()}
      id={id}
      style={style}
    >
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
  pillAttrs,
  crest = 'spade',
  family = 'spade',
  foot,
  plates,
  bays,
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
  /** Attributes for the pill's zone: a timer's role and aria-label, a class
      a test reads. The pill stays one fitted line whatever it carries. */
  pillAttrs?: HTMLAttributes<HTMLElement>;
  /** Which emblem the head wears. Same structure, different dress. */
  crest?: ConsoleCrest;
  /** Which approved master the frame is cut from. 'shark' carries ONE plate. */
  family?: ConsoleFamily;
  /** The four printed wells of the four-bay deck. Ignored by every other family. */
  bays?: readonly ConsoleBay[];
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
  const F = FAMILY[family];
  const W = F.W;
  const TOP_H = F.TOP_H;
  const Z = F.zones;
  const onePlate = F.plates === 1;
  const plateBleed = 'plateBleed' in F ? F.plateBleed : 0;
  const plateWrapBelow = 'plateWrapBelow' in F ? F.plateWrapBelow : undefined;
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
            attrs={pillAttrs}
            style={zonePct(Z.pill, W, TOP_H)}
          />
        )}
      </div>
      {children !== undefined && children !== null && <div className="sc__body">{children}</div>}
      <div className="sc__foot">
        {family === 'fourbay' &&
          bays?.slice(0, 4).map((bay, i) => (
            <Fragment key={i}>
              <ZoneText
                text={bay.label}
                className="sc__bay-label sc-ink--blue"
                wrapBelow={0.8}
                style={zonePct(FOURBAY_CONSOLE_ZONES.bays[i].label, W, F.FOOT_H)}
              />
              <ZoneText
                text={bay.value}
                className={`sc__bay-value sc-ink--${bay.ink ?? 'silver'}`}
                minRatio={0.4}
                style={zonePct(FOURBAY_CONSOLE_ZONES.bays[i].value, W, F.FOOT_H)}
              />
            </Fragment>
          ))}
        {onePlate && plates?.primary && (
          <PlateButton
            zone={SHARK_CONSOLE_ZONES.plate}
            canvasW={W}
            canvasH={F.FOOT_H}
            {...plates.primary}
          />
        )}
        {!onePlate && footKind === 'plates' && plates?.secondary && (
          <PlateButton
            zone={bleedZone((Z as typeof SPADE_CONSOLE_ZONES).plateSecondary, plateBleed)}
            canvasW={W}
            canvasH={F.FOOT_H}
            wrapBelow={plateWrapBelow}
            {...plates.secondary}
          />
        )}
        {!onePlate && footKind === 'plates' && plates?.primary && (
          <PlateButton
            zone={bleedZone((Z as typeof SPADE_CONSOLE_ZONES).platePrimary, plateBleed)}
            canvasW={W}
            canvasH={F.FOOT_H}
            wrapBelow={plateWrapBelow}
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
  /**
   * Let a long label take two lines instead of shrinking under this ratio
   * (useFitText's wrapBelow). Off by default: a plate label is one line, and
   * only a family whose plates are too narrow for its honest labels opts in.
   */
  wrapBelow?: number;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function PlateButton({
  zone,
  canvasW = SPADE_CONSOLE_W,
  canvasH,
  label,
  ink = 'silver',
  buttonRef,
  wrapBelow,
  className = '',
  style,
  ...rest
}: {
  zone: Zone;
  canvasW?: number;
  canvasH: number;
} & PlateButtonProps) {
  const ref = useFitText<HTMLSpanElement>(label, 1, 0.5, { wrapBelow });
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
