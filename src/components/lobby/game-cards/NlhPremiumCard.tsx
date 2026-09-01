import type { ArenaGameCardActions, ArenaGameCardData } from './arenaGameCardTypes';
import { ArenaPremiumTitle, ArenaPremiumValueText } from './ArenaPremiumText';
import { NLH_PREMIUM_ASSETS, NLH_PREMIUM_ZONES, premiumZoneStyle } from './nlhPremiumTemplate';
import './NlhPremiumCard.css';

interface NlhPremiumCardProps {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
}

function ArtLayer({
  src,
  zone,
  className,
}: {
  src: string;
  zone: keyof typeof NLH_PREMIUM_ZONES;
  className?: string;
}) {
  return (
    <img
      aria-hidden="true"
      alt=""
      className={`agc-nlh-premium__layer${className ? ` ${className}` : ''}`}
      src={src}
      style={premiumZoneStyle(NLH_PREMIUM_ZONES[zone])}
      draggable={false}
    />
  );
}

export function NlhPremiumCard({ data, actions }: NlhPremiumCardProps) {
  const isRunning = data.status === 'running';

  return (
    <div className="agc-nlh-premium">
      <img
        aria-hidden="true"
        alt=""
        className="agc-nlh-premium__chassis"
        src={NLH_PREMIUM_ASSETS.chassis}
        draggable={false}
      />

      {isRunning && (
        <>
          <ArtLayer src={NLH_PREMIUM_ASSETS.liveDot} zone="liveDot" />
          <ArtLayer src={NLH_PREMIUM_ASSETS.statusRunning} zone="status" />
        </>
      )}

      <div
        className="agc-nlh-premium__zone agc-nlh-premium__title"
        data-zone="title"
        style={premiumZoneStyle(NLH_PREMIUM_ZONES.title)}
      >
        <ArenaPremiumTitle title={data.title}>{data.title}</ArenaPremiumTitle>
      </div>

      <div
        className="agc-nlh-premium__zone agc-nlh-premium__subtitle"
        data-zone="subtitle"
        style={premiumZoneStyle(NLH_PREMIUM_ZONES.subtitle)}
      >
        <ArenaPremiumValueText as="span" title={data.subtitle}>
          {data.subtitle || ''}
        </ArenaPremiumValueText>
      </div>

      <ArtLayer src={NLH_PREMIUM_ASSETS.gameTypeNlh} zone="gameType" />

      <div
        className="agc-nlh-premium__zone agc-nlh-premium__value agc-nlh-premium__value--stakes"
        data-zone="stakes"
        style={premiumZoneStyle(NLH_PREMIUM_ZONES.stakes)}
      >
        <ArenaPremiumValueText>{data.stakes || '-'}</ArenaPremiumValueText>
      </div>

      <div
        className="agc-nlh-premium__zone agc-nlh-premium__value agc-nlh-premium__value--players"
        data-zone="players"
        style={premiumZoneStyle(NLH_PREMIUM_ZONES.players)}
      >
        <ArenaPremiumValueText>{data.players || '-'}</ArenaPremiumValueText>
      </div>

      <div
        className="agc-nlh-premium__zone agc-nlh-premium__value agc-nlh-premium__value--buy-in"
        data-zone="buyIn"
        style={premiumZoneStyle(NLH_PREMIUM_ZONES.buyIn)}
      >
        <ArenaPremiumValueText>{data.buyIn || '-'}</ArenaPremiumValueText>
      </div>

      {actions.secondaryLabel && (
        <>
          <ArtLayer src={NLH_PREMIUM_ASSETS.viewTable} zone="viewTableArt" />
          <button
            type="button"
            className="agc-nlh-premium__hitbox"
            data-zone="secondaryAction"
            aria-label={actions.secondaryLabel}
            style={premiumZoneStyle(NLH_PREMIUM_ZONES.secondaryAction)}
            onClick={actions.onSecondary}
          />
        </>
      )}

      <ArtLayer src={NLH_PREMIUM_ASSETS.joinTable} zone="joinTableArt" />
      <button
        type="button"
        className="agc-nlh-premium__hitbox"
        data-zone="primaryAction"
        aria-label={actions.primaryLabel}
        disabled={actions.primaryDisabled || actions.busy}
        style={premiumZoneStyle(NLH_PREMIUM_ZONES.primaryAction)}
        onClick={actions.onPrimary}
      />
    </div>
  );
}
