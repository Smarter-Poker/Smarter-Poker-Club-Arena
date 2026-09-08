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
import { useNavigate, useSearchParams } from 'react-router-dom';
import { IS_NATIVE_BUILD } from '../lib/appBase';
import { safeInAppRedirect, signInUrl } from '../lib/signIn';
import { authReturnUrl } from '../lib/authReturnUrl';
import { ageOn, latestAdultBirthday, MINIMUM_AGE } from '../lib/age';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { referralService } from '../services/ReferralService';
import styles from './AuthPage.module.css';
import { reportError } from '../utils/errorReporter';

import { safeErrorMessage } from '../utils/safeErrorMessage';
type AuthMode = 'login' | 'signup' | 'reset' | 'update';

/** What the login page says when it was reached because a session ended. */
function authErrorMessage(code: string | null): string | null {
  switch (code) {
    case 'no_session':
      return 'Your Session Ended. Please Sign In Again.';
    case 'link_expired':
      return 'That Link Has Expired. Please Request A New One.';
    case null:
    case '':
      return null;
    default:
      return 'Please Sign In To Continue.';
  }
}

export default function AuthPage() {
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const [searchParams] = useSearchParams();
  // NATIVE: where to go after signing in (AuthGuard put an in-app path here).
  const afterSignIn = safeInAppRedirect(searchParams.get('redirect'));
  const [mode, setMode] = useState<AuthMode>(
    searchParams.get('mode') === 'update' ? 'update' : 'login'
  );
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  /* THE APP STORE BUILD asks for a date of birth AT sign-up (Apple 1.1.4 and
     Play's Real-Money Gambling / simulated gambling policies both want the
     18+ check before the account exists, not after). Under 18 never reaches
     signUp() and nothing about a minor is sent anywhere. The web is
     unchanged: its accounts are gated by AgeGate once, on first use, and only
     when AGE_GATE_ON_WEB is flipped. */
  const [birthday, setBirthday] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    authErrorMessage(searchParams.get('authError'))
  );
  const [success, setSuccess] = useState<string | null>(null);
  const [cardOpacity, setCardOpacity] = useState(0);

  // Redirect already-authenticated users away from auth page
  useEffect(() => {
    if (mode === 'update') return; // a recovery session is signed in on purpose
    supabase.auth
      .getUser()
      .then(({ data: { user } }) => {
        if (user) {
          navigate(afterSignIn, { replace: true });
        } else if (!IS_NATIVE_BUILD) {
          // WEB, HARDENED: Unauthenticated users should NEVER see this local
          // page. Force them to the canonical World Hub login page.
          window.location.href = signInUrl('/');
        }
        // NATIVE (2026-09-07): this page IS the login page. Stay.
      })
      .catch(() => {
        // HARDENED: Error fetching user -> force canonical login (web only)
        if (!IS_NATIVE_BUILD) window.location.href = signInUrl('/');
      });
  }, [navigate, afterSignIn, mode]);

  // A password-recovery link handed its session to the SDK (web: via the URL
  // hash; native: src/lib/native/deepLinks). Open the new-password form.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' && isMounted.current) {
        setMode('update');
        setError(null);
        setSuccess(null);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [isMounted]);

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
        navigate(afterSignIn, { replace: true });
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

    const signupAge = IS_NATIVE_BUILD ? ageOn(birthday, new Date()) : null;
    if (IS_NATIVE_BUILD) {
      if (signupAge === null) {
        if (isMounted.current) setError('Please enter your date of birth');
        setIsLoading(false);
        return;
      }
      if (signupAge < MINIMUM_AGE) {
        if (isMounted.current) setError(`You must be ${MINIMUM_AGE} or older to create an account`);
        setIsLoading(false);
        return;
      }
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
          // The confirmation link must land somewhere that can finish the
          // sign-in: the web app on the web, and (via a universal link) the
          // app itself on native. src/lib/authReturnUrl.ts decides.
          emailRedirectTo: authReturnUrl('auth'),
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
          // The date of birth the player just gave, written once through the
          // same RPC the age gate uses. Without a session (email confirmation
          // on) the gate asks again on first sign-in; nothing is lost.
          if (IS_NATIVE_BUILD && birthday) {
            const { error: dobErr } = await supabase.rpc('fn_set_my_birthday', {
              p_birthday: birthday,
            });
            if (dobErr) reportError(dobErr, 'AuthPage.set_birthday_failed');
          }
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
          navigate(afterSignIn, { replace: true });
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

  const handlePasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMounted.current) setError(null);
    if (newPassword !== newPasswordConfirm) {
      if (isMounted.current) setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      if (isMounted.current)
        setError('Password must be at least 8 characters with one uppercase letter and one number');
      return;
    }
    setIsLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      if (isMounted.current) {
        setSuccess('Your Password Has Been Updated.');
        setNewPassword('');
        setNewPasswordConfirm('');
      }
      navigate(afterSignIn, { replace: true });
    } catch (err: any) {
      reportError(err, 'AuthPage.Password_update_failed');
      if (isMounted.current) setError(safeErrorMessage(err, 'Failed to update password.'));
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
        redirectTo: authReturnUrl('auth?mode=update'),
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
        {mode !== 'reset' && mode !== 'update' && (
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

            {IS_NATIVE_BUILD && (
              <div className={styles.inputGroup}>
                <label htmlFor="signup-birthday">Date Of Birth</label>
                <input
                  id="signup-birthday"
                  type="date"
                  value={birthday}
                  onChange={(e) => setBirthday(e.target.value)}
                  max={latestAdultBirthday(new Date())}
                  required
                  autoComplete="bday"
                />
              </div>
            )}

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

        {/* New Password Form (after a recovery link) */}
        {mode === 'update' && (
          <form onSubmit={handlePasswordUpdate} className={styles.form}>
            <p className={styles.resetText}>Choose A New Password For Your Account.</p>

            <div className={styles.inputGroup}>
              <label htmlFor="new-password">New Password</label>
              <input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At Least 8 Characters"
                required
                autoComplete="new-password"
              />
            </div>

            <div className={styles.inputGroup}>
              <label htmlFor="new-password-confirm">Confirm New Password</label>
              <input
                id="new-password-confirm"
                type="password"
                value={newPasswordConfirm}
                onChange={(e) => setNewPasswordConfirm(e.target.value)}
                placeholder="Repeat Your New Password"
                required
                autoComplete="new-password"
              />
            </div>

            <button type="submit" className={styles.submitButton} disabled={isLoading}>
              {isLoading ? 'Updating...' : 'Update Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
