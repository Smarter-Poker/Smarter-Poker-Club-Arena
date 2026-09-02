import React, { useState } from 'react';
import './RatingModal.css';

interface RatingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit?: (rating: number, feedback: string) => void;
  title?: string;
  subtitle?: string;
}

export const RatingModal: React.FC<RatingModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  title = 'Rate Your Experience',
  subtitle = 'How was your session?',
}) => {
  const [rating, setRating] = useState(0);
  const [hoveredRating, setHoveredRating] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [submitted, setSubmitted] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = () => {
    onSubmit?.(rating, feedback);
    setSubmitted(true);
    setTimeout(() => {
      onClose();
      setSubmitted(false);
      setRating(0);
      setFeedback('');
    }, 1500);
  };

  const displayRating = hoveredRating || rating;

  return (
    <div className="rating-modal-overlay" onClick={onClose}>
      <div className="rating-modal" onClick={(e) => e.stopPropagation()}>
        {submitted ? (
          <div className="rating-success">
            <span className="success-icon"></span>
            <p>Thanks For Your Feedback!</p>
          </div>
        ) : (
          <>
            <h2>{title}</h2>
            <p className="rating-subtitle">{subtitle}</p>

            <div className="stars-container">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  className={`star-btn ${star <= displayRating ? 'active' : ''}`}
                  onMouseEnter={() => setHoveredRating(star)}
                  onMouseLeave={() => setHoveredRating(0)}
                  onClick={() => setRating(star)}
                >
                  ★
                </button>
              ))}
            </div>

            <div className="rating-labels">
              <span>Poor</span>
              <span>Excellent</span>
            </div>

            <textarea
              className="feedback-input"
              placeholder="Any Additional Feedback? (Optional)"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
            />

            <div className="rating-actions">
              <button className="skip-btn" onClick={onClose}>
                Skip
              </button>
              <button className="submit-btn" onClick={handleSubmit} disabled={rating === 0}>
                Submit
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default RatingModal;
