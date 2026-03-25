/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CREATE TABLE PAGE — Game Type Selector
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros-style game type selection with 7 game options:
 * - NLH (No Limit Hold'em)
 * - FLH (Fixed Limit Hold'em)
 * - 6+ (Short Deck Hold'em)
 * - OMAHA (Pot Limit Omaha)
 * - FLO (Fixed Limit Omaha)
 * - MIXED GAME (Hold'em/Omaha)
 * - OFC (Open Face Chinese Poker)
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { resolveClubUUID } from '../utils/clubIdResolver';
import './CreateTablePage.css';

const gameTypeCardAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(10px)',
  animation: `fadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

interface GameType {
  id: string;
  name: string;
  subtitle: string;
  gradient: string;
  icon: string;
  unlockLevel: number;
}

const GAME_TYPES: GameType[] = [
  {
    id: 'nlh',
    name: 'NLH',
    subtitle: "NO LIMIT HOLD'EM",
    gradient: 'linear-gradient(135deg, #1877F2 0%, #166FE5 50%, #0d5bbd 100%)',
    icon: '♠',
    unlockLevel: 1,
  },
  {
    id: 'flh',
    name: 'FLH',
    subtitle: "FIXED LIMIT HOLD'EM",
    gradient: 'linear-gradient(135deg, #1a73e8 0%, #1557b0 50%, #0d3d7a 100%)',
    icon: '♣',
    unlockLevel: 1,
  },
  {
    id: 'shortdeck',
    name: '6+',
    subtitle: "6+ HOLD'EM",
    gradient: 'linear-gradient(135deg, #0866FF 0%, #0557d6 50%, #0449b0 100%)',
    icon: '♦',
    unlockLevel: 1,
  },
  {
    id: 'plo',
    name: 'OMAHA',
    subtitle: 'POT LIMIT OMAHA',
    gradient: 'linear-gradient(135deg, #2374E1 0%, #1963c6 50%, #1252a8 100%)',
    icon: '♥',
    unlockLevel: 1,
  },
  {
    id: 'flo',
    name: 'FLO',
    subtitle: 'FIXED LIMIT OMAHA',
    gradient: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 50%, #1d4ed8 100%)',
    icon: '♠',
    unlockLevel: 1,
  },
  {
    id: 'mixed',
    name: 'MIXED GAME',
    subtitle: "HOLD'EM/OMAHA",
    gradient: 'linear-gradient(135deg, #4299e1 0%, #3182ce 50%, #2b6cb0 100%)',
    icon: '♣',
    unlockLevel: 1,
  },
  {
    id: 'ofc',
    name: 'OFC',
    subtitle: 'OPEN FACE CHINESE POKER',
    gradient: 'linear-gradient(135deg, #5a9cf6 0%, #4285f4 50%, #3674d9 100%)',
    icon: '♦',
    unlockLevel: 1,
  },
];

export default function CreateTablePage() {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const userLevel = 1; // All game types unlocked at level 1

  // Union guard: redirect back if club is in a union
  useEffect(() => {
    if (!clubId) return;
    (async () => {
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (data) navigate(`/clubs/${clubId}`, { replace: true });
      } catch {
        /* fail-open */
      }
    })();
  }, [clubId, navigate]);

  const handleSelectGameType = (gameType: GameType) => {
    if (userLevel < gameType.unlockLevel) {
      // Show unlock message
      return;
    }
    // Navigate to table configuration with selected game type
    navigate(`/clubs/${clubId}/create-table/${gameType.id}`);
  };

  const handleBack = () => {
    navigate(`/clubs/${clubId}`);
  };

  return (
    <div className="create-table-page">
      {/* Back Button */}
      <button className="create-table-page__back" onClick={handleBack}>
        ‹‹
      </button>

      {/* Game Type List */}
      <div className="create-table-page__list">
        {GAME_TYPES.map((gameType, index) => (
          <button
            key={gameType.id}
            className={`game-type-card ${userLevel < gameType.unlockLevel ? 'locked' : ''}`}
            style={{
              background: gameType.gradient,
              ...gameTypeCardAnimationStyle(index),
            }}
            onClick={() => handleSelectGameType(gameType)}
            disabled={userLevel < gameType.unlockLevel}
          >
            <div className="game-type-card__create-badge">CREATE»</div>
            <div className="game-type-card__content">
              <h2 className="game-type-card__name">{gameType.name}</h2>
              <p className="game-type-card__subtitle">{gameType.subtitle}</p>
            </div>
            <div className="game-type-card__icon">
              {/* Decorative icon area - would use actual game graphics */}
            </div>
          </button>
        ))}
      </div>

      {/* Table Template Button */}
      <div className="create-table-page__footer">
        <button className="template-button">
          <span>Table Template</span>
          <span className="template-icon">⚙</span>
        </button>
        <p className="unlock-hint">Unlock at level 1</p>
      </div>

      {/* Background */}
      <div className="create-table-page__background"></div>
    </div>
  );
}
