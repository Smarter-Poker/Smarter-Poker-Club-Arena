/**
 * ♠ CLUB ARENA — Create Union Modal
 * Modal for club owners to create a new union (network)
 */

import { useState } from 'react';
import { unionService } from '../../services/UnionService';
import { useUserStore } from '../../stores/useUserStore';
import styles from './CreateUnionModal.module.css';

interface CreateUnionModalProps {
    onClose: () => void;
    onSuccess: () => void;
}

export default function CreateUnionModal({ onClose, onSuccess }: CreateUnionModalProps) {
    const { user } = useUserStore();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // In a real app we'd check permissions, but for demo we assume logged in user can create
        const ownerId = user?.id || 'demo_user';

        setLoading(true);
        try {
            await unionService.createUnion(name, description, ownerId);
            onSuccess();
        } catch (error) {
            console.error('Failed to create union', error);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={styles['modal-overlay']} onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
        }}>
            <div className={styles['modal-content']}>
                <header className={styles['modal-header']}>
                    <h2>Create New Union</h2>
                    <button className={styles['close-btn']} onClick={onClose}>✕</button>
                </header>

                <form onSubmit={handleSubmit}>
                    <div className={styles['modal-body']}>
                        <div className={styles['form-group']}>
                            <label>Union Name</label>
                            <input
                                type="text"
                                className="input"
                                placeholder="e.g. Global Poker Alliance"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                required
                                autoFocus
                            />
                        </div>
                        <div className={styles['form-group']}>
                            <label>Description (Optional)</label>
                            <textarea
                                className="input"
                                placeholder="Briefly describe your union's purpose and region..."
                                value={description}
                                onChange={e => setDescription(e.target.value)}
                                rows={4}
                            />
                        </div>
                    </div>

                    <div className={styles['modal-footer']}>
                        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={loading}>
                            {loading ? 'Creating...' : 'Create Union'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
