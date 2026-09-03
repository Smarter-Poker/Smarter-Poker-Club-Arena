import { memo, type CSSProperties, type ReactNode } from 'react';
import { resolveArenaGameCardTemplate } from './arenaGameCardRegistry';
import type {
  ArenaGameCardActions,
  ArenaGameCardData,
  ArenaGameDataState,
} from './arenaGameCardTypes';
import { ArenaGameRuleBadge } from './ArenaGameRuleIcon';
import { NlhPremiumCard } from './NlhPremiumCard';
import './ArenaGameCard.css';

const CASH_CARD_TITLE_LIMIT = 30;
const TOURNAMENT_CARD_TITLE_LIMIT = 44;

function constrainedTitle(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  const candidate = normalized.slice(0, Math.max(1, limit - 1));
  const wordBreak = candidate.lastIndexOf(' ');
  return `${candidate.slice(0, wordBreak > limit * 0.62 ? wordBreak : candidate.length).trimEnd()}…`;
}

function ActionIcon({ label }: { label: string }) {
  const normalized = label.toLowerCase();
  if (normalized.includes('detail')) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 10v7M12 7h.01" />
      </svg>
    );
  }
  if (normalized.includes('watch') || normalized.includes('view')) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    );
  }
  if (normalized.includes('wait')) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3h10M7 21h10M8 3c0 5 2 6 4 9-2 3-4 4-4 9m8-18c0 5-2 6-4 9 2 3 4 4 4 9" />
      </svg>
    );
  }
  if (normalized.includes('registered') || normalized.includes('return')) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Z" />
        <path d="m8.5 12 2.2 2.2 4.8-5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Z" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

export interface ArenaGameCardProps {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
  presentation?: 'auto' | 'desktop' | 'mobile';
  /** Explicit visual-only override. It never changes data or handlers. */
  skin?: string;
  /** Reserved for future club-level visual configuration. */
  clubSkin?: string;
  selected?: boolean;
  className?: string;
}

function Rules({
  data,
  className,
  limit = 4,
  omit = [],
}: {
  data: ArenaGameCardData;
  className?: string;
  limit?: number;
  omit?: string[];
}) {
  const rules = data.rules.filter((rule) => !omit.includes(rule.key));
  if (!rules.length) return null;
  return (
    <div
      className={`agc-rules${className ? ` ${className}` : ''}`}
      data-zone="rules"
      aria-label="Game Rules"
    >
      {rules.slice(0, limit).map((rule) => (
        <ArenaGameRuleBadge key={rule.key} rule={rule} />
      ))}
      {rules.length > limit && (
        <span className="agc-rule agc-rule--more">+{rules.length - limit} Rules</span>
      )}
    </div>
  );
}

function Actions({ actions }: { actions: ArenaGameCardActions }) {
  const inferredTone = actions.primaryLabel.toLowerCase().includes('registered')
    ? 'green'
    : actions.primaryTone || 'blue';
  return (
    <div className="agc-actions" data-zone="actions">
      {actions.secondaryLabel && (
        <button
          type="button"
          className="agc-action agc-action--secondary"
          data-zone="secondaryAction"
          onClick={actions.onSecondary}
        >
          <i className="agc-action__icon">
            <ActionIcon label={actions.secondaryLabel} />
          </i>
          <span>{actions.secondaryLabel}</span>
        </button>
      )}
      <button
        type="button"
        className={`agc-action agc-action--primary agc-action--${inferredTone}`}
        data-zone="primaryAction"
        disabled={actions.primaryDisabled || actions.busy}
        onClick={actions.onPrimary}
      >
        <i className="agc-action__icon">
          <ActionIcon label={actions.primaryLabel} />
        </i>
        <span>{actions.busy ? 'Working...' : actions.primaryLabel}</span>
      </button>
    </div>
  );
}

function PremiumStatus({ data }: { data: ArenaGameCardData }) {
  return (
    <span className={`agc-premium-status agc-premium-status--${data.status}`} data-zone="status">
      <i aria-hidden="true" />
      {data.statusLabel}
    </span>
  );
}

function PremiumHeader({
  data,
  showSubtitle = true,
}: {
  data: ArenaGameCardData;
  showSubtitle?: boolean;
}) {
  const title = constrainedTitle(data.title, CASH_CARD_TITLE_LIMIT);
  return (
    <header className="agc-premium-header">
      <div className="agc-premium-heading" data-zone="title">
        <h3 title={data.title}>{title}</h3>
        {showSubtitle && data.subtitle && <p>{data.subtitle}</p>}
      </div>
      <PremiumStatus data={data} />
    </header>
  );
}

function LiveValue({
  className,
  value,
  zone,
  children,
  icon,
}: {
  className: string;
  value?: string;
  zone: string;
  children?: ReactNode;
  icon?: 'stakes' | 'players' | 'buy-in';
}) {
  return (
    <div className={`agc-premium-value ${className}`} data-zone={zone}>
      {icon && (
        <span className={`agc-value-medallion agc-value-medallion--${icon}`} aria-hidden="true" />
      )}
      {children || <strong>{value || '-'}</strong>}
    </div>
  );
}

function MttMachine({ data, actions }: ArenaGameCardProps) {
  const visibleRules = data.rules.slice(0, 2);
  const displayTitle = constrainedTitle(data.title, TOURNAMENT_CARD_TITLE_LIMIT);
  return (
    <div className="agc-machine agc-machine--mtt">
      <span className="agc-mtt-club-chip" aria-hidden="true" />
      <header className="agc-mtt-header">
        <h3 data-zone="title" title={data.title}>
          {displayTitle}
        </h3>
        <div className="agc-mtt-meta">
          {data.guarantee && <strong data-zone="guarantee">{data.guarantee}</strong>}
          {data.guarantee && <i aria-hidden="true" />}
          <span data-zone="startsIn">{data.startsIn || data.statusLabel}</span>
        </div>
        <div className="agc-mtt-badge-rail">
          {data.featured && (
            <span className="agc-badge agc-badge--gold">
              <b aria-hidden="true">★</b> Featured
            </span>
          )}
          {data.registeredByViewer && (
            <span className="agc-badge agc-badge--green">
              <b aria-hidden="true">✓</b> Registered
            </span>
          )}
          {visibleRules.map((rule) => (
            <ArenaGameRuleBadge key={rule.key} rule={rule} />
          ))}
          {data.rules.length > visibleRules.length && (
            <span className="agc-rule agc-rule--more">
              +{data.rules.length - visibleRules.length} Rules
            </span>
          )}
        </div>
      </header>
      <div className="agc-mtt-value agc-mtt-value--starting-time" data-zone="startingTime">
        <strong>{data.startTime || '-'}</strong>
      </div>
      <div className="agc-mtt-value agc-mtt-value--buy-in" data-zone="buyIn">
        <strong>{data.buyIn || '-'}</strong>
      </div>
      <div className="agc-mtt-value agc-mtt-value--guarantee" data-zone="guarantee">
        <strong>{data.guarantee || '-'}</strong>
      </div>
      <div className="agc-mtt-value agc-mtt-value--registered" data-zone="registered">
        <strong>{data.registered || '-'}</strong>
      </div>
      <div className="agc-mtt-value agc-mtt-value--starting-stack" data-zone="startingStack">
        <strong>{data.startingStack || '-'}</strong>
      </div>
      <div className="agc-mtt-value agc-mtt-value--current-level" data-zone="currentLevel">
        <strong>{data.currentLevel || '-'}</strong>
        {data.currentBlinds && <small>{data.currentBlinds}</small>}
      </div>
      <Actions actions={actions} />
    </div>
  );
}

function NlhMachine({ data, actions }: ArenaGameCardProps) {
  return (
    <div className="agc-machine agc-machine--nlh">
      <PremiumHeader data={data} />
      <Rules data={data} className="agc-premium-rules agc-premium-rules--nlh" limit={3} />
      <LiveValue className="agc-premium-value--game-type" value={data.gameType} zone="gameType" />
      <LiveValue
        className="agc-premium-value--stakes"
        value={data.stakes}
        zone="stakes"
        icon="stakes"
      />
      <LiveValue
        className="agc-premium-value--players"
        value={data.players}
        zone="players"
        icon="players"
      />
      <LiveValue
        className="agc-premium-value--buy-in"
        value={data.buyIn}
        zone="buyIn"
        icon="buy-in"
      />
      <Actions actions={actions} />
    </div>
  );
}

function PloMachine({ data, actions }: ArenaGameCardProps) {
  return (
    <div className="agc-machine agc-machine--plo">
      <PremiumHeader data={data} />
      <Rules data={data} className="agc-premium-rules agc-premium-rules--plo" limit={3} />
      <LiveValue className="agc-premium-value--game-type" value={data.gameType} zone="gameType" />
      <span className="agc-plo-game-repeat" aria-hidden="true">
        {data.gameType}
      </span>
      <LiveValue
        className="agc-premium-value--stakes"
        value={data.stakes}
        zone="stakes"
        icon="stakes"
      />
      <LiveValue
        className="agc-premium-value--players"
        value={data.players}
        zone="players"
        icon="players"
      />
      <LiveValue
        className="agc-premium-value--buy-in"
        value={data.buyIn}
        zone="buyIn"
        icon="buy-in"
      />
      <Actions actions={actions} />
    </div>
  );
}

function payoutParts(value?: string) {
  const normalized = value || 'Win Up To 100x';
  const match = normalized.match(/^(.*?)(\d+(?:\.\d+)?x)$/i);
  return match ? { lead: match[1].trim(), hero: match[2] } : { lead: '', hero: normalized };
}

function prizeParts(value?: string) {
  if (!value) return { label: '', value: '' };
  const stripped = value.replace(/^top prize\s*/i, '');
  return { label: stripped === value ? '' : 'Top Prize', value: stripped };
}

function SpinMachine({ data, actions }: ArenaGameCardProps) {
  const payout = payoutParts(data.maxPayout);
  const prize = prizeParts(data.topPrize);
  return (
    <div className="agc-machine agc-machine--spin">
      <PremiumHeader data={data} />
      <div className="agc-premium-promotion" data-zone="promotion">
        {data.featured ? '100x Live' : 'Prize Ladder Live'}
      </div>
      <div className="agc-premium-payout" data-zone="maxPayout">
        {payout.lead && <span>{payout.lead}</span>}
        <strong>{payout.hero}</strong>
        {prize.value && (
          <b>
            {prize.label && <small>{prize.label}</small>}
            {prize.value}
          </b>
        )}
      </div>
      <Rules
        data={data}
        className="agc-premium-rules agc-premium-rules--spins"
        limit={2}
        omit={['turbo', 'gtd']}
      />
      <LiveValue className="agc-premium-value--game-type" value={data.gameType} zone="gameType" />
      <LiveValue className="agc-premium-value--buy-in" value={data.buyIn} zone="buyIn" />
      <LiveValue
        className="agc-premium-value--registered"
        value={data.registered}
        zone="registered"
      />
      <LiveValue
        className="agc-premium-value--starting-stack"
        value={data.startingStack}
        zone="startingStack"
      />
      <LiveValue
        className="agc-premium-value--blind-levels"
        value={data.blindLevels}
        zone="blindLevels"
      />
      <LiveValue className="agc-premium-value--format" value={data.format} zone="format" />
      <Actions actions={actions} />
    </div>
  );
}

function HeadsUpMachine({ data, actions }: ArenaGameCardProps) {
  return (
    <div className="agc-machine agc-machine--heads-up">
      <PremiumHeader data={data} />
      <Rules
        data={data}
        className="agc-premium-rules agc-premium-rules--heads-up"
        limit={2}
        omit={['deepstack']}
      />
      <LiveValue className="agc-premium-value--game-type" value={data.gameType} zone="gameType" />
      <LiveValue className="agc-premium-value--buy-in" value={data.buyIn} zone="buyIn" />
      <LiveValue
        className="agc-premium-value--registered"
        value={data.registered}
        zone="registered"
      />
      <LiveValue
        className="agc-premium-value--starting-stack"
        value={data.startingStack}
        zone="startingStack"
      />
      <LiveValue
        className="agc-premium-value--blind-levels"
        value={data.blindLevels}
        zone="blindLevels"
      />
      <LiveValue
        className="agc-premium-value--format"
        value={data.format || 'Standard'}
        zone="format"
      />
      <Actions actions={actions} />
    </div>
  );
}

const familyRenderers: Record<
  ArenaGameCardData['family'],
  (props: ArenaGameCardProps) => ReactNode
> = {
  mtt: MttMachine,
  nlh: NlhMachine,
  plo: PloMachine,
  spins: SpinMachine,
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
  skin,
  clubSkin,
  selected,
  className,
}: ArenaGameCardProps) {
  const resolved = resolveArenaGameCardTemplate({
    family: data.family,
    skin,
    clubSkin,
    presentation: presentation === 'auto' ? undefined : presentation,
    status: data.status,
  });
  const template = resolved.skin;
  const Renderer = familyRenderers[data.family];
  const usesLayeredNlh =
    data.family === 'nlh' &&
    resolved.skinId === 'spade-nlh-premium-v1' &&
    resolved.presentation === 'mobile';
  const dataState = data.dataState || 'loaded';
  const notice = stateLabel(dataState);
  const style = {
    '--agc-art-desktop': `url("${template.desktop.asset}")`,
    '--agc-art-mobile': `url("${template.mobile.asset}")`,
    '--agc-desktop-ratio': template.desktop.aspectRatio,
    '--agc-mobile-ratio': template.mobile.aspectRatio,
  } as CSSProperties;
  const summary = `${data.title}, ${data.gameType}${data.stakes ? ` ${data.stakes}` : ''}, ${data.players || data.registered || 'player count unavailable'}, ${data.statusLabel}`;

  return (
    <article
      className={`arena-game-card arena-game-card--${data.family} arena-game-card--skin-${resolved.skinId} arena-game-card--layout-${resolved.template.layout}${selected ? ' is-selected' : ''}${className ? ` ${className}` : ''}`}
      data-presentation={presentation}
      data-template-presentation={resolved.presentation}
      data-skin={resolved.skinId}
      data-state={dataState}
      style={style}
      aria-label={summary}
      aria-busy={dataState === 'loading' || dataState === 'updating'}
    >
      <span className="arena-game-card__art" aria-hidden="true" />
      <div className="arena-game-card__glass">
        {usesLayeredNlh ? (
          <NlhPremiumCard data={data} actions={actions} />
        ) : (
          <Renderer data={data} actions={actions} presentation={presentation} />
        )}
      </div>
      {notice && <div className="arena-game-card__notice">{notice}</div>}
    </article>
  );
});

export default ArenaGameCard;
