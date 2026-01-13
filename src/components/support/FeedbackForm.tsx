/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💬 FEEDBACK FORM — User Voice
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Form for bugs, suggestions, and feedback.
 * - Categorized input
 * - Screenshots (mock)
 * - Submission success state
 */

import React, { useState } from 'react';
import './FeedbackForm.css';

export function FeedbackForm({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
    const [category, setCategory] = useState<'bug' | 'suggestion' | 'other'>('bug');
    const [description, setDescription] = useState('');
    const [submitted, setSubmitted] = useState(false);

    if (!isOpen) return null;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        // In real app, API call here
    };

    if (submitted) {
        return (
            <div className="feedback-overlay" onClick={onClose}>
                <div className="feedback-modal success" onClick={(e) => e.stopPropagation()}>
                    <div className="success-icon">✅</div>
                    <h3>Feedback Sent!</h3>
                    <p>Thank you for helping us improve Poker Club.</p>
                    <button onClick={onClose} className="close-btn">Close</button>
                </div>
            </div>
        );
    }

    return (
        <div className="feedback-overlay" onClick={onClose}>
            <div className="feedback-modal" onClick={(e) => e.stopPropagation()}>
                <div className="feedback-header">
                    <h2>Send Feedback</h2>
                    <button onClick={onClose}>×</button>
                </div>

                <form onSubmit={handleSubmit} className="feedback-form">
                    <label>Category</label>
                    <div className="category-select">
                        {['bug', 'suggestion', 'other'].map(cat => (
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
                        placeholder="Tell us what happened or what you'd like to see..."
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                    />

                    <div className="form-footer">
                        <button type="button" className="cancel" onClick={onClose}>Cancel</button>
                        <button type="submit" className="submit" disabled={!description.trim()}>Send Feedback</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

export default FeedbackForm;
