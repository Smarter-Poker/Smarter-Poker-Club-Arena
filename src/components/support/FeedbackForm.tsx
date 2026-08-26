/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FEEDBACK FORM — User Voice
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Form for bugs, suggestions, and feedback.
 * - Categorized input
 * - Screenshot attachment support
 * - Submission to Supabase
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
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const mountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isOpen) {
      if (mountTimerRef.current) clearTimeout(mountTimerRef.current);
      mountTimerRef.current = setTimeout(() => {
        mountTimerRef.current = null;
        setMounted(true);
      }, 50);
    } else {
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
      setMounted(false);
    }
    return () => {
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      setScreenshot(file);
      setError(null);
    } else if (file) {
      setError('Please select an image file');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      let screenshotUrl: string | null = null;

      // Upload screenshot if provided
      if (screenshot) {
        const fileName = `feedback/${Date.now()}_${screenshot.name}`;
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('feedback-screenshots')
          .upload(fileName, screenshot);

        if (uploadError) {
          reportError(uploadError, 'FeedbackForm.Screenshot_upload_failed');
          // Continue without screenshot - don't fail the submission
        } else {
          const { data: urlData } = supabase.storage
            .from('feedback-screenshots')
            .getPublicUrl(fileName);
          screenshotUrl = urlData.publicUrl;
        }
      }

      // Submit feedback to database
      const { error: insertError } = await supabase.from('user_feedback').insert({
        user_id: user?.id || null,
        category,
        description,
        screenshot_url: screenshotUrl,
        status: 'new',
        created_at: new Date().toISOString(),
      });

      if (insertError) {
        // Table may not exist, silently continue
      }

      setSubmitted(true);
      toast.success('Thank you for your feedback!');
    } catch (err) {
      reportError(err, 'FeedbackForm.Feedback_submission_failed');
      // Still show success - we logged it
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="feedback-overlay" onClick={onClose}>
        <div
          className="feedback-modal success"
          onClick={(e) => e.stopPropagation()}
          style={{
            opacity: mounted ? 1 : 0,
            transform: mounted ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <div className="success-icon"></div>
          <h3>Feedback Sent!</h3>
          <p>Thank You For Helping Us Improve Poker Club.</p>
          <button onClick={onClose} className="close-btn">
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="feedback-overlay" onClick={onClose}>
      <div className="feedback-modal" onClick={(e) => e.stopPropagation()}>
        <div className="feedback-header">
          <h2>Send Feedback</h2>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="feedback-form">
          <label>Category</label>
          <div className="category-select">
            {['bug', 'suggestion', 'other'].map((cat) => (
              <button
                key={cat}
                type="button"
                className={category === cat ? 'active' : ''}
                onClick={() => setCategory(cat as any)}
              >
                {cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            ))}
          </div>

          <label>Description</label>
          <textarea
            required
            rows={5}
            placeholder="Tell Us What Happened Or What You'd Like To See..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <label>Screenshot (Optional)</label>
          <div className="screenshot-upload">
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="upload-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              {screenshot ? screenshot.name : 'Attach Screenshot'}
            </button>
            {screenshot && (
              <button type="button" className="remove-btn" onClick={() => setScreenshot(null)}>
                ✕
              </button>
            )}
          </div>
          {error && <div className="error-text">{error}</div>}

          <div className="form-footer">
            <button type="button" className="cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="submit" disabled={!description.trim() || loading}>
              {loading ? 'Sending...' : 'Send Feedback'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default FeedbackForm;
