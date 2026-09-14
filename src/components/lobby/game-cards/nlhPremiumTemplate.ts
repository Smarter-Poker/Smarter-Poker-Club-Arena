import type { CSSProperties } from 'react';

const assetRoot = `${import.meta.env.BASE_URL}assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1`;

export const NLH_PREMIUM_CANVAS = {
  width: 729,
  height: 945,
} as const;

export const NLH_PREMIUM_ASSETS = {
  reference: `${assetRoot}/source/approved-reference.png`,
  chassis: `${assetRoot}/chassis.png`,
  statusRunning: `${assetRoot}/statuses/running.png`,
  liveDot: `${assetRoot}/statuses/live-dot.png`,
  gameTypeNlh: `${assetRoot}/types/nlh.png`,
  viewTable: `${assetRoot}/buttons/view-table.png`,
  joinTable: `${assetRoot}/buttons/join-table.png`,
  /* The same two plates with their painted words lifted out (2026-09-04),
     so the label the card prints is the action it performs: a full table
     used to read JOIN TABLE while the action was Join Waitlist, and a seat
     of your own read JOIN TABLE while it was Return To Game. */
  viewPlate: `${assetRoot}/buttons/view-plate.png`,
  joinPlate: `${assetRoot}/buttons/join-plate.png`,
} as const;

export interface NlhPremiumZone {
  x: number;
  y: number;
  width: number;
  height: number;
  align?: 'left' | 'center' | 'right';
  maxLines?: 1 | 2;
}

/**
 * Pixel coordinates on the locked 729 x 945 approved NLH master.
 * Runtime layout is derived from this one coordinate map, never guessed by flex/grid.
 */
export const NLH_PREMIUM_ZONES = {
  title: { x: 131, y: 116, width: 269, height: 66, align: 'left', maxLines: 1 },
  /* Without the live dot (any state but running) the title starts where the
     subtitle does instead of leaving the dot's gap; without a subtitle it
     drops to the header's centre line. */
  titleNoDot: { x: 90, y: 116, width: 310, height: 66, align: 'left', maxLines: 1 },
  titleAlone: { x: 90, y: 128, width: 310, height: 66, align: 'left', maxLines: 1 },
  /* Dan 2026-09-03 review: the table-name line "NEEDS TO BE LOWER, AND NOT
     RIGHT ON TOP OF THE TITLE". Was y 174. */
  subtitle: { x: 90, y: 186, width: 297, height: 43, align: 'left', maxLines: 1 },
  liveDot: { x: 72, y: 120, width: 48, height: 52 },
  status: { x: 441, y: 112, width: 227, height: 93 },
  /* The lit interior of the same pill, for the DOM-text states (Empty, Full,
     Waitlist N). Inset from the chrome rim so the glow never paints over it. */
  /* Measured on running.png: the word RUNNING sits at x 499-611, y 145-164
     of the master (centre 555, 154.5). The DOM states share that centre so
     Empty / Full / Waitlist sit exactly where Running does (Dan 2026-09-03:
     "make sure all the pills are lined up right"). */
  statusText: { x: 462, y: 128, width: 186, height: 53, align: 'center', maxLines: 1 },
  gameType: { x: 83, y: 250, width: 214, height: 174 },
  stakes: { x: 331, y: 305, width: 275, height: 82, align: 'center', maxLines: 1 },
  players: { x: 112, y: 477, width: 151, height: 84, align: 'center', maxLines: 1 },
  buyIn: { x: 322, y: 477, width: 302, height: 84, align: 'center', maxLines: 1 },
  viewTableArt: { x: 40, y: 624, width: 307, height: 174 },
  joinTableArt: { x: 343, y: 620, width: 338, height: 180 },
  secondaryAction: { x: 56, y: 653, width: 270, height: 118 },
  primaryAction: { x: 365, y: 650, width: 290, height: 121 },
} satisfies Record<string, NlhPremiumZone>;

export function premiumZoneStyle(zone: NlhPremiumZone): CSSProperties {
  return {
    left: `${(zone.x / NLH_PREMIUM_CANVAS.width) * 100}%`,
    top: `${(zone.y / NLH_PREMIUM_CANVAS.height) * 100}%`,
    width: `${(zone.width / NLH_PREMIUM_CANVAS.width) * 100}%`,
    height: `${(zone.height / NLH_PREMIUM_CANVAS.height) * 100}%`,
    textAlign: zone.align,
  };
}
