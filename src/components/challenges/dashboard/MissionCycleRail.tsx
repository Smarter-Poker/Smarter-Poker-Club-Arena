import { CasinoControlIcon } from '../CasinoControlIcon';
import type { Tier } from '../../../services/DailyChallengeService';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { TIER_COLORS, TIER_CONTROL_ICONS, TIER_LABELS, TIERS } from './missionPresentation';

export function MissionCycleRail({
  activeTier,
  tierCounts,
  onOpenTier,
  onTierKeyDown,
}: {
  activeTier: Tier;
  tierCounts: Record<Tier, { total: number; done: number }>;
  onOpenTier: (tier: Tier) => void;
  onTierKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, tier: Tier) => void;
}) {
  return (
    <div className={styles.tabs} role="tablist" aria-label="Challenge Period">
      <span className={styles.bevelFrame} aria-hidden="true" />
      {TIERS.map((tier) => (
        <button
          key={tier}
          id={`mission-tab-${tier}`}
          type="button"
          role="tab"
          aria-selected={activeTier === tier}
          aria-controls="mission-panel"
          tabIndex={activeTier === tier ? 0 : -1}
          className={`${styles.tab} ${activeTier === tier ? styles.tabActive : ''}`}
          style={{ '--tier-color': TIER_COLORS[tier] } as React.CSSProperties}
          onKeyDown={(event) => onTierKeyDown(event, tier)}
          onClick={() => {
            onOpenTier(tier);
          }}
        >
          <CasinoControlIcon
            variant={TIER_CONTROL_ICONS[tier]}
            state={activeTier === tier ? 'active' : 'idle'}
            size="sm"
          />
          <span className={styles.tabLabel}>{TIER_LABELS[tier]}</span>
          <span className={styles.tabCount}>
            {tierCounts[tier].done}/{tierCounts[tier].total} Complete
          </span>
        </button>
      ))}
    </div>
  );
}
