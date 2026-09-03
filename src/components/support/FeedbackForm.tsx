/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FEEDBACK FORM — User Voice
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Categorized support request submission to Supabase.
 */

import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './FeedbackForm.css';
import { reportError } from '../../utils/errorReporter';

export function FeedbackForm({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [category, setCategory] = useState<'bug' | 'suggestion' | 'other'>('bug');
  const [description, setDescription] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const mountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      setCategory('bug');
      setDescription('');
      setSubmitted(false);
      setLoading(false);
      setError(null);
      if (mountTimerRef.current) clearTimeout(mountTimerRef.current);
      mountTimerRef.current = setTimeout(() => {
        mountTimerRef.current = null;
        setMounted(true);
        closeButtonRef.current?.focus();
      }, 50);
    } else {
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
      setMounted(false);
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) onCloseRef.current();
    };
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const keepFocusInsideDialog = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href]'
      ) || []
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (!user?.id) {
        throw new Error('An authenticated account is required to send a support request.');
      }

      const { error: insertError } = await supabase.from('user_feedback').insert({
        user_id: user.id,
        category,
        description,
        screenshot_url: null,
        status: 'new',
        created_at: new Date().toISOString(),
      });

      if (insertError) throw insertError;

      setSubmitted(true);
      toast.success('Support Request Sent');
    } catch (submitError) {
      reportError(submitError, 'FeedbackForm.Feedback_submission_failed');
      setError('Support Request Could Not Be Sent. Try Again Or Email Support@Smarter.Poker.');
      toast.error('Support Request Not Sent');
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="feedback-overlay" onMouseDown={onClose}>
        <div
          ref={dialogRef}
          className="feedback-modal success"
          role="dialog"
          aria-modal="true"
          aria-labelledby="feedback-success-title"
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={keepFocusInsideDialog}
          style={{
            opacity: mounted ? 1 : 0,
            transform: mounted ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <div className="success-icon" aria-hidden="true" />
          <h3 id="feedback-success-title">Support Request Sent</h3>
          <p>Your Request Is In The Support Queue.</p>
          <button ref={closeButtonRef} onClick={onClose} className="close-btn">
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="feedback-overlay" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="feedback-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
        aria-describedby="feedback-dialog-description"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={keepFocusInsideDialog}
      >
        <div className="feedback-header">
          <div>
            <span>Direct Support Circuit</span>
            <h2 id="feedback-dialog-title">Send Support Request</h2>
          </div>
          <button ref={closeButtonRef} onClick={onClose} aria-label="Close Support Request">
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="feedback-form">
          <p id="feedback-dialog-description">
            Send A Bug Report, Product Suggestion, Or Account Question To The Live Support Queue.
          </p>

          <fieldset>
            <legend>Category</legend>
            <div className="category-select">
              {(['bug', 'suggestion', 'other'] as const).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={category === cat ? 'active' : ''}
                  aria-pressed={category === cat}
                  onClick={() => setCategory(cat)}
                >
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </button>
              ))}
            </div>
          </fieldset>

          <label htmlFor="support-request-description">Description</label>
          <textarea
            id="support-request-description"
            required
            rows={5}
            placeholder="Tell Us What Happened Or What You'd Like To See..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          {error && (
            <div className="error-text" role="alert">
              {error}
            </div>
          )}

          <div className="form-footer">
            <button type="button" className="cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="submit" disabled={!description.trim() || loading}>
              {loading ? 'Sending Request...' : 'Send Support Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default FeedbackForm;
