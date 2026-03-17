/**
 * ♠ CLUB ARENA — Unions Page
 * Club networks for increased liquidity
 */

import './UnionsPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import CreateUnionModal from '../components/union/CreateUnionModal';
import { unionService, type Union } from '../services/UnionService';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';

const unionCardAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(12px)',
  animation: `fadeInUp 0.6s ease-out ${index * 80}ms forwards`,
});

function UnionCard({ union, idx }: { union: Union; idx: number }) {
  const [memberDisplay, setMemberDisplay] = useState(0);
  const [onlineDisplay, setOnlineDisplay] = useState(0);

  useEffect(() => {
    const animateNumber = (start: number, end: number, setter: (n: number) => void) => {
      const duration = 500;
      const startTime = performance.now();

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        setter(Math.floor(start + (end - start) * progress));

        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };

      requestAnimationFrame(animate);
    };

    animateNumber(0, union.memberCount, setMemberDisplay);
    animateNumber(0, union.onlineCount || 0, setOnlineDisplay);
  }, [union.memberCount, union.onlineCount]);

  const navigate = useNavigate();

  return (
    <div
      key={union.id}
      className="union-card"
      onClick={() => navigate(`/unions/${union.id}`)}
      style={{ ...unionCardAnimationStyle(idx), cursor: 'pointer' }}
    >
      <div className="union-header">
        <span className="union-icon">{union.avatarUrl || ''}</span>
        <h3>{union.name}</h3>
      </div>
      <p className="union-description">{union.description}</p>
      <div className="union-stats">
        <div className="union-stat">
          <span className="stat-value">{union.clubCount}</span>
          <span className="stat-label">Clubs</span>
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
      <Link
        to={`/unions/${union.id}`}
        className="btn btn-primary"
        style={{ width: '100%', textAlign: 'center' }}
      >
        View Union
      </Link>
    </div>
  );
}

export default function UnionsPage() {
  useEffect(() => {
    document.title = 'Unions | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const toast = useToast();
  const [unions, setUnions] = useState<Union[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  useVisibilityRefresh(() => loadUnions());

  const loadUnions = () => {
    setLoading(true);
    unionService
      .getUnions()
      .then((data) => {
        setUnions(data);
        setLoading(false);
      })
      .catch((err: any) => {
        console.error('[UnionsPage] Failed to load unions:', err);
        toast.error(err.message || 'Failed to load unions');
        setLoading(false);
      });
  };

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
  }, []);

  if (loading) {
    return (
      <div className="unions-page">
        <PageSkeleton variant="default" />
      </div>
    );
  }

  return (
    <div className="unions-page">
      <header className="unions-header">
        <div>
          <p>Join club networks for more players and bigger games.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setIsCreating(true)}>
          + New Union
        </button>
      </header>

      <div className="unions-grid">
        {unions.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '48px 16px' }}>
            <span style={{ fontSize: '2rem', display: 'block', marginBottom: '12px' }}>🤝</span>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem' }}>
              No unions found. Create one to link your clubs!
            </p>
          </div>
        ) : (
          unions.map((union, idx) => <UnionCard key={union.id} union={union} idx={idx} />)
        )}
      </div>

      <section className="create-union-cta">
        <h2>Create Your Own Union</h2>
        <p>
          Bring together multiple clubs under one network for shared player pools and coordinated
          events.
        </p>
        <button className="btn btn-ghost btn-lg" onClick={() => setIsCreating(true)}>
          Start a Union
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
