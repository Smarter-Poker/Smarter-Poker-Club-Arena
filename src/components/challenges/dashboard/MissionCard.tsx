import { useEffect, useRef, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CasinoControlIcon } from '../CasinoControlIcon';
import { MissionInstrumentGlyph } from '../MissionInstrumentGlyph';
import {
  DAILY_MISSION_REROLL_COST,
  type TieredUserChallenge,
  type Tier,
  type ChallengeType,
} from '../../../services/DailyChallengeService';
import { mediaUrl } from '../../../utils/mediaBase';
import { getChallengeMissionAction } from '../../../utils/challengeMissionAction';
import { prefetchIntent } from '../../../utils/ChunkPreloader';
import styles from '../../../pages/DailyChallengesPage.module.css';

type TieredChallenge = TieredUserChallenge;

// Integration seam: the presentation tables and artwork helpers still live on the
// page while the sibling extraction moves them to `missionPresentation.ts`,
// `MissionArtwork.tsx` and `MissionClockLeaves.tsx`. Until that lands they are
// handed in as props under their own names so this body stays verbatim.

export function ChallengeCard({
  challenge,
  tier,
  claiming,
  rerolling,
  economyBusy,
  canAffordReroll,
  confirmingReroll,
  rerollConfirmationOpen,
  celebrating,
  onClaim,
  onRequestReroll,
  onCancelReroll,
  onConfirmReroll,
  onOpenMission,
  diamondMark,
  TIER_COLORS,
  TIER_LABELS,
  MISSION_DIAMOND_ARTWORK,
}: {
  challenge: TieredChallenge;
  tier: Tier;
  claiming: boolean;
  rerolling: boolean;
  economyBusy: boolean;
  canAffordReroll: boolean;
  confirmingReroll: boolean;
  rerollConfirmationOpen: boolean;
  celebrating: boolean;
  onClaim: (c: TieredChallenge) => void;
  onRequestReroll: (c: TieredChallenge) => void;
  onCancelReroll: () => void;
  onConfirmReroll: (c: TieredChallenge) => void;
  onOpenMission: (type: ChallengeType) => void;
  /** `<DiamondMark />`, rendered by the page. */
  diamondMark: ReactNode;
  TIER_COLORS: Record<Tier, string>;
  TIER_LABELS: Record<Tier, string>;
  MISSION_DIAMOND_ARTWORK: string;
}) {
  const reduceMotion = useReducedMotion();
  const rerollButtonRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRerollRef = useRef(confirmingReroll);
  const rerollFocusRestorePendingRef = useRef(false);
  const c = challenge.challenge;
  const pct = c.requirement > 0 ? Math.min((challenge.progress / c.requirement) * 100, 100) : 0;
  const done = challenge.completed;
  const claimed = challenge.claimed;
  const remaining = Math.max(0, c.requirement - challenge.progress);
  const missionAction = getChallengeMissionAction(c.type);

  useEffect(() => {
    if (wasConfirmingRerollRef.current && !confirmingReroll) {
      // A different card can become the active confirmation in the same
      // render. In that case its auto-focused cancel action owns focus; the
      // card that just closed must not queue a restoration over it.
      rerollFocusRestorePendingRef.current = !rerollConfirmationOpen;
    }
    if (
      rerollFocusRestorePendingRef.current &&
      !confirmingReroll &&
      !rerollConfirmationOpen &&
      !economyBusy
    ) {
      rerollFocusRestorePendingRef.current = false;
      const frame = requestAnimationFrame(() => {
        const rerollButton = rerollButtonRef.current;
        if (rerollButton && !rerollButton.disabled) {
          rerollButton.focus();
          return;
        }
        document.getElementById(`mission-card-${challenge.id}`)?.focus();
      });
      wasConfirmingRerollRef.current = confirmingReroll;
      return () => cancelAnimationFrame(frame);
    }
    wasConfirmingRerollRef.current = confirmingReroll;
    return undefined;
  }, [challenge.id, confirmingReroll, economyBusy, rerollConfirmationOpen]);

  const handleClaim = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (done && !claimed && !claiming) onClaim(challenge);
  };

  return (
    <article
      id={`mission-card-${challenge.id}`}
      tabIndex={-1}
      data-mission-tier={tier}
      data-mission-state={claimed ? 'claimed' : done ? 'complete' : 'active'}
      aria-busy={claiming || rerolling}
      className={`
        ${styles.challengeCard}
        ${done ? styles.cardCompleted : ''}
        ${claimed ? styles.cardClaimed : ''}
        ${celebrating ? styles.cardCelebrating : ''}
      `}
      style={
        {
          '--card-tier-color': TIER_COLORS[tier],
          '--mission-progress': `${pct}%`,
        } as React.CSSProperties
      }
    >
      <span className={styles.bevelFrame} aria-hidden="true" />
      <div className={styles.cardTopline} data-mission-topline="">
        <span>{TIER_LABELS[tier]} Challenge</span>
        <span className={styles.cardState}>
          {claimed ? 'Reward Collected' : done ? 'Ready To Claim' : 'In Progress'}
        </span>
      </div>

      <div className={styles.cardHeader}>
        <div
          className={styles.iconAssembly}
          data-mission-icon={c.type}
          data-icon-state={claimed ? 'claimed' : done ? 'complete' : 'active'}
          aria-hidden="true"
        >
          <span className={styles.iconOrbit} />
          <span className={styles.iconBox}>
            <MissionInstrumentGlyph
              type={c.type}
              state={claimed ? 'claimed' : done ? 'complete' : 'active'}
              progress={pct}
              size="lg"
            />
          </span>
          <span className={styles.iconPulse} />
          <span className={styles.iconScanner} />
        </div>
        <div className={styles.cardTitles}>
          <h3 className={styles.cardName}>{c.name}</h3>
          <p className={styles.cardDesc}>{c.description}</p>
        </div>
        <div className={styles.rewardReadout} role="group" aria-label="Challenge Reward">
          <img
            className={styles.rewardGem}
            src={mediaUrl(MISSION_DIAMOND_ARTWORK)}
            alt=""
            width="96"
            height="96"
            loading="lazy"
            decoding="async"
            aria-hidden="true"
          />
          <div>
            <span className={styles.rewardLabel}>Reward</span>
            {/* 2026-09-05: this led with "{chipReward} Chips" and put the diamonds
              second. A mission reward is diamonds (Dan: nothing ever earns
              chips, only diamonds), and as of migration 20260905114421 no code
              path credits a chip for one. */}
            <strong className={styles.diamondReward}>
              {c.diamondReward.toLocaleString()} Diamonds
            </strong>
          </div>
        </div>
      </div>

      <div className={styles.progressBlock}>
        <div className={styles.progressLabels}>
          <span>Challenge Progress</span>
          <strong>
            {Math.min(challenge.progress, c.requirement).toLocaleString()} /{' '}
            {c.requirement.toLocaleString()}
          </strong>
        </div>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label={`${c.name} Progress`}
          aria-valuemin={0}
          aria-valuemax={c.requirement}
          aria-valuenow={Math.min(challenge.progress, c.requirement)}
          aria-valuetext={`${Math.min(challenge.progress, c.requirement).toLocaleString()} Of ${c.requirement.toLocaleString()} Complete`}
        >
          <motion.div
            className={styles.progressFill}
            initial={reduceMotion ? false : { width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: reduceMotion ? 0 : 0.8, ease: 'easeOut' }}
          />
        </div>
      </div>

      <div className={styles.cardFooter}>
        <span className={styles.completionReadout}>
          {claimed
            ? 'Reward Collected'
            : done
              ? 'Objective Cleared'
              : `${remaining.toLocaleString()} Remaining`}
        </span>
        <div className={styles.cardActions}>
          {claimed && (
            <div className={styles.claimedBadge}>
              <CasinoControlIcon variant="claim" state="success" size="sm" />
              Already Claimed
            </div>
          )}
          {done && !claimed && (
            <button
              type="button"
              className={styles.claimButton}
              onClick={handleClaim}
              disabled={claiming || economyBusy}
              aria-label={`Claim Reward For ${c.name}`}
            >
              <CasinoControlIcon
                variant="claim"
                state={claiming ? 'pending' : economyBusy ? 'disabled' : 'active'}
                size="sm"
              />
              {claiming ? 'Claiming...' : 'Claim Reward'}
            </button>
          )}
          {!done && !confirmingReroll && (
            <>
              <button
                {...prefetchIntent(missionAction.path)}
                type="button"
                className={styles.missionActionButton}
                onClick={() => onOpenMission(c.type)}
                aria-label={`${missionAction.label} To Advance ${c.name}`}
              >
                <CasinoControlIcon variant="play" state="active" size="sm" />
                {missionAction.label}
              </button>
              <button
                ref={rerollButtonRef}
                type="button"
                className={styles.rerollButton}
                onClick={() => onRequestReroll(challenge)}
                disabled={rerolling || economyBusy || rerollConfirmationOpen || !canAffordReroll}
                aria-label={
                  canAffordReroll
                    ? `Reroll ${DAILY_MISSION_REROLL_COST} Diamond For ${c.name}`
                    : `Need ${DAILY_MISSION_REROLL_COST} Diamond To Reroll ${c.name}`
                }
              >
                <CasinoControlIcon
                  variant="reroll"
                  state={
                    rerolling
                      ? 'pending'
                      : economyBusy || rerollConfirmationOpen || !canAffordReroll
                        ? 'disabled'
                        : 'idle'
                  }
                  size="sm"
                />
                {canAffordReroll ? 'Reroll ' : 'Need '}
                <span className={styles.buttonPrice}>
                  {diamondMark} {DAILY_MISSION_REROLL_COST}
                  {!canAffordReroll && ' Diamond'}
                </span>
              </button>
            </>
          )}
          {!done && confirmingReroll && (
            <div
              className={styles.rerollConfirm}
              role="group"
              aria-label={`Confirm Reroll For ${c.name}`}
              aria-live="polite"
              onKeyDown={(event) => {
                if (event.key === 'Escape') onCancelReroll();
              }}
            >
              <span className={styles.rerollPrompt}>
                Spend {diamondMark} {DAILY_MISSION_REROLL_COST} Diamond? Current Progress Will Be
                Replaced.
              </span>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={onCancelReroll}
                disabled={rerolling || economyBusy}
                autoFocus
              >
                <CasinoControlIcon
                  variant="keep"
                  state={rerolling || economyBusy ? 'disabled' : 'idle'}
                  size="sm"
                />
                Keep It
              </button>
              <button
                type="button"
                className={styles.confirmButton}
                onClick={() => onConfirmReroll(challenge)}
                disabled={rerolling || economyBusy || !canAffordReroll}
              >
                <CasinoControlIcon
                  variant="confirm"
                  state={
                    rerolling
                      ? 'pending'
                      : economyBusy || !canAffordReroll
                        ? 'disabled'
                        : 'attention'
                  }
                  size="sm"
                />
                {rerolling
                  ? 'Replacing...'
                  : canAffordReroll
                    ? 'Replace'
                    : `Need ${DAILY_MISSION_REROLL_COST} Diamond`}
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
