import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  ReactNode,
  Ref,
} from 'react';
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
/**
 * THE SHARK HEAD IS SHORT, AND A THIRD LINE RE-MEASURES ALL THREE
 * (2026-09-22).
 *
 * Measured off top.png: the header glass runs y 47 to y 149, closed by the
 * hairline at y 150, so this head has 102 rows to print in. The spade head
 * has 219 on a wider master, and both print at the same cqw type, so the
 * shark spends 1.66x as much of its head on every line. `title` at height 66
 * plus `subtitle` at y 126 therefore claimed y 76-142 and y 126-148 of those
 * 102 rows: the two rectangles INTERSECTED over 16 rows, and a shark console
 * given both printed the second through the bottom of the first. The
 * subtitle band was also shorter than the line box it holds, so what did
 * print was cut off below the letters. Neither was ever seen by a player,
 * because neither live caller on this family passes a subtitle.
 *
 * TWO HEADS, NOT ONE. Without a subtitle the head is unchanged, down to the
 * pixel: `eyebrow` and `title` keep the bands every live surface renders in
 * today. With a subtitle all three lines move to the `WithSubtitle` bands,
 * the same way the title already steps aside for a pill, and the stack is
 * centred on the glass: ink at y 53-66, y 78-117 and y 128-144, with 12 rows
 * of leading between them and about 6 rows of air top and bottom.
 *
 * THE BAND IS SIZED TO THE INK, AND THE INK IS NOT THE BAND. A zone clips
 * what it holds and the text sits from the TOP of the zone once the line box
 * is taller than it, so a band has to reach the bottom of the ink or it cuts
 * the letters. Measured at 393px on the rendered page: the ink of a line
 * ends 0.97 of its font size below the band top for the title (line-height
 * 1.2) and 1.10 for the eyebrow, subtitle and pill (line-height 1.6).
 * `tests/painted-zones-never-overlap.law.test.ts` reads those font sizes out
 * of SpadeConsole.css and holds every band to them.
 */
export const SHARK_CONSOLE_ZONES = {
  /* The two-line head: an eyebrow over a title. Unchanged, and live. */
  eyebrow: { x: 70, y: 50, width: 440, height: 26 },
  title: { x: 70, y: 76, width: 590, height: 66 },
  titleBesidePill: { x: 70, y: 76, width: 440, height: 66 },
  /* The three-line head: the same lines, re-measured to make room below. */
  eyebrowWithSubtitle: { x: 70, y: 46, width: 440, height: 21 },
  titleWithSubtitle: { x: 70, y: 67, width: 590, height: 51 },
  titleBesidePillWithSubtitle: { x: 70, y: 67, width: 440, height: 51 },
  /** The glass under the title, stopping clear of the hairline at y 150. */
  subtitle: { x: 70, y: 118, width: 440, height: 31 },
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
  /* The two-line head: an eyebrow over a title. Unchanged, and live. */
  eyebrow: { x: 88, y: 72, width: 350, height: 26 },
  title: { x: 88, y: 100, width: 555, height: 72 },
  titleBesidePill: { x: 88, y: 100, width: 350, height: 72 },
  /* The three-line head, re-measured 2026-09-22. This head's glass runs y 67
     to y 190 on top.png, which is room for all three lines, but the bands as
     drawn were wrong in the same two ways the shark's were: `title` claimed
     72 rows to y 172 while `subtitle` began at y 168, so the rectangles
     intersected over four rows, and the 24-row subtitle band was one row
     shorter than the ink it holds, which cut the bottom off the letters
     (measured: 13.9 rows of ink printed where the line is 15.7). All three
     lines now sit on measured bands, centred on the glass: ink at y 83-96,
     y 108-147 and y 158-174. */
  eyebrowWithSubtitle: { x: 88, y: 76, width: 350, height: 21 },
  titleWithSubtitle: { x: 88, y: 97, width: 555, height: 51 },
  titleBesidePillWithSubtitle: { x: 88, y: 97, width: 350, height: 51 },
  subtitle: { x: 88, y: 148, width: 350, height: 31 },
  /** The chrome capsule at the right of the well, x 455-645 y 85-145. */
  pill: { x: 472, y: 97, width: 156, height: 38 },
  /** The two bolted plates' faces, inside their rims. */
  plateSecondary: { x: 80, y: 82, width: 235, height: 98 },
  platePrimary: { x: 380, y: 82, width: 260, height: 98 },
} as const;

export type ConsoleFamily = 'spade' | 'shark' | 'riveted';

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
} as const;

/** What the head is being asked to print. The zones follow from it. */
export interface ConsoleHeadContent {
  eyebrow: boolean;
  subtitle: boolean;
  pill: boolean;
}

/** Only the head zones this content actually paints, keyed by what they hold. */
export type ConsoleHeadLayout = Partial<Record<'eyebrow' | 'title' | 'subtitle' | 'pill', Zone>> & {
  title: Zone;
};

interface HeadZoneTable {
  eyebrow: Zone;
  title: Zone;
  titleBesidePill: Zone;
  subtitle: Zone;
  pill: Zone;
  /** Only where a head has to re-measure its lines to fit a third one. */
  eyebrowWithSubtitle?: Zone;
  titleWithSubtitle?: Zone;
  titleBesidePillWithSubtitle?: Zone;
}

/**
 * ONE PLACE DECIDES WHICH RECTANGLES A HEAD PAINTS (2026-09-22).
 *
 * A zone table is a set of rectangles on one piece of art, and most of them
 * are alternatives: `title` and `titleBesidePill` are the same line, and the
 * wide one deliberately runs under the pill slot because it is only ever used
 * when there is no pill. So "do these two rectangles overlap" is not a
 * question you can ask the table. It can only be asked of the SET a given
 * head really paints, which is what this returns.
 *
 * The component prints exactly what comes back from here, and
 * `tests/painted-zones-never-overlap.law.test.ts` reads the same function for
 * every combination of head content. That is the point of routing the
 * component through it: a selector the test derives for itself would have
 * gone on agreeing with the old, overlapping table for as long as nobody
 * looked, which is how the shark's title and subtitle sat on top of one
 * another from the day the family was cut.
 */
export function consoleHeadZones(
  family: ConsoleFamily,
  content: ConsoleHeadContent
): ConsoleHeadLayout {
  const zones = FAMILY[family].zones as HeadZoneTable;
  const title = content.subtitle
    ? content.pill
      ? (zones.titleBesidePillWithSubtitle ?? zones.titleBesidePill)
      : (zones.titleWithSubtitle ?? zones.title)
    : content.pill
      ? zones.titleBesidePill
      : zones.title;
  const eyebrow = content.subtitle ? (zones.eyebrowWithSubtitle ?? zones.eyebrow) : zones.eyebrow;
  return {
    title,
    ...(content.eyebrow ? { eyebrow } : {}),
    ...(content.subtitle ? { subtitle: zones.subtitle } : {}),
    ...(content.pill ? { pill: zones.pill } : {}),
  };
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
  style,
}: {
  text: string;
  className?: string;
  /**
   * The element the zone prints into. 'h1' exists for ONE case: the public
   * landing page at the arena root, where the console's painted title zone is
   * the document's only top level heading and the prerendered HTML a crawler
   * reads has to carry it (scripts/prerender-public-routes.mjs refuses to
   * publish a page with no h1). Everywhere else a console lives inside a page
   * that already owns its h1, so the default stays h2.
   */
  as?: 'span' | 'h1' | 'h2' | 'h3' | 'strong';
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
  titleAs = 'h2',
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
  /** See ZoneText's `as`. Only the public landing page asks for 'h1'. */
  titleAs?: 'h1' | 'h2';
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
  /**
   * DOM passthrough, NOT an escape hatch (2026-09-11). This was
   * `& Record<string, unknown>`, which accepted any prop at all: on
   * feat/diamond-games, ArenaAccessBoundary asked for `crest="diamond"` against
   * a copy of this component that had no crest prop, and TypeScript said
   * nothing while the panel rendered the spade and React was handed an unknown
   * DOM attribute. A typed passthrough still carries aria-*, data-*, id and
   * role, and refuses a prop this console does not have.
   */
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  const footKind = foot ?? (plates ? 'plates' : 'foot');
  const F = FAMILY[family];
  const W = F.W;
  const TOP_H = F.TOP_H;
  const Z = F.zones;
  const head = consoleHeadZones(family, {
    eyebrow: Boolean(eyebrow),
    subtitle: Boolean(subtitle),
    pill: Boolean(pill),
  });
  const onePlate = F.plates === 1;
  return (
    <Tag
      className={`sc sc--${footKind} sc--crest-${crest} sc--family-${family} ${className}`.trim()}
      {...rest}
    >
      <div className="sc__head">
        {eyebrow && head.eyebrow && (
          <ZoneText
            text={eyebrow}
            className="sc__eyebrow sc-ink--blue"
            style={zonePct(head.eyebrow, W, TOP_H)}
          />
        )}
        <ZoneText
          as={titleAs}
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
          style={zonePct(head.title, W, TOP_H)}
        />
        {subtitle && head.subtitle && (
          <ZoneText
            text={subtitle}
            className="sc__subtitle sc-ink--muted"
            style={zonePct(head.subtitle, W, TOP_H)}
          />
        )}
        {pill && head.pill && (
          <ZoneText
            text={pill}
            className={`sc__pill sc-ink--${pillInk}`}
            style={zonePct(head.pill, W, TOP_H)}
          />
        )}
      </div>
      {children !== undefined && children !== null && <div className="sc__body">{children}</div>}
      <div className="sc__foot">
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
            zone={(Z as typeof SPADE_CONSOLE_ZONES).plateSecondary}
            canvasW={W}
            canvasH={F.FOOT_H}
            {...plates.secondary}
          />
        )}
        {!onePlate && footKind === 'plates' && plates?.primary && (
          <PlateButton
            zone={(Z as typeof SPADE_CONSOLE_ZONES).platePrimary}
            canvasW={W}
            canvasH={F.FOOT_H}
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
   * THE SAME PLATE, AS A LINK (2026-09-22).
   *
   * A plate that NAVIGATES is an anchor, not a button that calls location.
   * The public landing page at the arena root is the case that forced it:
   * both its ways in leave this app (the World Hub sign up form and the
   * shared sign in route), it is prerendered for crawlers that never run the
   * bundle, and a button is not a link to any of them. It also has to survive
   * a middle click and a long press, which only an href does.
   *
   * The art, the zone and the fit are identical; only the element changes.
   * This is one optional field rather than a second props type in a union,
   * because a union costs every existing caller its contextual typing: the
   * moment `plates` accepted two shapes, TypeScript could no longer infer the
   * event parameter of an inline `onClick` and TournamentLobbyCard went red
   * on an implicit any. Pass `href` only with anchor-shaped props; `disabled`
   * and `type` have no meaning on a link.
   */
  href?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function PlateButton({
  zone,
  canvasW = SPADE_CONSOLE_W,
  canvasH,
  label,
  ink = 'silver',
  buttonRef,
  href,
  className = '',
  style,
  ...rest
}: {
  zone: Zone;
  canvasW?: number;
  canvasH: number;
} & PlateButtonProps) {
  const ref = useFitText<HTMLSpanElement>(label, 1, 0.5);
  const plateStyle = { ...zonePct(zone, canvasW, canvasH), ...style };
  const face = (
    <span className="sc-plate__well">
      <span className={`sc-plate__text sc-ink--${ink}`} ref={ref}>
        {label}
      </span>
    </span>
  );

  if (href !== undefined) {
    /* The passthrough was declared against a button because that is what a
       plate almost always is. An anchor takes the same global and event
       attributes; the handful that differ (type, disabled, form*) are
       meaningless on a link and documented as not-for-links above. */
    const anchorRest = rest as AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a
        className={`sc-plate sc-plate--link ${className}`.trim()}
        href={href}
        style={plateStyle}
        {...anchorRest}
      >
        {face}
      </a>
    );
  }

  return (
    <button
      type="button"
      ref={buttonRef}
      className={`sc-plate ${className}`.trim()}
      style={plateStyle}
      {...rest}
    >
      {face}
    </button>
  );
}
