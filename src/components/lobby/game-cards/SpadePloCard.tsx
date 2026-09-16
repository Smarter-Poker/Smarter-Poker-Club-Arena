import type { ArenaGameCardActions, ArenaGameCardData } from './arenaGameCardTypes';
import { zoneText } from './arenaGameCardTypes';
import {
  LayeredActionButton,
  LayeredBuyIn,
  LayeredChassis,
  LayeredFitText,
  LayeredStatus,
  LayeredZoneBox,
  splitBuyInRange,
  type LayeredCanvas,
  type LayeredZone,
} from './layeredCard';
import './SpadePloCard.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PLO CARD — `spade-plo-premium-v1`, Dan's 2026-09-04 master
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04: "THE TOPS OF THE PLO FRAMES ARE DISTORTED, USE THIS NEW IMAGE
 * EXACTLY." The new master (1177 x 1337) is the spade console: spade crest,
 * a header well with the title, subtitle and status pill, four labelled bays
 * (GAME TYPE / STAKES / PLAYERS / BUY-IN) whose labels are painted, VIEW TABLE
 * and JOIN TABLE plates, and the spade chip at the foot. It replaces the
 * shark four-bay console as the default for every Omaha card on a phone.
 *
 * As with every layered card the chassis is the master with its dynamic words
 * lifted out; title, subtitle, status, the four values and both button labels
 * are live DOM printed into coordinates measured on the master.
 */

const assetRoot = `${import.meta.env.BASE_URL}assets/club-buttons/game-cards/plo/spade-plo-premium-v1`;

export const SPADE_PLO_CANVAS: LayeredCanvas = { width: 1177, height: 1337 };

export const SPADE_PLO_ASSETS = {
  chassis: `${assetRoot}/chassis-b0b05b302c99.png`,
  reference: `${assetRoot}/source/approved-reference.png`,
} as const;

export const SPADE_PLO_ZONES = {
  title: { x: 150, y: 196, width: 560, height: 100, align: 'left' },
  subtitle: { x: 152, y: 312, width: 560, height: 48, align: 'left' },
  status: { x: 792, y: 224, width: 232, height: 64, align: 'center' },
  gameType: { x: 150, y: 590, width: 152, height: 160, align: 'center' },
  stakes: { x: 394, y: 590, width: 152, height: 160, align: 'center' },
  players: { x: 634, y: 590, width: 152, height: 160, align: 'center' },
  buyIn: { x: 874, y: 590, width: 152, height: 160, align: 'center' },
  secondaryAction: { x: 118, y: 878, width: 448, height: 152, align: 'center' },
  primaryAction: { x: 612, y: 878, width: 448, height: 152, align: 'center' },
} satisfies Record<string, LayeredZone>;

const C = SPADE_PLO_CANVAS;

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
    <LayeredZoneBox canvas={C} zone={zone} name={name} className="agc-spade-plo__value">
      <LayeredFitText
        text={value}
        className={`agc-layered__text--value agc-layered__text--silver${className ? ` ${className}` : ''}`}
        minRatio={0.6}
      />
    </LayeredZoneBox>
  );
}

export function SpadePloCard({
  data,
  actions,
}: {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
}) {
  const buyIn = zoneText('buyIn', data.buyIn);

  return (
    <div className="agc-layered agc-spade-plo">
      <LayeredChassis src={SPADE_PLO_ASSETS.chassis} />

      <LayeredZoneBox
        canvas={C}
        zone={SPADE_PLO_ZONES.title}
        name="title"
        className="agc-spade-plo__title"
      >
        <LayeredFitText
          as="h3"
          text={data.title}
          className="agc-layered__text--title agc-layered__text--silver"
        />
      </LayeredZoneBox>

      {data.subtitle && (
        <LayeredZoneBox canvas={C} zone={SPADE_PLO_ZONES.subtitle} name="subtitle">
          <LayeredFitText
            as="span"
            text={data.subtitle}
            className="agc-layered__text--subtitle agc-layered__text--muted"
          />
        </LayeredZoneBox>
      )}

      <LayeredStatus canvas={C} zone={SPADE_PLO_ZONES.status} data={data} />

      <Value zone={SPADE_PLO_ZONES.gameType} name="gameType" value={data.gameType || 'PLO'} />
      <Value zone={SPADE_PLO_ZONES.stakes} name="stakes" value={zoneText('stakes', data.stakes)} />
      <Value
        zone={SPADE_PLO_ZONES.players}
        name="players"
        value={zoneText('players', data.players)}
      />
      <LayeredZoneBox
        canvas={C}
        zone={SPADE_PLO_ZONES.buyIn}
        name="buyIn"
        className="agc-spade-plo__value"
      >
        <LayeredBuyIn
          value={buyIn}
          className={`agc-layered__text--silver${splitBuyInRange(buyIn) ? '' : ' agc-layered__text--value'}`}
          lineClassName="agc-layered__text--value-sm"
        />
      </LayeredZoneBox>

      {actions.secondaryLabel && (
        <LayeredActionButton
          canvas={C}
          zone={SPADE_PLO_ZONES.secondaryAction}
          name="secondaryAction"
          label={actions.secondaryLabel}
          tone="silver"
          onClick={actions.onSecondary}
        />
      )}
      <LayeredActionButton
        canvas={C}
        zone={SPADE_PLO_ZONES.primaryAction}
        name="primaryAction"
        label={actions.primaryLabel}
        /* The master letters JOIN TABLE in silver on its blue plate; only a
           state that carries its own colour (Return To Game, Leave Waitlist,
           Late Register) changes the ink. */
        tone={
          actions.primaryTone === 'green' ||
          actions.primaryTone === 'red' ||
          actions.primaryTone === 'gold'
            ? actions.primaryTone
            : 'silver'
        }
        disabled={actions.primaryDisabled}
        busy={actions.busy}
        onClick={actions.onPrimary}
      />
    </div>
  );
}
