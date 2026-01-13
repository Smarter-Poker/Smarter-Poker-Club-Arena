/**
 * ♠ CLUB ARENA — Union Detail Page
 * Detailed view of a poker union network
 */

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { unionService, type Union, type UnionClub } from '../services/UnionService';
import { tableService } from '../services/TableService';
import { clubService } from '../services/ClubService';
import { useUserStore } from '../stores/useUserStore';
import { isDemoMode } from '../lib/supabase';
import type { PokerTable, Club } from '../types/database.types';
import './UnionDetailPage.css';

export default function UnionDetailPage() {
    const { unionId } = useParams<{ unionId: string }>();
    const [union, setUnion] = useState<Union | null>(null);
    const [clubs, setClubs] = useState<UnionClub[]>([]);
    const [tables, setTables] = useState<PokerTable[]>([]);
    const [loading, setLoading] = useState(true);

    // Application State
    const { user } = useUserStore();
    const [ownedClubs, setOwnedClubs] = useState<Club[]>([]);
    const [showClubSelector, setShowClubSelector] = useState(false);
    const [applying, setApplying] = useState(false);

    useEffect(() => {
        if (!unionId) return;

        const loadData = async () => {
            setLoading(true);
            try {
                const unionData = await unionService.getUnionById(unionId);
                const clubsData = await unionService.getUnionClubs(unionId);
                const tablesData = await tableService.getUnionTables(unionId);
                setUnion(unionData);
                setClubs(clubsData);
                setTables(tablesData);
            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        };

        loadData();
    }, [unionId]);

    const handleApplyClick = async () => {
        if (!user) return;

        try {
            // Get user's clubs
            const myClubs = await clubService.getMyClubs(user.id);
            // Filter for owned clubs
            const owned = myClubs.filter(c => c.owner_id === user.id || isDemoMode);

            if (owned.length === 0) {
                alert("You must own a club to join a union.");
                return;
            }

            if (owned.length === 1) {
                if (window.confirm(`Apply to join ${union?.name} with your club "${owned[0].name}"?`)) {
                    await applyWithClub(owned[0].id);
                }
            } else {
                setOwnedClubs(owned);
                setShowClubSelector(true);
            }
        } catch (error) {
            console.error(error);
            alert("Failed to load your clubs.");
        }
    };

    const applyWithClub = async (clubId: string) => {
        if (!unionId) return;
        setApplying(true);
        try {
            const success = await unionService.joinUnion(unionId, clubId);
            if (success) {
                alert("Application sent successfully!");
                setShowClubSelector(false);
            }
        } catch (error) {
            console.error(error);
            alert("Failed to send application.");
        } finally {
            setApplying(false);
        }
    };

    if (loading) {
        return <div className="loader-container"><div className="loader-spinner" /></div>;
    }

    if (!union) {
        return (
            <div className="error-container">
                <h2>Union Not Found</h2>
                <Link to="/unions" className="btn btn-ghost">← Back to Unions</Link>
            </div>
        );
    }

    return (
        <div className="union-detail-page">
            <Link to="/unions" className="back-link" style={{ display: 'block', marginBottom: '1rem' }}>
                ← Back to Unions
            </Link>

            {/* Hero Section */}
            <header className="union-hero">
                <div className="union-logo-large">{union.logo_url}</div>
                <div className="union-hero-content">
                    <h1>{union.name}</h1>
                    <p>{union.description}</p>
                </div>
                <div className="union-actions">
                    <button
                        className="btn btn-primary btn-lg"
                        onClick={handleApplyClick}
                        disabled={applying}
                    >
                        {applying ? 'Applying...' : 'Apply to Join'}
                    </button>
                    <button className="btn btn-ghost btn-lg">Contact Admin</button>
                </div>
            </header>

            {/* Club Selector Modal */}
            {showClubSelector && (
                <div className="modal-overlay" style={{
                    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
                }} onClick={(e) => e.target === e.currentTarget && setShowClubSelector(false)}>
                    <div className="modal-content" style={{ maxWidth: '400px', padding: '2rem', background: 'var(--surface-card)', borderRadius: '1rem', width: '90%' }}>
                        <h2 style={{ marginTop: 0 }}>Select Club</h2>
                        <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>Which club would you like to apply with?</p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {ownedClubs.map(c => (
                                <button
                                    key={c.id}
                                    className="btn btn-secondary"
                                    style={{ justifyContent: 'flex-start', textAlign: 'left', padding: '1rem' }}
                                    onClick={() => applyWithClub(c.id)}
                                >
                                    <span style={{ fontWeight: 'bold' }}>{c.name}</span>
                                    <br />
                                    <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>ID: {c.club_id}</span>
                                </button>
                            ))}
                        </div>
                        <button
                            className="btn btn-ghost"
                            style={{ marginTop: '1rem', width: '100%' }}
                            onClick={() => setShowClubSelector(false)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Stats Row */}
            <div className="union-stats-row">
                <div className="stat-box">
                    <span className="value">{union.club_count}</span>
                    <span className="label">Member Clubs</span>
                </div>
                <div className="stat-box">
                    <span className="value">{union.member_count.toLocaleString()}</span>
                    <span className="label">Total Players</span>
                </div>
                <div className="stat-box">
                    <span className="value" style={{ color: 'var(--success)' }}>{union.online_count.toLocaleString()}</span>
                    <span className="label">Online Now</span>
                </div>
            </div>

            {/* Live Tables */}
            <section className="union-section">
                <div className="section-header">
                    <h2>Live Action</h2>
                    <span className="badge badge-success">{tables.length} Active Tables</span>
                </div>

                {tables.length === 0 ? (
                    <div className="empty-state">No active tables right now.</div>
                ) : (
                    <div className="tables-grid">
                        {tables.map(table => (
                            <div key={table.id} className="table-card">
                                <div className="table-header">
                                    <span className="table-name">{table.name}</span>
                                    <span className={`status-dot ${table.status}`} />
                                </div>
                                <div className="table-details">
                                    <div className="detail-row">
                                        <span className="label">Stakes</span>
                                        <span className="value">${table.small_blind}/${table.big_blind}</span>
                                    </div>
                                    <div className="detail-row">
                                        <span className="label">Game</span>
                                        <span className="value uppercase">{table.game_variant}</span>
                                    </div>
                                    <div className="detail-row">
                                        <span className="label">Players</span>
                                        <span className="value">{table.current_players}/{table.max_players}</span>
                                    </div>
                                </div>
                                <Link to={`/table/${table.id}`} className="btn btn-sm btn-primary play-btn">
                                    Join Table
                                </Link>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* Member Clubs */}
            <section className="union-section">
                <div className="section-header">
                    <h2>Member Clubs</h2>
                    <span className="badge badge-blue">{clubs.length} Visible</span>
                </div>

                <div className="clubs-grid">
                    {clubs.map(club => (
                        <div key={club.club_id} className="club-card">
                            <div className="club-avatar">🏛️</div>
                            <div className="club-info">
                                <h3>{club.club_name}</h3>
                                <div className="club-meta">
                                    <span>Owner: {club.club_owner}</span>
                                    <span>•</span>
                                    <span>{club.member_count} Members</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}
