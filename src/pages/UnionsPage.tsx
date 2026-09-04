/**
 * ♠ CLUB ARENA — Unions Page
 * Club networks for increased liquidity
 */

import './UnionsPage.css';
import { EmptyState, ErrorState, LoadingState } from '../components/common/EmptyState';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import CreateUnionModal from '../components/union/CreateUnionModal';
import { unionService, type Union } from '../services/UnionService';
import { getUnionLevel } from '../utils/clubLevels';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import { reportError } from '../utils/errorReporter';
import { mediaUrl } from '../utils/mediaBase';

const unionCardAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(12px)',
  animation: `animationsFadeInUp 0.6s ease-out ${index * 80}ms forwards`,
});

function UnionCard({ union, idx }: { union: Union; idx: number }) {
  const [memberDisplay, setMemberDisplay] = useState(0);
  const [onlineDisplay, setOnlineDisplay] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMemberDisplay(union.memberCount);
      setOnlineDisplay(union.onlineCount || 0);
      return;
    }

    const frames = new Set<number>();
    const animateNumber = (start: number, end: number, setter: (n: number) => void) => {
      const duration = 500;
      const startTime = performance.now();

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        setter(Math.floor(start + (end - start) * progress));

        if (progress < 1) {
          const frame = requestAnimationFrame(animate);
          frames.add(frame);
        }
      };

      const frame = requestAnimationFrame(animate);
      frames.add(frame);
    };

    animateNumber(0, union.memberCount, setMemberDisplay);
    animateNumber(0, union.onlineCount || 0, setOnlineDisplay);
    return () => frames.forEach(cancelAnimationFrame);
  }, [union.memberCount, union.onlineCount]);

  const uLevel = getUnionLevel({
    level: union.level,
    playerLevel: union.playerLevel,
    hierarchyLevel: union.hierarchyLevel,
    totalPlayers: union.totalPlayers || union.memberCount,
    hierarchyUnitsRoundedUp: union.hierarchyUnitsRoundedUp,
    playerThresholdCurrent: union.playerThresholdCurrent,
    playerThresholdNext: union.playerThresholdNext,
    hierarchyThresholdCurrent: union.hierarchyThresholdCurrent,
    hierarchyThresholdNext: union.hierarchyThresholdNext,
  });

  return (
    <article className="union-card-shell" style={unionCardAnimationStyle(idx)}>
      <Link
        to={`/unions/${union.slug || union.id}`}
        className="union-card"
        aria-label={`Open ${union.name} Union`}
      >
        <div className="union-header">
          <span className="union-icon" aria-hidden="true">
            {union.avatarUrl ? (
              <img src={union.avatarUrl} alt="" loading="lazy" />
            ) : (
              union.name.charAt(0).toUpperCase()
            )}
          </span>
          <div>
            <span className="union-kicker">Union Network</span>
            <h2>{union.name}</h2>
          </div>
        </div>
        <p className="union-description">
          {union.description || 'A Connected Club Network With Shared Games And Events.'}
        </p>
        <div className="union-stats" aria-label={`${union.name} Network Statistics`}>
          <div className="union-stat">
            <span className="stat-value">{union.clubCount.toLocaleString()}</span>
            <span className="stat-label">Clubs</span>
          </div>
          <div className="union-stat">
            <span className="stat-value union-level" style={{ color: uLevel.color }}>
              Lv.{uLevel.level}
            </span>
            <span className="stat-label" style={{ color: uLevel.color }}>
              {uLevel.tierLabel}
            </span>
          </div>
          <div className="union-stat">
            <span className="stat-value">{memberDisplay.toLocaleString()}</span>
            <span className="stat-label">Members</span>
          </div>
          <div className="union-stat">
            <span className="stat-value online">{onlineDisplay.toLocaleString()}</span>
            <span className="stat-label">Online</span>
          </div>
        </div>
        <div
          className="union-progress"
          role="progressbar"
          aria-label={`${union.name} Level Progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={uLevel.progressPercent}
        >
          <span style={{ width: `${uLevel.progressPercent}%`, background: uLevel.gradient }} />
        </div>
        <div className="union-progress-copy">
          <span>{uLevel.progressPercent}% Complete</span>
          <span>Next: Lv.{Math.min(uLevel.level + 1, 50)}</span>
        </div>
        <span className="union-card-action">
          Open Union <span aria-hidden="true">›</span>
        </span>
      </Link>
    </article>
  );
}

export default function UnionsPage() {
  useEffect(() => {
    document.title = 'Unions | Smarter Poker';
  }, []);

  const toast = useToast();
  const [unions, setUnions] = useState<Union[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const loadUnions = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    unionService
      .getUnions()
      .then((data) => {
        setUnions(data);
        setLoading(false);
      })
      .catch((err: any) => {
        reportError(err, 'UnionsPage.Failed_to_load_unions');
        toast.error(err.message || 'Failed to load unions');
        setLoadError('Club Arena could not load union networks right now.');
        setLoading(false);
      });
  }, [toast]);

  useVisibilityRefresh(loadUnions);

  useEffect(() => {
    loadUnions();

    // Refresh when club membership or union data changes (debounced)
    const unsubJoined = masterBus.subscribeDebounced('CLUB_JOINED', () => loadUnions(), 500);
    const unsubLeft = masterBus.subscribeDebounced('CLUB_LEFT', () => loadUnions(), 500);
    const unsubUnion = masterBus.subscribeDebounced('UNION_UPDATED', () => loadUnions(), 500);
    return () => {
      unsubJoined();
      unsubLeft();
      unsubUnion();
    };
  }, [loadUnions]);

  return (
    <div
      className="unions-page"
      style={
        {
          '--union-network-art': `url("${mediaUrl('assets/club-buttons/wallets/desktop/wallet-union-bank-v1.webp')}")`,
        } as CSSProperties
      }
    >
      <header className="unions-header">
        <div>
          <span className="unions-eyebrow">Connected Club Networks</span>
          <h1>Union Command</h1>
          <p>Coordinate Clubs, Shared Games And Network-Level Events.</p>
        </div>
        <button type="button" className="union-create-button" onClick={() => setIsCreating(true)}>
          Create Union
        </button>
      </header>

      <div className="unions-grid">
        {loading ? (
          <div className="unions-state">
            <LoadingState message="Opening Union Networks" />
          </div>
        ) : loadError ? (
          <div className="unions-state">
            <ErrorState message={loadError} onRetry={loadUnions} />
          </div>
        ) : unions.length === 0 ? (
          <div className="unions-state">
            <EmptyState
              icon="UNION"
              eyebrow="No Networks Yet"
              title="Build The First Union"
              description="Connect Clubs Under One Network To Coordinate Games, Liquidity And Events."
              action={{ label: 'Create Union', onClick: () => setIsCreating(true) }}
            />
          </div>
        ) : (
          unions.map((union, idx) => <UnionCard key={union.id} union={union} idx={idx} />)
        )}
      </div>

      <section className="create-union-cta">
        <h2>Create Your Own Union</h2>
        <p>
          Bring Together Multiple Clubs Under One Network For Shared Player Pools And Coordinated
          Events.
        </p>
        <button
          type="button"
          className="union-secondary-button"
          onClick={() => setIsCreating(true)}
        >
          Start A Union
        </button>
      </section>

      {isCreating && (
        <CreateUnionModal
          onClose={() => setIsCreating(false)}
          onSuccess={() => {
            setIsCreating(false);
            loadUnions();
          }}
        />
      )}
    </div>
  );
}
