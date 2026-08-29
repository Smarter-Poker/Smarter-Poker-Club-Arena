import { memo, type CSSProperties, type ReactNode } from 'react';
import { resolveArenaGameCardTemplate } from './arenaGameCardRegistry';
import type {
  ArenaGameCardActions,
  ArenaGameCardData,
  ArenaGameDataState,
} from './arenaGameCardTypes';
import { ArenaGameRuleBadge } from './ArenaGameRuleIcon';
import './ArenaGameCard.css';

export interface ArenaGameCardProps {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
  presentation?: 'auto' | 'desktop' | 'mobile';
  selected?: boolean;
  className?: string;
}

function Fact({ label, value, tone }: { label: string; value?: string; tone?: string }) {
  if (!value) return null;
  return (
    <div className={`agc-fact${tone ? ` agc-fact--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Rules({ data }: { data: ArenaGameCardData }) {
  if (!data.rules.length) return null;
  return (
    <div className="agc-rules" aria-label="Game rules">
      {data.rules.slice(0, 4).map((rule) => (
        <ArenaGameRuleBadge key={rule.key} rule={rule} />
      ))}
      {data.rules.length > 4 && (
        <span className="agc-rule agc-rule--more">+{data.rules.length - 4} Rules</span>
      )}
    </div>
  );
}

function Actions({ actions }: { actions: ArenaGameCardActions }) {
  return (
    <div className="agc-actions">
      {actions.secondaryLabel && (
        <button
          type="button"
          className="agc-action agc-action--secondary"
          onClick={actions.onSecondary}
        >
          {actions.secondaryLabel}
        </button>
      )}
      <button
        type="button"
        className="agc-action agc-action--primary"
        disabled={actions.primaryDisabled || actions.busy}
        onClick={actions.onPrimary}
      >
        {actions.busy ? 'Working...' : actions.primaryLabel}
      </button>
    </div>
  );
}

function Header({ data }: { data: ArenaGameCardData }) {
  return (
    <header className="agc-header">
      <div className="agc-heading">
        <h3 title={data.title}>{data.title}</h3>
        {data.subtitle && <p>{data.subtitle}</p>}
      </div>
      <span className={`agc-status agc-status--${data.status}`}>{data.statusLabel}</span>
    </header>
  );
}

function MttMachine({ data, actions }: ArenaGameCardProps) {
  return (
    <div className="agc-machine agc-machine--mtt">
      <Header data={data} />
      <div className="agc-mtt-meta">
        {data.guarantee && <strong>{data.guarantee}</strong>}
        {data.startTime && <span>{data.startTime}</span>}
      </div>
      <div className="agc-badges">
        {data.featured && <span className="agc-badge agc-badge--gold">Featured</span>}
        {data.registeredByViewer && <span className="agc-badge agc-badge--green">Registered</span>}
      </div>
      <div className="agc-facts agc-facts--four">
        <Fact label="Starting Time" value={data.startTime} tone="blue" />
        <Fact label="Buy-In" value={data.buyIn} />
        <Fact label="Guarantee" value={data.guarantee} tone="blue" />
        <Fact label="Registered" value={data.registered} />
      </div>
      <div className="agc-facts agc-facts--two">
        <Fact label="Starting Stack" value={data.startingStack} />
        <Fact label="Current Level" value={data.currentLevel} tone="blue" />
      </div>
      <Rules data={data} />
      <Actions actions={actions} />
    </div>
  );
}

function CashMachine({ data, actions }: ArenaGameCardProps) {
  return (
    <div className={`agc-machine agc-machine--${data.family}`}>
      <Header data={data} />
      <div className="agc-cash-identity">
        <strong>{data.gameType}</strong>
        <div>
          <span>Stakes</span>
          <b>{data.stakes || '-'}</b>
        </div>
      </div>
      <div className="agc-facts agc-facts--two">
        <Fact label="Players" value={data.players} tone="blue" />
        <Fact label="Buy-In" value={data.buyIn} />
      </div>
      <Rules data={data} />
      <Actions actions={actions} />
    </div>
  );
}

function SpinMachine({ data, actions }: ArenaGameCardProps) {
  return (
    <div className="agc-machine agc-machine--spin">
      <Header data={data} />
      <div className="agc-spin-promo">{data.featured ? '100x Live' : 'Prize Ladder Live'}</div>
      <div className="agc-spin-hero">
        <span>Max Payout</span>
        <strong>{data.maxPayout || 'Win Up To 100x'}</strong>
        {data.topPrize && <b>{data.topPrize}</b>}
      </div>
      <div className="agc-spin-facts">
        <Fact label="Game Type" value={data.gameType} tone="blue" />
        <Fact label="Buy-In" value={data.buyIn} />
        <Fact label="Registered" value={data.registered} />
        <Fact label="Starting Stack" value={data.startingStack} />
        <Fact label="Blind Levels" value={data.blindLevels} />
        <Fact label="Format" value={data.format} />
      </div>
      <Actions actions={actions} />
    </div>
  );
}

function HeadsUpMachine({ data, actions }: ArenaGameCardProps) {
  return (
    <div className="agc-machine agc-machine--heads-up">
      <Header data={data} />
      <div className="agc-duel">
        <Fact label="Buy-In" value={data.buyIn} tone="blue" />
        <strong>{data.gameType}</strong>
        <Fact label="Registered" value={data.registered} />
      </div>
      <div className="agc-facts agc-facts--two">
        <Fact label="Starting Stack" value={data.startingStack} />
        <Fact label="Blind Levels" value={data.blindLevels} tone="blue" />
      </div>
      <div className="agc-format">
        <span>Format</span>
        <strong>{data.format || 'Standard'}</strong>
      </div>
      <Rules data={data} />
      <Actions actions={actions} />
    </div>
  );
}

const familyRenderers: Record<
  ArenaGameCardData['family'],
  (props: ArenaGameCardProps) => ReactNode
> = {
  mtt: MttMachine,
  nlh: CashMachine,
  plo: CashMachine,
  spin: SpinMachine,
  'heads-up': HeadsUpMachine,
};

function stateLabel(state: ArenaGameDataState) {
  if (state === 'loading') return 'Loading Game';
  if (state === 'updating') return 'Updating';
  if (state === 'error') return 'Game Unavailable';
  if (state === 'offline') return 'Offline';
  if (state === 'stale') return 'Last Known Game State';
  return null;
}

export const ArenaGameCard = memo(function ArenaGameCard({
  data,
  actions,
  presentation = 'auto',
  selected,
  className,
}: ArenaGameCardProps) {
  const template = resolveArenaGameCardTemplate(data.family);
  const Renderer = familyRenderers[data.family];
  const dataState = data.dataState || 'loaded';
  const notice = stateLabel(dataState);
  const style = {
    '--agc-art-desktop': `url("${template.desktopArtwork}")`,
    '--agc-art-mobile': `url("${template.mobileArtwork}")`,
    '--agc-desktop-ratio': template.desktopAspectRatio,
    '--agc-mobile-ratio': template.mobileAspectRatio,
  } as CSSProperties;
  const summary = `${data.title}, ${data.gameType}${data.stakes ? ` ${data.stakes}` : ''}, ${data.players || data.registered || 'player count unavailable'}, ${data.statusLabel}`;

  return (
    <article
      className={`arena-game-card arena-game-card--${data.family}${selected ? ' is-selected' : ''}${className ? ` ${className}` : ''}`}
      data-presentation={presentation}
      data-state={dataState}
      style={style}
      aria-label={summary}
      aria-busy={dataState === 'loading' || dataState === 'updating'}
    >
      <span className="arena-game-card__art" aria-hidden="true" />
      <div className="arena-game-card__glass">
        <Renderer data={data} actions={actions} presentation={presentation} />
      </div>
      {notice && <div className="arena-game-card__notice">{notice}</div>}
    </article>
  );
});

export default ArenaGameCard;
