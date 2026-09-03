import type { ArenaGameCardActions, ArenaGameCardData } from './arenaGameCardTypes';
/* The empty-bay answer is shared, not local. This is the card in Dan's own
   2026-09-02 screenshot - the layered NLH card a phone actually gets - and it
   was printing a dash in bays where every LiveValue bay had already been
   changed to print 0. See arenaGameCardTypes.ts. */
import { zoneText } from './arenaGameCardTypes';
import { ArenaPremiumTitle, ArenaPremiumValueText } from './ArenaPremiumText';
import { NLH_PREMIUM_ASSETS, NLH_PREMIUM_ZONES, premiumZoneStyle } from './nlhPremiumTemplate';
import { premiumStatusBadge } from './premiumStatus';
import { useFitText } from './useFitText';
import './NlhPremiumCard.css';

interface NlhPremiumCardProps {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
}

/* The title's stylesheet stretch (scaleX) - useFitText must account for it
   because transforms are invisible to scrollWidth. Keep in step with
   `.arena-premium-text--title` in NlhPremiumCard.css. */
const TITLE_SCALE_X = 1.04;

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

/**
 * The status pill. RUNNING keeps its approved bitmap (glow and lettering are
 * part of the artwork). Every other state - Empty, Full, Waitlist N, Paused -
 * is live DOM text in the same pill, lit in its own colour, because the pill
 * used to sit dark and blank for anything that was not running (Dan
 * 2026-09-03, screenshots 2 and 7).
 */
function StatusBadge({ data }: { data: ArenaGameCardData }) {
  if (data.status === 'running') {
    return (
      <>
        <ArtLayer src={NLH_PREMIUM_ASSETS.liveDot} zone="liveDot" />
        <ArtLayer src={NLH_PREMIUM_ASSETS.statusRunning} zone="status" />
      </>
    );
  }
  const badge = premiumStatusBadge(data);
  return (
    <div
      className={`agc-nlh-premium__zone agc-nlh-premium__status agc-nlh-premium__status--${badge.tone}`}
      data-zone="status"
      data-status={data.status}
      style={premiumZoneStyle(NLH_PREMIUM_ZONES.statusText)}
    >
      <span className="agc-nlh-premium__status-glow" aria-hidden="true" />
      <span className="agc-nlh-premium__status-text">{badge.label}</span>
    </div>
  );
}

export function NlhPremiumCard({ data, actions }: NlhPremiumCardProps) {
  const titleRef = useFitText<HTMLElement>(data.title, TITLE_SCALE_X);
  const titleZone =
    data.status === 'running'
      ? NLH_PREMIUM_ZONES.title
      : data.subtitle
        ? NLH_PREMIUM_ZONES.titleNoDot
        : NLH_PREMIUM_ZONES.titleAlone;

  return (
    <div className="agc-nlh-premium">
      <img
        aria-hidden="true"
        alt=""
        className="agc-nlh-premium__chassis"
        src={NLH_PREMIUM_ASSETS.chassis}
        draggable={false}
      />

      <StatusBadge data={data} />

      <div
        className="agc-nlh-premium__zone agc-nlh-premium__title"
        data-zone="title"
        style={premiumZoneStyle(titleZone)}
      >
        <ArenaPremiumTitle ref={titleRef} title={data.title}>
          {data.title}
        </ArenaPremiumTitle>
      </div>

      {data.subtitle && (
        <div
          className="agc-nlh-premium__zone agc-nlh-premium__subtitle"
          data-zone="subtitle"
          style={premiumZoneStyle(NLH_PREMIUM_ZONES.subtitle)}
        >
          <ArenaPremiumValueText as="span" title={data.subtitle}>
            {data.subtitle}
          </ArenaPremiumValueText>
        </div>
      )}

      <ArtLayer src={NLH_PREMIUM_ASSETS.gameTypeNlh} zone="gameType" />

      <div
        className="agc-nlh-premium__zone agc-nlh-premium__value agc-nlh-premium__value--stakes"
        data-zone="stakes"
        style={premiumZoneStyle(NLH_PREMIUM_ZONES.stakes)}
      >
        <ArenaPremiumValueText>{zoneText('stakes', data.stakes)}</ArenaPremiumValueText>
      </div>

      <div
        className="agc-nlh-premium__zone agc-nlh-premium__value agc-nlh-premium__value--players"
        data-zone="players"
        style={premiumZoneStyle(NLH_PREMIUM_ZONES.players)}
      >
        <ArenaPremiumValueText>{zoneText('players', data.players)}</ArenaPremiumValueText>
      </div>

      <div
        className="agc-nlh-premium__zone agc-nlh-premium__value agc-nlh-premium__value--buy-in"
        data-zone="buyIn"
        style={premiumZoneStyle(NLH_PREMIUM_ZONES.buyIn)}
      >
        <ArenaPremiumValueText>{zoneText('buyIn', data.buyIn)}</ArenaPremiumValueText>
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
