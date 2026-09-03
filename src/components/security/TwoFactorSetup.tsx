import React, { useState, useEffect } from 'react';
import './TwoFactorSetup.css';

interface TwoFactorSetupProps {
  isEnabled: boolean;
  qrCodeUrl?: string;
  secretKey?: string;
  onEnable?: (code: string) => Promise<boolean>;
  onDisable?: (code: string) => Promise<boolean>;
}

export const TwoFactorSetup: React.FC<TwoFactorSetupProps> = ({
  isEnabled,
  qrCodeUrl,
  secretKey,
  onEnable,
  onDisable,
}) => {
  const [verificationCode, setVerificationCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'info' | 'scan' | 'verify'>(isEnabled ? 'info' : 'info');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  const handleToggle = async () => {
    if (isEnabled) {
      if (!verificationCode) {
        setError('Enter your 2FA code to disable');
        return;
      }
      setIsLoading(true);
      const success = await onDisable?.(verificationCode);
      setIsLoading(false);
      if (!success) setError('Invalid code');
    } else {
      setStep('scan');
    }
  };

  const handleVerify = async () => {
    if (!verificationCode || verificationCode.length !== 6) {
      setError('Enter a valid 6-digit code');
      return;
    }
    setIsLoading(true);
    const success = await onEnable?.(verificationCode);
    setIsLoading(false);
    if (!success) setError('Invalid code. Try again.');
  };

  return (
    <div
      className="two-factor-setup"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      <div className="setup-header">
        <div className="shield-icon">⛨</div>
        <div className="header-text">
          <h3>Two-Factor Authentication</h3>
          <p className={isEnabled ? 'status-enabled' : 'status-disabled'}>
            {isEnabled ? ' Enabled' : '○ Disabled'}
          </p>
        </div>
      </div>

      {step === 'info' && (
        <div className="setup-info">
          <p>
            Add An Extra Layer Of Security To Your Account By Requiring A Verification Code In
            Addition To Your Password.
          </p>
          <button
            className={`toggle-btn ${isEnabled ? 'disable' : 'enable'}`}
            onClick={handleToggle}
          >
            {isEnabled ? 'Disable 2FA' : 'Enable 2FA'}
          </button>
        </div>
      )}

      {step === 'scan' && qrCodeUrl && (
        <div className="setup-scan">
          <p>Scan This QR Code With Your Authenticator App:</p>
          <div className="qr-container">
            <img loading="lazy" decoding="async" src={qrCodeUrl} alt="2FA QR Code" />
          </div>
          {secretKey && (
            <div className="secret-key">
              <span>Or Enter Manually:</span>
              <code>{secretKey}</code>
            </div>
          )}
          <button className="next-btn" onClick={() => setStep('verify')}>
            Next: Verify Code
          </button>
        </div>
      )}

      {step === 'verify' && (
        <div className="setup-verify">
          <p>Enter The 6-Digit Code From Your Authenticator:</p>
          <input
            type="text"
            className="code-input"
            value={verificationCode}
            onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            maxLength={6}
          />
          {error && <span className="error-text">{error}</span>}
          <button className="verify-btn" onClick={handleVerify} disabled={isLoading}>
            {isLoading ? 'Verifying...' : 'Verify & Enable'}
          </button>
        </div>
      )}
    </div>
  );
};

export default TwoFactorSetup;
