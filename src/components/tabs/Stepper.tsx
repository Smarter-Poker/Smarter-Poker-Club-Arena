import React from 'react';
import './Stepper.css';

interface Step {
  id: string;
  label: string;
  description?: string;
}

interface StepperProps {
  steps: Step[];
  currentStep: number;
  orientation?: 'horizontal' | 'vertical';
  onStepClick?: (index: number) => void;
}

export const Stepper: React.FC<StepperProps> = ({
  steps,
  currentStep,
  orientation = 'horizontal',
  onStepClick,
}) => {
  return (
    <div className={`stepper orientation-${orientation}`}>
      {steps.map((step, index) => (
        <div
          key={step.id}
          className={`step ${index < currentStep ? 'completed' : ''} ${index === currentStep ? 'active' : ''}`}
          onClick={() => onStepClick?.(index)}
        >
          <div className="step-indicator">
            <span className="step-number">{index < currentStep ? '' : index + 1}</span>
          </div>
          <div className="step-content">
            <span className="step-label">{step.label}</span>
            {step.description && <span className="step-description">{step.description}</span>}
          </div>
          {index < steps.length - 1 && <div className="step-connector" />}
        </div>
      ))}
    </div>
  );
};

export default Stepper;
