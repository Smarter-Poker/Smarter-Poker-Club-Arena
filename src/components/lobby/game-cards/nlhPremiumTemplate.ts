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
  subtitle: { x: 90, y: 174, width: 297, height: 43, align: 'left', maxLines: 1 },
  liveDot: { x: 72, y: 120, width: 48, height: 52 },
  status: { x: 441, y: 112, width: 227, height: 93 },
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
