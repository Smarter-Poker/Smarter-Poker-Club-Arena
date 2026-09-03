/**
 * ♠ CLUB ARENA — Create Union Modal
 * Modal for club owners to create a new union (network)
 */

import { useState } from 'react';
import { unionService } from '../../services/UnionService';
import { useAuthUser } from '../../hooks/useAuthUser';
import styles from './CreateUnionModal.module.css';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';

interface CreateUnionModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export default function CreateUnionModal({ onClose, onSuccess }: CreateUnionModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user?.id) {
      toast.error('You must be logged in to create a union');
      return;
    }

    const ownerId = user.id;

    setLoading(true);
    try {
      await unionService.createUnion(name, description, ownerId);
      toast.success('Union created successfully!');
      onSuccess();
    } catch (error) {
      reportError(error, 'CreateUnionModal.Failed_to_create_union');
      toast.error('Failed to create union. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={styles['modal-overlay']}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles['modal-content']}>
        <header className={styles['modal-header']}>
          <h2>Create New Union</h2>
          <button className={styles['close-btn']} onClick={onClose}>
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className={styles['modal-body']}>
            <div className={styles['form-group']}>
              <label>Union Name</label>
              <input
                type="text"
                className="input"
                placeholder="E.G. Global Poker Alliance"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className={styles['form-group']}>
              <label>Description (Optional)</label>
              <textarea
                className="input"
                placeholder="Briefly Describe Your Union's Purpose And Region..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
            </div>
          </div>

          <div className={styles['modal-footer']}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Creating...' : 'Create Union'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
