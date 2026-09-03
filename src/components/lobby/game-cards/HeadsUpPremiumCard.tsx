import type { ArenaGameCardActions, ArenaGameCardData } from './arenaGameCardTypes';
import { zoneText } from './arenaGameCardTypes';
import {
  LayeredActionButton,
  LayeredChassis,
  LayeredFitText,
  LayeredStatus,
  LayeredZoneBox,
  type LayeredCanvas,
  type LayeredZone,
} from './layeredCard';
import './HeadsUpPremiumCard.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HEADS-UP CARD — `shark-headsup-premium-v1`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-03: "'heads up' cards are completely distorted, and need to be
 * replaced, use the exact image I've attached ... change out the dynamic data
 * accordingly."
 *
 * The approved Heads-Up master (733 x 979) with its dynamic words lifted out:
 * title, status plaque, the three top plaques (BUY-IN / game type octagon /
 * REGISTERED), STARTING STACK, BLIND LEVELS, FORMAT and the button label.
 * Every permanent label stays painted.
 */

const assetRoot = `${import.meta.env.BASE_URL}assets/club-buttons/game-cards/heads-up/shark-headsup-premium-v1`;

export const HEADS_UP_PREMIUM_CANVAS: LayeredCanvas = { width: 733, height: 979 };

export const HEADS_UP_PREMIUM_ASSETS = {
  chassis: `${assetRoot}/chassis.png`,
  reference: `${assetRoot}/source/approved-reference.png`,
} as const;

export const HEADS_UP_PREMIUM_ZONES = {
  title: { x: 108, y: 114, width: 396, height: 72, align: 'left' },
  status: { x: 541, y: 129, width: 90, height: 40, align: 'center' },
  buyIn: { x: 112, y: 292, width: 120, height: 62, align: 'center' },
  gameType: { x: 314, y: 288, width: 112, height: 70, align: 'center' },
  registered: { x: 505, y: 292, width: 120, height: 62, align: 'center' },
  startingStack: { x: 110, y: 466, width: 210, height: 62, align: 'center' },
  blindLevels: { x: 415, y: 466, width: 210, height: 62, align: 'center' },
  format: { x: 120, y: 636, width: 495, height: 66, align: 'center' },
  primaryAction: { x: 92, y: 768, width: 550, height: 90, align: 'center' },
} satisfies Record<string, LayeredZone>;

const C = HEADS_UP_PREMIUM_CANVAS;

function Value({
  zone,
  name,
  value,
  className,
}: {
  zone: LayeredZone;
  name: string;
  value: string;
  className?: string;
}) {
  return (
    <LayeredZoneBox canvas={C} zone={zone} name={name}>
      <LayeredFitText
        text={value}
        className={`agc-layered__text--value agc-layered__text--silver${className ? ` ${className}` : ''}`}
      />
    </LayeredZoneBox>
  );
}

export function HeadsUpPremiumCard({
  data,
  actions,
}: {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
}) {
  return (
    <div className="agc-layered agc-headsup-premium">
      <LayeredChassis src={HEADS_UP_PREMIUM_ASSETS.chassis} />

      <LayeredZoneBox canvas={C} zone={HEADS_UP_PREMIUM_ZONES.title} name="title">
        <LayeredFitText
          as="h3"
          text={data.title}
          className="agc-layered__text--title agc-layered__text--silver agc-headsup-premium__title"
        />
      </LayeredZoneBox>

      <LayeredStatus canvas={C} zone={HEADS_UP_PREMIUM_ZONES.status} data={data} />

      <Value
        zone={HEADS_UP_PREMIUM_ZONES.buyIn}
        name="buyIn"
        value={zoneText('buyIn', data.buyIn)}
      />
      <Value
        zone={HEADS_UP_PREMIUM_ZONES.gameType}
        name="gameType"
        value={data.gameType || '-'}
        className="agc-headsup-premium__game-type"
      />
      <Value
        zone={HEADS_UP_PREMIUM_ZONES.registered}
        name="registered"
        value={zoneText('registered', data.registered)}
      />
      <Value
        zone={HEADS_UP_PREMIUM_ZONES.startingStack}
        name="startingStack"
        value={zoneText('startingStack', data.startingStack)}
      />
      <Value
        zone={HEADS_UP_PREMIUM_ZONES.blindLevels}
        name="blindLevels"
        value={zoneText('blindLevels', data.blindLevels)}
      />
      <Value zone={HEADS_UP_PREMIUM_ZONES.format} name="format" value={data.format || 'Standard'} />

      <LayeredActionButton
        canvas={C}
        zone={HEADS_UP_PREMIUM_ZONES.primaryAction}
        name="primaryAction"
        label={actions.primaryLabel}
        tone={actions.primaryTone === 'neutral' ? 'silver' : actions.primaryTone || 'blue'}
        disabled={actions.primaryDisabled}
        busy={actions.busy}
        onClick={actions.onPrimary}
        className="agc-headsup-premium__action"
      />
    </div>
  );
}
