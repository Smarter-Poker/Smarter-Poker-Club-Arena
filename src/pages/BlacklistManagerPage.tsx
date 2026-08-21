/**
 * BLACKLIST MANAGER PAGE -- Club/Union-Level Player Blacklisting
 *
 * PokerBros parity: club + union level player blacklists with
 * reason tracking, expiry support, and admin CRUD.
 *
 * Route: /clubs/:clubId/blacklist
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import type { BlacklistEntry } from '../types/club.types';

import { safeErrorMessage } from '../utils/safeErrorMessage';
// ── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  page: {
    minHeight: '100vh',
    background: '#0a0a0f',
    color: '#e0e0e0',
    padding: '20px',
    fontFamily: "'Inter', -apple-system, sans-serif",
  } as React.CSSProperties,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
  } as React.CSSProperties,
  title: {
    fontSize: '22px',
    fontWeight: 700,
    color: '#ffffff',
  } as React.CSSProperties,
  backBtn: {
    background: 'none',
    border: '1px solid #333',
    color: '#aaa',
    padding: '8px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
  } as React.CSSProperties,
  card: {
    background: '#1a1a2e',
    borderRadius: '10px',
    padding: '20px',
    marginBottom: '16px',
    border: '1px solid #2a2a3e',
  } as React.CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '13px',
  },
  th: {
    textAlign: 'left' as const,
    padding: '10px 12px',
    borderBottom: '1px solid #2a2a3e',
    color: '#888',
    fontWeight: 600,
    fontSize: '11px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  td: {
    padding: '10px 12px',
    borderBottom: '1px solid #1a1a2e',
    color: '#ccc',
  },
  removeBtn: {
    background: '#dc2626',
    color: '#fff',
    border: 'none',
    padding: '5px 12px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 600,
  } as React.CSSProperties,
  addBtn: {
    background: '#4169E1',
    color: '#fff',
    border: 'none',
    padding: '10px 20px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 600,
  } as React.CSSProperties,
  input: {
    background: '#111122',
    border: '1px solid #333',
    color: '#e0e0e0',
    padding: '8px 12px',
    borderRadius: '6px',
    fontSize: '13px',
    width: '100%',
  } as React.CSSProperties,
  formRow: {
    display: 'flex',
    gap: '12px',
    marginBottom: '12px',
    alignItems: 'flex-end',
  } as React.CSSProperties,
  formGroup: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  label: {
    fontSize: '11px',
    color: '#888',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    fontWeight: 600,
  } as React.CSSProperties,
  empty: {
    textAlign: 'center' as const,
    padding: '40px 20px',
    color: '#666',
    fontSize: '14px',
  },
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
  } as React.CSSProperties,
  badgeActive: {
    background: 'rgba(220, 38, 38, 0.15)',
    color: '#ef4444',
  },
  badgeExpired: {
    background: 'rgba(100, 100, 100, 0.15)',
    color: '#888',
  },
  error: {
    background: 'rgba(220, 38, 38, 0.1)',
    border: '1px solid rgba(220, 38, 38, 0.3)',
    borderRadius: '8px',
    padding: '12px 16px',
    color: '#ef4444',
    marginBottom: '16px',
    fontSize: '13px',
  } as React.CSSProperties,
};

// ── Component ───────────────────────────────────────────────────────────────

export default function BlacklistManagerPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();

  const [entries, setEntries] = useState<BlacklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Add form state
  const [newUserId, setNewUserId] = useState('');
  const [newReason, setNewReason] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // ── Load blacklist entries ──

  const loadEntries = useCallback(async () => {
    if (!clubId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchErr } = await supabase
        .from('blacklists')
        .select('*')
        .eq('club_id', clubId)
        .order('banned_at', { ascending: false });

      if (fetchErr) throw fetchErr;
      setEntries(data || []);
    } catch (err: any) {
      setError(safeErrorMessage(err, 'Failed to load blacklist'));
    } finally {
      setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  // ── Add to blacklist ──

  const handleAdd = async () => {
    if (!clubId || !user || !newUserId.trim() || !newReason.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const entry: Partial<BlacklistEntry> = {
        club_id: clubId,
        user_id: newUserId.trim(),
        reason: newReason.trim(),
        banned_by: user.id,
        banned_at: new Date().toISOString(),
      };
      if (newExpiry) {
        entry.expires_at = new Date(newExpiry).toISOString();
      }

      const { error: insertErr } = await supabase.from('blacklists').insert(entry);

      if (insertErr) throw insertErr;

      setNewUserId('');
      setNewReason('');
      setNewExpiry('');
      setShowAddForm(false);
      await loadEntries();
    } catch (err: any) {
      setError(safeErrorMessage(err, 'Failed to add to blacklist'));
    } finally {
      setAdding(false);
    }
  };

  // ── Remove from blacklist ──

  const handleRemove = async (entryId: string) => {
    setRemoving(entryId);
    setError(null);
    try {
      const { error: delErr } = await supabase.from('blacklists').delete().eq('id', entryId);

      if (delErr) throw delErr;
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
    } catch (err: any) {
      setError(safeErrorMessage(err, 'Failed to remove from blacklist'));
    } finally {
      setRemoving(null);
    }
  };

  // ── Helpers ──

  const isExpired = (entry: BlacklistEntry): boolean => {
    if (!entry.expires_at) return false;
    return new Date(entry.expires_at) < new Date();
  };

  const formatDate = (iso: string): string => {
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <span style={styles.title}>Blacklist Manager</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          {!showAddForm && (
            <button style={styles.addBtn} onClick={() => setShowAddForm(true)}>
              + Add Player
            </button>
          )}
          <button style={styles.backBtn} onClick={() => navigate(-1)}>
            Back
          </button>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Add Form */}
      {showAddForm && (
        <div style={styles.card}>
          <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px', color: '#fff' }}>
            Add Player to Blacklist
          </div>
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.label}>User ID</label>
              <input
                style={styles.input}
                placeholder="Player's user ID"
                value={newUserId}
                onChange={(e) => setNewUserId(e.target.value)}
              />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Reason</label>
              <input
                style={styles.input}
                placeholder="Reason for ban"
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
              />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Expiry (optional)</label>
              <input
                style={styles.input}
                type="date"
                value={newExpiry}
                onChange={(e) => setNewExpiry(e.target.value)}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              style={styles.addBtn}
              onClick={handleAdd}
              disabled={adding || !newUserId.trim() || !newReason.trim()}
            >
              {adding ? 'Adding...' : 'Confirm Ban'}
            </button>
            <button
              style={styles.backBtn}
              onClick={() => {
                setShowAddForm(false);
                setNewUserId('');
                setNewReason('');
                setNewExpiry('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Entries Table */}
      <div style={styles.card}>
        {loading ? (
          <div style={styles.empty}>Loading blacklist...</div>
        ) : entries.length === 0 ? (
          <div style={styles.empty}>No blacklisted players. The blacklist is empty.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>User ID</th>
                <th style={styles.th}>Reason</th>
                <th style={styles.th}>Banned</th>
                <th style={styles.th}>Expires</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td style={styles.td}>
                    <code style={{ fontSize: '11px', color: '#aaa' }}>
                      {entry.user_id.slice(0, 12)}...
                    </code>
                  </td>
                  <td style={styles.td}>{entry.reason}</td>
                  <td style={styles.td}>{formatDate(entry.banned_at)}</td>
                  <td style={styles.td}>
                    {entry.expires_at ? formatDate(entry.expires_at) : 'Permanent'}
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        ...styles.badge,
                        ...(isExpired(entry) ? styles.badgeExpired : styles.badgeActive),
                      }}
                    >
                      {isExpired(entry) ? 'Expired' : 'Active'}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <button
                      style={{
                        ...styles.removeBtn,
                        opacity: removing === entry.id ? 0.5 : 1,
                      }}
                      onClick={() => handleRemove(entry.id)}
                      disabled={removing === entry.id}
                    >
                      {removing === entry.id ? 'Removing...' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div
          style={{
            marginTop: '12px',
            fontSize: '12px',
            color: '#555',
            textAlign: 'right',
          }}
        >
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'} total
        </div>
      </div>
    </div>
  );
}
