import type { ArenaGameCardActions, ArenaGameCardData } from './arenaGameCardTypes';
import { zoneText } from './arenaGameCardTypes';
import {
  LayeredActionButton,
  LayeredArt,
  LayeredChassis,
  LayeredFitText,
  LayeredStatus,
  LayeredZoneBox,
  type LayeredCanvas,
  type LayeredZone,
} from './layeredCard';
import './PloFourBayCard.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PLO FOUR-BAY CARD — `shark-plo-four-bay-v1`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-03: "EVERY SINGLE PLO CARD NEEDS TO BE 100% COMPLETELY REPLACED
 * AND REDONE. ALL PLO, PLO5, PLO6 AND PLO8 cards should look exactly like the
 * 8th attached image. Make sure the Variant Name is first, Like PLO5 25/50 and
 * then the table name under it."
 *
 * The 8th image is the shark-crest four-bay console: title + live dot and a
 * status pill in the header, four equal plaques (GAME TYPE / STAKES / PLAYERS
 * / BUY-IN) and two side-by-side actions. Its text-free master is the clean
 * shell already in the asset pack; the only bitmap surgery was lifting the
 * baked green dot into its own layer so a table with nobody seated does not
 * claim to be live.
 *
 * Coordinates are measured on the 1254 x 1254 master. The served chassis is
 * a 900px downsample of it; everything is a percentage so that is invisible.
 */

const assetRoot = `${import.meta.env.BASE_URL}assets/club-buttons/game-cards/plo/shark-four-bay-v1`;

export const PLO_FOUR_BAY_CANVAS: LayeredCanvas = { width: 1254, height: 1254 };

export const PLO_FOUR_BAY_ASSETS = {
  chassis: `${assetRoot}/chassis.png`,
  liveDot: `${assetRoot}/live-dot.png`,
  reference: `${assetRoot}/source/approved-reference.png`,
} as const;

const bay = (x: number, width: number) => ({
  label: { x, y: 478, width, height: 56, align: 'center' } satisfies LayeredZone,
  value: {
    x: x + 14,
    y: 556,
    width: width - 28,
    height: 178,
    align: 'center',
  } satisfies LayeredZone,
});

export const PLO_FOUR_BAY_ZONES = {
  liveDot: { x: 106, y: 211, width: 80, height: 80 },
  title: { x: 192, y: 208, width: 640, height: 84, align: 'left' },
  titleNoDot: { x: 128, y: 208, width: 704, height: 84, align: 'left' },
  /* Dan 2026-09-03 review: "ALL TABLE NAMES (THE LINE BELOW THE TITLE HEADER)
     NEEDS TO BE LOWER, AND NOT RIGHT ON TOP OF THE TITLE." */
  subtitle: { x: 130, y: 318, width: 700, height: 48, align: 'left' },
  status: { x: 872, y: 222, width: 245, height: 72, align: 'center' },
  gameType: bay(130, 220),
  stakes: bay(388, 217),
  players: bay(645, 215),
  buyIn: bay(900, 220),
  secondaryAction: { x: 132, y: 932, width: 458, height: 128, align: 'center' },
  primaryAction: { x: 662, y: 932, width: 458, height: 128, align: 'center' },
} as const;

const C = PLO_FOUR_BAY_CANVAS;

function Bay({
  zone,
  name,
  label,
  value,
  tone,
  small,
}: {
  zone: ReturnType<typeof bay>;
  name: string;
  label: string;
  value: string;
  tone: 'silver' | 'white' | 'blue';
  small?: boolean;
}) {
  return (
    <>
      <LayeredZoneBox canvas={C} zone={zone.label} name={`${name}Label`}>
        <LayeredFitText
          as="span"
          text={label}
          className="agc-layered__text--label agc-layered__text--blue"
        />
      </LayeredZoneBox>
      <LayeredZoneBox canvas={C} zone={zone.value} name={name} className="agc-plo-four-bay__value">
        <LayeredFitText
          text={value}
          className={`${small ? 'agc-layered__text--value-sm agc-layered__text--wrap' : 'agc-layered__text--value'} agc-layered__text--${tone}`}
          minRatio={0.6}
        />
      </LayeredZoneBox>
    </>
  );
}

export function PloFourBayCard({
  data,
  actions,
}: {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
}) {
  const running = data.status === 'running';
  const buyIn = zoneText('buyIn', data.buyIn);

  return (
    <div className="agc-layered agc-plo-four-bay">
      <LayeredChassis src={PLO_FOUR_BAY_ASSETS.chassis} />

      {running && (
        <LayeredArt
          canvas={C}
          zone={PLO_FOUR_BAY_ZONES.liveDot}
          src={PLO_FOUR_BAY_ASSETS.liveDot}
        />
      )}

      <LayeredZoneBox
        canvas={C}
        zone={running ? PLO_FOUR_BAY_ZONES.title : PLO_FOUR_BAY_ZONES.titleNoDot}
        name="title"
        className="agc-plo-four-bay__title"
      >
        <LayeredFitText
          as="h3"
          text={data.title}
          className="agc-layered__text--title agc-layered__text--silver"
        />
      </LayeredZoneBox>

      {data.subtitle && (
        <LayeredZoneBox canvas={C} zone={PLO_FOUR_BAY_ZONES.subtitle} name="subtitle">
          <LayeredFitText
            as="span"
            text={data.subtitle}
            className="agc-layered__text--subtitle agc-layered__text--muted"
          />
        </LayeredZoneBox>
      )}

      <LayeredStatus canvas={C} zone={PLO_FOUR_BAY_ZONES.status} data={data} />

      <Bay
        zone={PLO_FOUR_BAY_ZONES.gameType}
        name="gameType"
        label="Game Type"
        value={data.gameType || 'PLO'}
        tone="white"
      />
      <Bay
        zone={PLO_FOUR_BAY_ZONES.stakes}
        name="stakes"
        label="Stakes"
        value={zoneText('stakes', data.stakes)}
        tone="silver"
      />
      <Bay
        zone={PLO_FOUR_BAY_ZONES.players}
        name="players"
        label="Players"
        value={zoneText('players', data.players)}
        tone="silver"
      />
      <Bay
        zone={PLO_FOUR_BAY_ZONES.buyIn}
        name="buyIn"
        label="Buy-In"
        value={buyIn.includes('-') ? buyIn.replace(/\s*-\s*/, ' -\n') : buyIn}
        tone="silver"
        small={buyIn.length > 6}
      />

      {actions.secondaryLabel && (
        <LayeredActionButton
          canvas={C}
          zone={PLO_FOUR_BAY_ZONES.secondaryAction}
          name="secondaryAction"
          label={actions.secondaryLabel}
          tone="silver"
          onClick={actions.onSecondary}
        />
      )}
      <LayeredActionButton
        canvas={C}
        zone={PLO_FOUR_BAY_ZONES.primaryAction}
        name="primaryAction"
        label={actions.primaryLabel}
        tone={actions.primaryTone === 'neutral' ? 'silver' : actions.primaryTone || 'blue'}
        disabled={actions.primaryDisabled}
        busy={actions.busy}
        onClick={actions.onPrimary}
      />
    </div>
  );
}
