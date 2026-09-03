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
import './SpinsPremiumCard.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SPINS CARD — `shark-spins-premium-v1`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-03: "'spins' cards are completely distorted, and need to be
 * replaced, use the exact image I've attached ... use this exactly and change
 * out the dynamic data accordingly."
 *
 * The attached image is the approved Spins master (734 x 949). Its chassis is
 * that master with every DYNAMIC word lifted out - title, the gold promo
 * pill's text, the status plaque, the five plaque values, the payout chamber's
 * three lines and the button label - while the permanent labels (GAME TYPE,
 * BUY-IN, MAX PAYOUT, REGISTERED, STARTING STACK, BLIND LEVELS, FORMAT), the
 * shark crests and the chamber itself stay painted. Live data is printed back
 * into the measured coordinates below.
 */

const assetRoot = `${import.meta.env.BASE_URL}assets/club-buttons/game-cards/spins/shark-spins-premium-v1`;

export const SPINS_PREMIUM_CANVAS: LayeredCanvas = { width: 734, height: 949 };

export const SPINS_PREMIUM_ASSETS = {
  chassis: `${assetRoot}/chassis.png`,
  reference: `${assetRoot}/source/approved-reference.png`,
} as const;

export const SPINS_PREMIUM_ZONES = {
  title: { x: 112, y: 104, width: 510, height: 78, align: 'center' },
  promo: { x: 296, y: 194, width: 144, height: 32, align: 'center' },
  status: { x: 576, y: 199, width: 80, height: 31, align: 'center' },
  gameType: { x: 52, y: 372, width: 86, height: 66, align: 'center' },
  buyIn: { x: 148, y: 372, width: 84, height: 66, align: 'center' },
  payoutLead: { x: 280, y: 366, width: 176, height: 34, align: 'center' },
  payoutHero: { x: 276, y: 400, width: 184, height: 70, align: 'center' },
  topPrize: { x: 280, y: 470, width: 176, height: 32, align: 'center' },
  registered: { x: 497, y: 372, width: 86, height: 66, align: 'center' },
  startingStack: { x: 597, y: 372, width: 96, height: 66, align: 'center' },
  blindLevels: { x: 112, y: 646, width: 146, height: 58, align: 'center' },
  format: { x: 472, y: 646, width: 146, height: 58, align: 'center' },
  primaryAction: { x: 100, y: 780, width: 535, height: 88, align: 'center' },
} satisfies Record<string, LayeredZone>;

const C = SPINS_PREMIUM_CANVAS;

function payoutParts(value?: string) {
  const normalized = value || 'Win Up To 100x';
  const match = normalized.match(/^(.*?)(\d+(?:\.\d+)?x)$/i);
  return match ? { lead: match[1].trim(), hero: match[2] } : { lead: '', hero: normalized };
}

function prizeParts(value?: string) {
  if (!value) return '';
  return /^top prize/i.test(value) ? value : `Top Prize ${value}`;
}

function Value({
  zone,
  name,
  value,
  tone = 'silver',
  className,
}: {
  zone: LayeredZone;
  name: string;
  value: string;
  tone?: 'silver' | 'blue' | 'white' | 'gold';
  className?: string;
}) {
  return (
    <LayeredZoneBox canvas={C} zone={zone} name={name} className={className}>
      <LayeredFitText
        text={value}
        className={`agc-layered__text--value agc-layered__text--${tone}`}
      />
    </LayeredZoneBox>
  );
}

export function SpinsPremiumCard({
  data,
  actions,
}: {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
}) {
  const payout = payoutParts(data.maxPayout);
  const prize = prizeParts(data.topPrize);
  const promo = data.featured ? `${payout.hero} Live` : 'Prize Ladder Live';

  return (
    <div className="agc-layered agc-spins-premium">
      <LayeredChassis src={SPINS_PREMIUM_ASSETS.chassis} />

      <LayeredZoneBox canvas={C} zone={SPINS_PREMIUM_ZONES.title} name="title">
        <LayeredFitText
          as="h3"
          text={data.title}
          className="agc-layered__text--title agc-layered__text--silver agc-spins-premium__title"
        />
      </LayeredZoneBox>

      <LayeredZoneBox canvas={C} zone={SPINS_PREMIUM_ZONES.promo} name="promotion">
        <LayeredFitText as="span" text={promo} className="agc-spins-premium__promo" />
      </LayeredZoneBox>

      <LayeredStatus canvas={C} zone={SPINS_PREMIUM_ZONES.status} data={data} />

      <Value
        zone={SPINS_PREMIUM_ZONES.gameType}
        name="gameType"
        value={data.gameType || '-'}
        tone="blue"
      />
      <Value zone={SPINS_PREMIUM_ZONES.buyIn} name="buyIn" value={zoneText('buyIn', data.buyIn)} />

      <LayeredZoneBox canvas={C} zone={SPINS_PREMIUM_ZONES.payoutLead} name="maxPayoutLead">
        <LayeredFitText
          as="span"
          text={payout.lead || 'Win Up To'}
          className="agc-spins-premium__lead agc-layered__text--white"
        />
      </LayeredZoneBox>
      <LayeredZoneBox canvas={C} zone={SPINS_PREMIUM_ZONES.payoutHero} name="maxPayout">
        <LayeredFitText
          text={payout.hero}
          className="agc-spins-premium__hero agc-layered__text--gold"
        />
      </LayeredZoneBox>
      {prize && (
        <LayeredZoneBox canvas={C} zone={SPINS_PREMIUM_ZONES.topPrize} name="topPrize">
          <LayeredFitText
            as="span"
            text={prize}
            className="agc-spins-premium__prize agc-layered__text--white"
          />
        </LayeredZoneBox>
      )}

      <Value
        zone={SPINS_PREMIUM_ZONES.registered}
        name="registered"
        value={zoneText('registered', data.registered)}
      />
      <Value
        zone={SPINS_PREMIUM_ZONES.startingStack}
        name="startingStack"
        value={zoneText('startingStack', data.startingStack)}
      />
      <Value
        zone={SPINS_PREMIUM_ZONES.blindLevels}
        name="blindLevels"
        value={zoneText('blindLevels', data.blindLevels)}
      />
      <Value
        zone={SPINS_PREMIUM_ZONES.format}
        name="format"
        value={zoneText('format', data.format)}
      />

      <LayeredActionButton
        canvas={C}
        zone={SPINS_PREMIUM_ZONES.primaryAction}
        name="primaryAction"
        label={actions.primaryLabel}
        tone={actions.primaryTone === 'neutral' ? 'silver' : actions.primaryTone || 'blue'}
        disabled={actions.primaryDisabled}
        busy={actions.busy}
        onClick={actions.onPrimary}
        className="agc-spins-premium__action"
      />
    </div>
  );
}
