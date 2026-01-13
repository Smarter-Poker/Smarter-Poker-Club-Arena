/**
 * ♠ CLUB ARENA — Unions Page
 * Club networks for increased liquidity
 */

import './UnionsPage.css';

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import CreateUnionModal from '../components/union/CreateUnionModal';
import { unionService, type Union } from '../services/UnionService';

export default function UnionsPage() {
    const [unions, setUnions] = useState<Union[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);

    const loadUnions = () => {
        setLoading(true);
        unionService.getUnions().then(data => {
            setUnions(data);
            setLoading(false);
        });
    };

    useEffect(() => {
        loadUnions();
    }, []);

    if (loading) {
        return <div className="loader-container"><div className="loader-spinner" /></div>;
    }

    return (
        <div className="unions-page">
            <header className="unions-header">
                <div>
                    <h1>🤝 Unions</h1>
                    <p>Join club networks for more players and bigger games.</p>
                </div>
                <button className="btn btn-primary" onClick={() => setIsCreating(true)}>
                    + New Union
                </button>
            </header>

            <div className="unions-grid">
                {unions.map(union => (
                    <div key={union.id} className="union-card">
                        <div className="union-header">
                            <span className="union-icon">{union.avatarUrl || '🤝'}</span>
                            <h3>{union.name}</h3>
                        </div>
                        <p className="union-description">{union.description}</p>
                        <div className="union-stats">
                            <div className="union-stat">
                                <span className="stat-value">{union.clubCount}</span>
                                <span className="stat-label">Clubs</span>
                            </div>
                            <div className="union-stat">
                                <span className="stat-value">{union.memberCount.toLocaleString()}</span>
                                <span className="stat-label">Members</span>
                            </div>
                            <div className="union-stat">
                                <span className="stat-value online">{Math.floor(union.memberCount * 0.2).toLocaleString()}</span>
                                <span className="stat-label">Online</span>
                            </div>
                        </div>
                        <Link to={`/unions/${union.id}`} className="btn btn-primary" style={{ width: '100%', textAlign: 'center' }}>
                            View Union
                        </Link>
                    </div>
                ))}
            </div>

            <section className="create-union-cta">
                <h2>Create Your Own Union</h2>
                <p>Bring together multiple clubs under one network for shared player pools and coordinated events.</p>
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
