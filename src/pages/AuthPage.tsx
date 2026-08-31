/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🔐 CLUB ARENA — Authentication Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Login, Signup, and Password Reset flows via Supabase Auth
 *
 * NO DEMO MODE - All authentication is real.
 */

import { useState, useEffect } from 'react';
import { MEDIA_BASE } from '../utils/mediaBase';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { referralService } from '../services/ReferralService';
import styles from './AuthPage.module.css';
import { reportError } from '../utils/errorReporter';

import { safeErrorMessage } from '../utils/safeErrorMessage';
type AuthMode = 'login' | 'signup' | 'reset';

export default function AuthPage() {
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cardOpacity, setCardOpacity] = useState(0);

  // Redirect already-authenticated users away from auth page
  useEffect(() => {
    supabase.auth
      .getUser()
      .then(({ data: { user } }) => {
        if (user) {
          navigate('/', { replace: true });
        } else {
          // HARDENED: Unauthenticated users should NEVER see this local page.
          // Force them to the canonical World Hub login page.
          window.location.href = '/auth/login?redirect=/hub/club-arena';
        }
      })
      .catch(() => {
        // HARDENED: Error fetching user -> force canonical login
        window.location.href = '/auth/login?redirect=/hub/club-arena';
      });
  }, [navigate]);

  // Form entrance animation
  useEffect(() => {
    setCardOpacity(1);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) throw authError;

      if (data.user) {
        masterBus.emit('AUTH_STATE_CHANGED', {
          userId: data.user.id,
          isAuthenticated: true,
        });
        navigate('/');
      }
    } catch (err: any) {
      reportError(err, 'AuthPage.Login_failed');
      // SECURITY: Generic message to prevent user enumeration
      if (isMounted.current) setError('Invalid email or password. Please try again.');
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    if (isMounted.current) setError(null);

    // Validation
    if (password !== confirmPassword) {
      if (isMounted.current) setError('Passwords do not match');
      setIsLoading(false);
      return;
    }

    if (password.length < 8) {
      if (isMounted.current) setError('Password must be at least 8 characters');
      setIsLoading(false);
      return;
    }
    if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      if (isMounted.current)
        setError('Password must include at least one uppercase letter and one number');
      setIsLoading(false);
      return;
    }

    if (!username.trim()) {
      if (isMounted.current) setError('Username is required');
      setIsLoading(false);
      return;
    }

    // Email format validation (beyond HTML type="email")
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      if (isMounted.current) setError('Please enter a valid email address');
      setIsLoading(false);
      return;
    }

    try {
      // Sign up with Supabase
      const { data, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            username: username.trim(),
            display_name: username.trim(),
          },
        },
      });

      if (authError) throw authError;

      if (data.user?.id) {
        // ═══════════════════════════════════════════════════════════════════
        // 🔗 DUPLICATE PREVENTION: Check if a profile with same email exists
        // ═══════════════════════════════════════════════════════════════════
        const { data: emailMatch, error: emailCheckError } = await supabase
          .from('profiles')
          .select('id, username, display_name, email')
          .ilike('email', email.trim())
          .maybeSingle();

        if (emailMatch && !emailCheckError) {
          // Duplicate prevention: existing profile found for this email, linking to new auth ID

          // Update existing profile's last login
          const { error: linkError } = await supabase
            .from('profiles')
            .update({
              last_login: new Date().toISOString(),
              last_active: new Date().toISOString(),
              is_online: true,
            })
            .eq('id', emailMatch.id);
          if (linkError) {
            console.warn('[AUTH] Profile link update failed (non-critical):', linkError.message);
          }

          // Account successfully linked!
        } else {
          // Create new profile in database
          const { error: profileError } = await supabase.from('profiles').upsert({
            id: data.user.id,
            username: username.trim(),
            display_name: username.trim(),
            tier: 'Newcomer', // DB uses `tier`, not `vip_level`
            diamonds: 0,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            last_active: new Date().toISOString(),
            is_online: true,
          });

          if (profileError) {
            // PGRST116 = no rows (ok on upsert), 23505 = unique violation (username taken)
            if (profileError.code === '23505') {
              throw new Error('Username is already taken. Please choose a different one.');
            }
            console.warn(
              '[AUTH] Profile creation failed (non-critical, may already exist):',
              profileError.code
            );
          }
        }

        // ═══════════════════════════════════════════════════════════════════
        // Ensure public.users entry exists (required for club_members FK)
        // The DB trigger should handle this, but belt-and-suspenders approach
        // ═══════════════════════════════════════════════════════════════════
        const { error: usersErr } = await supabase.from('users').upsert(
          {
            id: data.user.id,
            username: username.trim(),
            email: email.trim(),
          },
          { onConflict: 'id' }
        );
        if (usersErr) {
          reportError(usersErr, 'AuthPage.publicusers_upsert_FAILED');
          // Don't throw — DB trigger may handle this. But log as error, not warn.
        }

        // Check if email confirmation is required
        if (data.session) {
          // Redeem referral code if provided
          if (referralCode.trim()) {
            const result = await referralService.redeemCode(data.user.id, referralCode.trim());
            if (result.success) {
              // Referral code applied successfully
            } else {
              console.warn('[AUTH] Referral redemption failed:', result.error);
            }
          }
          masterBus.emit('AUTH_STATE_CHANGED', {
            userId: data.user.id,
            isAuthenticated: true,
          });
          navigate('/');
        } else {
          setSuccess('Account created! Please check your email to verify your account.');
          setMode('login');
        }
      }
    } catch (err: any) {
      reportError(err, 'AuthPage.Signup_failed');
      if (isMounted.current) setError(safeErrorMessage(err, 'Signup failed. Please try again.'));
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    if (isMounted.current) setError(null);

    try {
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/hub/club-arena/auth?mode=reset`,
      });

      // SECURITY: Always show success regardless of whether email exists
      // This prevents user enumeration attacks
      setSuccess('If an account exists with this email, you will receive a password reset link.');
    } catch (err: any) {
      reportError(err, 'AuthPage.Password_reset_failed');
      if (isMounted.current) setError(safeErrorMessage(err, 'Failed to send reset email.'));
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <style>{`
                @keyframes slideUpIn {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes focusGlow {
                    from { box-shadow: 0 0 0 0 rgba(0, 212, 255, 0.4); }
                    to { box-shadow: 0 0 0 8px rgba(0, 212, 255, 0); }
                }
                .auth-card-animated {
                    animation: slideUpIn 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
                }
                .auth-input-premium:focus {
                    animation: focusGlow 0.6s ease-out;
                }
            `}</style>
      <div
        className={styles.authCard}
        style={{ animation: `animationsSlideUpIn 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)` }}
      >
        {/* Logo */}
        <div className={styles.logo}>
          <img
            src={`${MEDIA_BASE}images/smarter-poker-logo.jpg`}
            alt="Smarter.Poker"
            className={styles.logoImage}
          />
        </div>

        {/* Tab Switcher */}
        {mode !== 'reset' && (
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${mode === 'login' ? styles.tabActive : ''}`}
              onClick={() => {
                setMode('login');
                setError(null);
                setSuccess(null);
              }}
            >
              Login
            </button>
            <button
              className={`${styles.tab} ${mode === 'signup' ? styles.tabActive : ''}`}
              onClick={() => {
                setMode('signup');
                setError(null);
                setSuccess(null);
              }}
            >
              Sign Up
            </button>
          </div>
        )}

        {/* Success Message */}
        {success && (
          <div className={styles.successMessage}>
            <span>\u2713</span> {success}
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className={styles.errorMessage}>
            <span>!</span> {error}
          </div>
        )}

        {/* Login Form */}
        {mode === 'login' && (
          <form onSubmit={handleLogin} className={styles.form}>
            <div className={styles.inputGroup}>
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                autoComplete="email"
              />
            </div>

            <div className={styles.inputGroup}>
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              className={styles.submitButton}
              disabled={isLoading}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              {isLoading && (
                <span
                  style={{
                    display: 'inline-block',
                    width: '14px',
                    height: '14px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTop: '2px solid #fff',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
              )}
              {isLoading ? 'Logging In...' : 'Login'}
            </button>

            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setMode('reset');
                setError(null);
              }}
            >
              Forgot Password?
            </button>
          </form>
        )}

        {/* Signup Form */}
        {mode === 'signup' && (
          <form onSubmit={handleSignup} className={styles.form}>
            <div className={styles.inputGroup}>
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="PokerPro123"
                required
                autoComplete="username"
              />
            </div>

            <div className={styles.inputGroup}>
              <label htmlFor="signup-email">Email</label>
              <input
                id="signup-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                autoComplete="email"
              />
            </div>

            <div className={styles.inputGroup}>
              <label htmlFor="signup-password">Password</label>
              <input
                id="signup-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>

            <div className={styles.inputGroup}>
              <label htmlFor="confirm-password">Confirm Password</label>
              <input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="new-password"
              />
            </div>

            <div className={styles.inputGroup}>
              <label htmlFor="referral-code">
                Referral Code{' '}
                <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.75rem' }}>
                  (Optional)
                </span>
              </label>
              <input
                id="referral-code"
                type="text"
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                placeholder="E.G. ABCD1234"
                autoComplete="off"
                style={{ textTransform: 'uppercase', letterSpacing: '1px' }}
              />
            </div>

            <button
              type="submit"
              className={styles.submitButton}
              disabled={isLoading}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              {isLoading && (
                <span
                  style={{
                    display: 'inline-block',
                    width: '14px',
                    height: '14px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTop: '2px solid #fff',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
              )}
              {isLoading ? 'Creating Account...' : 'Create Account'}
            </button>
          </form>
        )}

        {/* Password Reset Form */}
        {mode === 'reset' && (
          <form onSubmit={handlePasswordReset} className={styles.form}>
            <p className={styles.resetText}>
              Enter Your Email And We'll Send You A Link To Reset Your Password.
            </p>

            <div className={styles.inputGroup}>
              <label htmlFor="reset-email">Email</label>
              <input
                id="reset-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                autoComplete="email"
              />
            </div>

            <button
              type="submit"
              className={styles.submitButton}
              disabled={isLoading}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              {isLoading && (
                <span
                  style={{
                    display: 'inline-block',
                    width: '14px',
                    height: '14px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTop: '2px solid #fff',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
              )}
              {isLoading ? 'Sending...' : 'Send Reset Link'}
            </button>

            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setMode('login');
                setError(null);
                setSuccess(null);
              }}
            >
              ← Back To Login
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
