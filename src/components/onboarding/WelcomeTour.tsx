import React, { useState } from 'react';
import './WelcomeTour.css';

interface TourStep {
  id: string;
  title: string;
  description: string;
  highlight?: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

interface WelcomeTourProps {
  steps: TourStep[];
  isActive: boolean;
  onComplete?: () => void;
  onSkip?: () => void;
}

export const WelcomeTour: React.FC<WelcomeTourProps> = ({
  steps,
  isActive,
  onComplete,
  onSkip,
}) => {
  const [currentStep, setCurrentStep] = useState(0);

  if (!isActive || steps.length === 0) return null;

  const step = steps[currentStep];
  const isLastStep = currentStep === steps.length - 1;

  const handleNext = () => {
    if (isLastStep) {
      onComplete?.();
    } else {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  return (
    <div className="welcome-tour">
      <div className="tour-backdrop"></div>

      <div className="tour-tooltip">
        <div className="tour-header">
          <span className="tour-step-indicator">
            {currentStep + 1} Of {steps.length}
          </span>
          <button className="tour-skip" onClick={onSkip}>
            Skip Tour
          </button>
        </div>

        <h3>{step.title}</h3>
        <p>{step.description}</p>

        <div className="tour-progress">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`progress-dot ${i === currentStep ? 'active' : ''} ${i < currentStep ? 'completed' : ''}`}
            />
          ))}
        </div>

        <div className="tour-actions">
          {currentStep > 0 && (
            <button className="prev-btn" onClick={handlePrev}>
              ← Back
            </button>
          )}
          <button className="next-btn" onClick={handleNext}>
            {isLastStep ? "Let's Play!" : 'Next →'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WelcomeTour;
