import type { ArenaGameCardActions, ArenaGameCardData } from './arenaGameCardTypes';
import { zoneText } from './arenaGameCardTypes';
import { useFitText } from './useFitText';
import './MttPremiumCard.css';

function Fitted({ text }: { text: string }) {
  const ref = useFitText<HTMLSpanElement>(text, 1, 0.35);
  return (
    <span ref={ref} className="agc-mtt-premium__fit">
      {text}
    </span>
  );
}

/** One native-ratio chassis. Every live value occupies its own measured face. */
export function MttPremiumCard({
  data,
  actions,
}: {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
}) {
  const titleRef = useFitText<HTMLHeadingElement>(data.title, 1, 0.45, {
    wrapBelow: 0.8,
    maxLines: 2,
  });
  const metrics = [
    ['startingTime', 'Starting Time', data.startTime],
    ['buyIn', 'Buy-In', data.buyIn],
    ['guarantee', 'Guarantee', data.guarantee],
    ['registered', 'Registered', data.registered],
    ['startingStack', 'Starting Stack', data.startingStack],
    ['currentLevel', 'Current Level', data.currentLevel],
  ] as const;
  return (
    <div className="agc-mtt-premium">
      <img
        className="agc-mtt-premium__chassis"
        src={`${import.meta.env.BASE_URL}assets/club-buttons/game-cards/mtt/cash-style-v3/chassis.png`}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <header className="agc-mtt-premium__header">
        <h3 ref={titleRef} title={data.title} data-zone="title">
          {data.title}
        </h3>
        <div className="agc-mtt-premium__status" data-zone="status">
          <Fitted text={[data.statusLabel, data.startsIn].filter(Boolean).join(' · ')} />
        </div>
        <div className="agc-mtt-premium__rules" data-zone="rules">
          <Fitted
            text={[
              data.gameType,
              data.featured ? 'Featured' : '',
              data.registeredByViewer ? 'Registered' : '',
              ...data.rules.slice(0, 2).map((rule) => rule.label),
              data.rules.length > 2 ? `+${data.rules.length - 2} Rules` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        </div>
      </header>
      {metrics.map(([zone, label, value], index) => (
        <div
          key={zone}
          data-zone={zone}
          className={`agc-mtt-premium__bay agc-mtt-premium__bay--${index}`}
        >
          <span className="agc-mtt-premium__label">{label}</span>
          <strong>
            <Fitted text={zoneText(zone, value)} />
          </strong>
          {zone === 'currentLevel' && data.currentBlinds && <small>{data.currentBlinds}</small>}
        </div>
      ))}
      {actions.secondaryLabel && (
        <button
          type="button"
          data-zone="secondaryAction"
          className="agc-mtt-premium__action agc-mtt-premium__action--secondary"
          onClick={actions.onSecondary}
        >
          <Fitted text={actions.secondaryLabel} />
        </button>
      )}
      <button
        type="button"
        data-zone="primaryAction"
        className={`agc-mtt-premium__action agc-mtt-premium__action--primary agc-mtt-premium__action--${actions.primaryTone || 'blue'}`}
        disabled={actions.primaryDisabled || actions.busy}
        onClick={actions.onPrimary}
      >
        <Fitted text={actions.busy ? 'Working...' : actions.primaryLabel} />
      </button>
    </div>
  );
}
