/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Clubs Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Browse, join, and manage clubs
 * 
 * NO HARDCODED DATA - All data comes from Supabase
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { ClubsService } from '../services/ClubsService';
import { LoadingState, NoClubsEmpty } from '../components/common/EmptyState';
import styles from './ClubsPage.module.css';

type Tab = 'discover' | 'my-clubs' | 'create';

interface Club {
    id: string;
    club_id: number;
    name: string;
    member_count: number;
    is_owner?: boolean;
    online_count?: number;
    table_count?: number;
}

interface Membership {
    id: string;
    club_id: string;
    role: string;
    club: Club;
}

export default function ClubsPage() {
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState<Tab>('my-clubs');
    const [joinClubId, setJoinClubId] = useState('');
    const [isJoining, setIsJoining] = useState(false);
    const [joinError, setJoinError] = useState<string | null>(null);

    // Real data states
    const [myClubs, setMyClubs] = useState<Membership[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    // Create club form
    const [clubName, setClubName] = useState('');
    const [clubDescription, setClubDescription] = useState('');
    const [isPublic, setIsPublic] = useState(true);
    const [requiresApproval, setRequiresApproval] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    // Load user's clubs
    useEffect(() => {
        async function loadMyClubs() {
            setIsLoading(true);
            try {
                const memberships = await ClubsService.getUserMemberships();
                setMyClubs(memberships);
            } catch (err) {
                console.error('🔴 [CLUBS] Failed to load memberships:', err);
                setMyClubs([]);
            } finally {
                setIsLoading(false);
            }
        }
        loadMyClubs();
    }, []);

    // Join club by ID
    const handleJoinClub = async () => {
        if (joinClubId.length < 6) return;

        setIsJoining(true);
        setJoinError(null);

        try {
            // Find club by club_id (the 6-digit public ID)
            const { data: club, error } = await supabase
                .from('clubs')
                .select('id')
                .eq('club_id', parseInt(joinClubId))
                .single();

            if (error || !club) {
                setJoinError('Club not found. Check the ID and try again.');
                return;
            }

            await ClubsService.join(club.id);

            // Refresh memberships
            const memberships = await ClubsService.getUserMemberships();
            setMyClubs(memberships);
            setJoinClubId('');
            setActiveTab('my-clubs');
        } catch (err: any) {
            console.error('🔴 [CLUBS] Join failed:', err);
            setJoinError(err.message || 'Failed to join club');
        } finally {
            setIsJoining(false);
        }
    };

    // Create new club
    const handleCreateClub = async () => {
        if (!clubName.trim()) {
            setCreateError('Club name is required');
            return;
        }

        setIsCreating(true);
        setCreateError(null);

        try {
            const club = await ClubsService.create({
                name: clubName.trim(),
                description: clubDescription.trim() || undefined,
                is_public: isPublic,
            });

            // Navigate to the new club
            navigate(`/clubs/${club.id}`);
        } catch (err: any) {
            console.error('🔴 [CLUBS] Create failed:', err);
            setCreateError(err.message || 'Failed to create club');
        } finally {
            setIsCreating(false);
        }
    };

    return (
        <div className={styles.page}>
            {/* Header */}
            <header className={styles.header}>
                <h1 className={styles.title}>🏛️ Clubs</h1>
                <p className={styles.subtitle}>Join private poker communities or create your own.</p>
            </header>

            {/* Tabs */}
            <div className={styles.tabs}>
                <button
                    className={`${styles.tab} ${activeTab === 'discover' ? styles.active : ''}`}
                    onClick={() => setActiveTab('discover')}
                >
                    🔍 Discover
                </button>
                <button
                    className={`${styles.tab} ${activeTab === 'my-clubs' ? styles.active : ''}`}
                    onClick={() => setActiveTab('my-clubs')}
                >
                    🏛️ My Clubs
                </button>
                <button
                    className={`${styles.tab} ${activeTab === 'create' ? styles.active : ''}`}
                    onClick={() => setActiveTab('create')}
                >
                    ➕ Create Club
                </button>
            </div>

            {/* Tab Content */}
            <div className={styles.content}>
                {/* Discover Tab */}
                {activeTab === 'discover' && (
                    <div className={styles.discoverTab}>
                        <div className={styles.joinSection}>
                            <h3>Join a Club</h3>
                            <p>Enter a 6-digit Club ID to join an existing club.</p>

                            {joinError && (
                                <div className={styles.errorMessage}>{joinError}</div>
                            )}

                            <div className={styles.joinForm}>
                                <input
                                    type="text"
                                    placeholder="Club ID (e.g., 123456)"
                                    value={joinClubId}
                                    onChange={(e) => {
                                        setJoinClubId(e.target.value.replace(/\D/g, ''));
                                        setJoinError(null);
                                    }}
                                    className={styles.joinInput}
                                    maxLength={6}
                                />
                                <button
                                    className="btn btn-primary"
                                    disabled={joinClubId.length < 6 || isJoining}
                                    onClick={handleJoinClub}
                                >
                                    {isJoining ? 'Joining...' : 'Join Club'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* My Clubs Tab */}
                {activeTab === 'my-clubs' && (
                    <div className={styles.myClubsTab}>
                        {isLoading ? (
                            <LoadingState message="Loading your clubs..." />
                        ) : myClubs.length > 0 ? (
                            <div className={styles.clubsGrid}>
                                {myClubs.map(membership => (
                                    <div key={membership.id} className={styles.clubCard}>
                                        <div className={styles.clubHeader}>
                                            <div className={styles.clubAvatar}>🏛️</div>
                                            <div className={styles.clubInfo}>
                                                <h3 className={styles.clubName}>{membership.club.name}</h3>
                                                <span className={styles.clubId}>ID: {membership.club.club_id}</span>
                                            </div>
                                            {membership.role === 'owner' && (
                                                <span className={styles.ownerBadge}>Owner</span>
                                            )}
                                        </div>
                                        <div className={styles.clubStats}>
                                            <div className={styles.clubStat}>
                                                <span className={styles.statValue}>{membership.club.member_count || 0}</span>
                                                <span className={styles.statLabel}>Members</span>
                                            </div>
                                            <div className={styles.clubStat}>
                                                <span className={styles.statValue}>{membership.club.online_count || 0}</span>
                                                <span className={styles.statLabel}>Online</span>
                                            </div>
                                            <div className={styles.clubStat}>
                                                <span className={styles.statValue}>{membership.club.table_count || 0}</span>
                                                <span className={styles.statLabel}>Tables</span>
                                            </div>
                                        </div>
                                        <button
                                            className="btn btn-primary"
                                            style={{ width: '100%' }}
                                            onClick={() => navigate(`/clubs/${membership.club.id}`)}
                                        >
                                            Enter Club
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <NoClubsEmpty onCreate={() => setActiveTab('create')} />
                        )}
                    </div>
                )}

                {/* Create Club Tab */}
                {activeTab === 'create' && (
                    <div className={styles.createTab}>
                        <div className={styles.createForm}>
                            <h3>Create Your Club</h3>
                            <p>Start your own private poker community.</p>

                            {createError && (
                                <div className={styles.errorMessage}>{createError}</div>
                            )}

                            <div className={styles.formGroup}>
                                <label className={styles.label}>Club Name *</label>
                                <input
                                    type="text"
                                    placeholder="Enter club name"
                                    className={styles.input}
                                    value={clubName}
                                    onChange={(e) => {
                                        setClubName(e.target.value);
                                        setCreateError(null);
                                    }}
                                />
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.label}>Description</label>
                                <textarea
                                    placeholder="Describe your club..."
                                    className={styles.textarea}
                                    rows={3}
                                    value={clubDescription}
                                    onChange={(e) => setClubDescription(e.target.value)}
                                />
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.label}>Settings</label>
                                <div className={styles.checkboxGroup}>
                                    <label className={styles.checkbox}>
                                        <input
                                            type="checkbox"
                                            checked={isPublic}
                                            onChange={(e) => setIsPublic(e.target.checked)}
                                        />
                                        <span>Public (anyone can find)</span>
                                    </label>
                                    <label className={styles.checkbox}>
                                        <input
                                            type="checkbox"
                                            checked={requiresApproval}
                                            onChange={(e) => setRequiresApproval(e.target.checked)}
                                        />
                                        <span>Require approval for new members</span>
                                    </label>
                                </div>
                            </div>

                            <button
                                className="btn btn-primary btn-lg"
                                style={{ width: '100%' }}
                                onClick={handleCreateClub}
                                disabled={isCreating || !clubName.trim()}
                            >
                                {isCreating ? 'Creating...' : 'Create Club'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
