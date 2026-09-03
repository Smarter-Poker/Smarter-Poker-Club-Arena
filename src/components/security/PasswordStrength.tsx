import React, { useMemo } from 'react';
import './PasswordStrength.css';

interface PasswordStrengthProps {
  password: string;
  showRequirements?: boolean;
}

interface Requirement {
  label: string;
  test: (pwd: string) => boolean;
}

const REQUIREMENTS: Requirement[] = [
  { label: 'At Least 8 Characters', test: (p) => p.length >= 8 },
  { label: 'Contains Uppercase Letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'Contains Lowercase Letter', test: (p) => /[a-z]/.test(p) },
  { label: 'Contains Number', test: (p) => /\d/.test(p) },
  { label: 'Contains Special Character', test: (p) => /[!@#$%^&*(),.?":{}|<>]/.test(p) },
];

export const PasswordStrength: React.FC<PasswordStrengthProps> = ({
  password,
  showRequirements = true,
}) => {
  const { strength, label, metRequirements } = useMemo(() => {
    const met = REQUIREMENTS.filter((r) => r.test(password));
    const score = met.length;

    let label = 'Very Weak';
    if (score >= 5) label = 'Strong';
    else if (score >= 4) label = 'Good';
    else if (score >= 3) label = 'Fair';
    else if (score >= 2) label = 'Weak';

    return {
      strength: score,
      label,
      metRequirements: met.map((r) => r.label),
    };
  }, [password]);

  const getStrengthColor = () => {
    if (strength >= 5) return '#4ade80';
    if (strength >= 4) return '#22c55e';
    if (strength >= 3) return '#fbbf24';
    if (strength >= 2) return '#f97316';
    return '#ef4444';
  };

  return (
    <div className="password-strength">
      <div className="strength-bar">
        {[1, 2, 3, 4, 5].map((level) => (
          <div
            key={level}
            className={`bar-segment ${strength >= level ? 'filled' : ''}`}
            style={{ backgroundColor: strength >= level ? getStrengthColor() : undefined }}
          />
        ))}
      </div>

      <span className="strength-label" style={{ color: getStrengthColor() }}>
        {password ? label : ''}
      </span>

      {showRequirements && password && (
        <div className="requirements-list">
          {REQUIREMENTS.map((req) => (
            <div
              key={req.label}
              className={`requirement ${metRequirements.includes(req.label) ? 'met' : ''}`}
            >
              <span className="req-icon">{metRequirements.includes(req.label) ? '' : '○'}</span>
              <span className="req-label">{req.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PasswordStrength;
