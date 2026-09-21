/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA - Authentication Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Login, Signup, and Password Reset flows via Supabase Auth
 *
 * NO DEMO MODE - All authentication is real.
 *
 * #ClubArenaConsole (2026-09-14). This is the first surface a new player meets
 * and it was the generic Facebook-dark card. It is rebuilt on the approved
 * master: the frame, the two action plates and the flat closing cap are
 * painted (SpadeConsole), the fields are grooves cut into the glass, the tabs
 * and the one-action modes are lit words. NOTHING IS DRAWN.
 *
 * PAINT ONLY. Every auth handler, guard, validation branch, redirect,
 * `authError` query, return path, input id and autoComplete token is exactly
 * what it was; the credential logic was not touched. What DID change besides
 * the picture, and why:
 *
 *   - Every message a player reads is Title Cased (Dan 2026-09-14: "THE FIRST
 *     LETTER OF EVERY WORD MUST ALWAYS BE CAPITALIZED"). Fourteen of them were
 *     sentence case. They are literals, but they sit in `setError(...)` rather
 *     than in JSX text, which is why all four copy gates passed over them.
 *   - The three messages that come from DATA - whatever Supabase said - go
 *     through `titleCase()` at the print site, because no gate can see those
 *     at all.
 *   - The success box printed a backslash, a u and four digits to the player.
 *     The mark was written as JSX TEXT, where an escape sequence is not an
 *     escape sequence - it is six literal characters. It is a lit bullet now.
 *   - The logo was a bitmap with its own baked metal frame sitting inside the
 *     card. "FRAMES SHOULD NEVER SIT ON TOP OF FRAMES": the console head and
 *     its crest are the brand mark now.
 */

import { useState, useEffect } from 'react';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { IS_NATIVE_BUILD } from '../lib/appBase';
import { safeInAppRedirect, signInUrl } from '../lib/signIn';
import { authReturnUrl } from '../lib/authReturnUrl';
import { ageOn, latestAdultBirthday, MINIMUM_AGE } from '../lib/age';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { referralService } from '../services/ReferralService';
import { SpadeConsole } from '../components/console/SpadeConsole';
import type { PlateButtonProps } from '../components/console/SpadeConsole';
import { titleCase } from '../utils/titleCase';
import styles from './AuthPage.module.css';
import { reportError } from '../utils/errorReporter';

import { safeErrorMessage } from '../utils/safeErrorMessage';
type AuthMode = 'login' | 'signup' | 'reset' | 'update';

/**
 * What the master's painted pill slot says, per mode.
 *
 * THE SLOT IS PAINTED WHETHER OR NOT YOU PRINT INTO IT, and an empty one reads
 * as broken rather than spare - 100 of the 107 console surfaces in this repo
 * fill it. On the front door the honest word for it is the mode, which is also
 * the one thing the tabs cannot say in the reset and recovery flows, because
 * those have no tabs. Short words: the slot is 197 x 54 of a 1000px master.
 */
const PILL: Record<AuthMode, string> = {
  login: 'Sign In',
  signup: 'Sign Up',
  reset: 'Reset',
  update: 'Recovery',
};

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

  /* The entrance is `animationsSlideUpIn` on the console itself (see
     AuthPage.module.css). It used to be a `cardOpacity` state that was set to
     1 on mount and never read by anything. */

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
      if (isMounted.current) setError('Invalid Email Or Password. Please Try Again.');
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
      if (isMounted.current) setError('Passwords Do Not Match');
      setIsLoading(false);
      return;
    }

    if (password.length < 8) {
      if (isMounted.current) setError('Password Must Be At Least 8 Characters');
      setIsLoading(false);
      return;
    }
    if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      if (isMounted.current)
        setError('Password Must Include At Least One Uppercase Letter And One Number');
      setIsLoading(false);
      return;
    }

    if (!username.trim()) {
      if (isMounted.current) setError('Username Is Required');
      setIsLoading(false);
      return;
    }

    const signupAge = IS_NATIVE_BUILD ? ageOn(birthday, new Date()) : null;
    if (IS_NATIVE_BUILD) {
      if (signupAge === null) {
        if (isMounted.current) setError('Please Enter Your Date Of Birth');
        setIsLoading(false);
        return;
      }
      if (signupAge < MINIMUM_AGE) {
        if (isMounted.current) setError(`You Must Be ${MINIMUM_AGE} Or Older To Create An Account`);
        setIsLoading(false);
        return;
      }
    }

    // Email format validation (beyond HTML type="email")
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      if (isMounted.current) setError('Please Enter A Valid Email Address');
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
        // DUPLICATE PREVENTION: Check if a profile with same email exists
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
              throw new Error('Username Is Already Taken. Please Choose A Different One.');
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
          // Don't throw - DB trigger may handle this. But log as error, not warn.
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
          setSuccess('Account Created. Please Check Your Email To Verify Your Account.');
          setMode('login');
        }
      }
    } catch (err: any) {
      reportError(err, 'AuthPage.Signup_failed');
      if (isMounted.current)
        setError(titleCase(safeErrorMessage(err, 'Sign Up Failed. Please Try Again.')));
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  };

  const handlePasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMounted.current) setError(null);
    if (newPassword !== newPasswordConfirm) {
      if (isMounted.current) setError('Passwords Do Not Match');
      return;
    }
    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      if (isMounted.current)
        setError('Password Must Be At Least 8 Characters With One Uppercase Letter And One Number');
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
      if (isMounted.current)
        setError(titleCase(safeErrorMessage(err, 'Failed To Update Password.')));
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
      setSuccess('If An Account Exists With This Email, You Will Receive A Password Reset Link.');
    } catch (err: any) {
      reportError(err, 'AuthPage.Password_reset_failed');
      if (isMounted.current)
        setError(titleCase(safeErrorMessage(err, 'Failed To Send Reset Email.')));
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  };

  /* ── THE PICTURE ─────────────────────────────────────────────────────────
     One form, one console. The fields inside it are the ones the current mode
     owns, so `required` only ever applies to what is on screen, exactly as it
     did when each mode carried its own <form>. */

  const goLogin = () => {
    setMode('login');
    setError(null);
    setSuccess(null);
  };

  const goReset = () => {
    setMode('reset');
    setError(null);
  };

  const onSubmit =
    mode === 'login'
      ? handleLogin
      : mode === 'signup'
        ? handleSignup
        : mode === 'reset'
          ? handlePasswordReset
          : handlePasswordUpdate;

  /* The busy state is said in the LABEL and moved with an opacity pulse, not
     drawn as a spinning ring. `LayeredActionButton` prints "Working" for the
     same reason: the console paints controls, it does not draw them. */
  const primaryLabel =
    mode === 'login'
      ? isLoading
        ? 'Logging In'
        : 'Login'
      : mode === 'signup'
        ? isLoading
          ? 'Creating Account'
          : 'Create Account'
        : mode === 'reset'
          ? isLoading
            ? 'Sending'
            : 'Send Reset Link'
          : isLoading
            ? 'Updating'
            : 'Update Password';

  const primaryPlate: PlateButtonProps = {
    label: primaryLabel,
    ink: 'white',
    type: 'submit',
    disabled: isLoading,
    className: isLoading ? styles.plateBusy : undefined,
  };

  const secondaryPlate: PlateButtonProps =
    mode === 'login'
      ? { label: 'Forgot Password', onClick: goReset }
      : { label: 'Back To Login', onClick: goLogin };

  return (
    <div className={styles.container}>
      <form className={styles.form} onSubmit={onSubmit} aria-labelledby="auth-title">
        <SpadeConsole
          className={styles.console}
          /* The brand, then the room, then the mode. This is also what
             replaced the logo bitmap: it was a JPEG carrying its own baked
             metal frame, sitting inside the card, and "FRAMES SHOULD NEVER SIT
             ON TOP OF FRAMES". The console head and its crest are the mark. */
          eyebrow="Smarter Poker"
          title="Club Arena"
          pill={PILL[mode]}
          titleId="auth-title"
          /* THE FOOT FOLLOWS WHAT THE MODE ACTUALLY OFFERS (the Club Rules
             pattern). Both plates are painted, so a mode with one action takes
             the flat closing cap rather than leaving a plate painted and
             empty. Only `update`, reached from a recovery email, has one. */
          foot={mode === 'update' ? 'foot' : 'plates'}
          plates={
            mode === 'update' ? undefined : { secondary: secondaryPlate, primary: primaryPlate }
          }
        >
          {/* Two lit words on the glass, closed by an engraved rule. */}
          {mode !== 'reset' && mode !== 'update' && (
            <div className={styles.tabs}>
              <button
                type="button"
                className={`${styles.tab} ${mode === 'login' ? 'sc-ink--white' : 'sc-ink--muted'}`}
                aria-pressed={mode === 'login'}
                onClick={goLogin}
              >
                Login
              </button>
              <button
                type="button"
                className={`${styles.tab} ${mode === 'signup' ? 'sc-ink--white' : 'sc-ink--muted'}`}
                aria-pressed={mode === 'signup'}
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

          {success && (
            <p className={`${styles.notice} sc-ink--green`} role="status">
              <span className={styles.noticeDot} aria-hidden="true">
                &bull;
              </span>
              {success}
            </p>
          )}

          {error && (
            <p className={`${styles.notice} sc-ink--red`} role="alert">
              <span className={styles.noticeDot} aria-hidden="true">
                &bull;
              </span>
              {error}
            </p>
          )}

          {/* Login */}
          {mode === 'login' && (
            <>
              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  className={styles.input}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Your Email Address"
                  required
                  autoComplete="email"
                />
              </div>

              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  className={styles.input}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your Password"
                  required
                  autoComplete="current-password"
                />
              </div>
            </>
          )}

          {/* Signup */}
          {mode === 'signup' && (
            <>
              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="username">
                  Username
                </label>
                <input
                  id="username"
                  type="text"
                  className={styles.input}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="E.G. PokerPro123"
                  required
                  autoComplete="username"
                />
              </div>

              {IS_NATIVE_BUILD && (
                <div className={styles.field}>
                  <label className="sc-label sc-ink--blue" htmlFor="signup-birthday">
                    Date Of Birth
                  </label>
                  <input
                    id="signup-birthday"
                    type="date"
                    className={styles.input}
                    value={birthday}
                    onChange={(e) => setBirthday(e.target.value)}
                    max={latestAdultBirthday(new Date())}
                    required
                    autoComplete="bday"
                  />
                </div>
              )}

              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="signup-email">
                  Email
                </label>
                <input
                  id="signup-email"
                  type="email"
                  className={styles.input}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Your Email Address"
                  required
                  autoComplete="email"
                />
              </div>

              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="signup-password">
                  Password
                </label>
                <input
                  id="signup-password"
                  type="password"
                  className={styles.input}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At Least 8 Characters"
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </div>

              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="confirm-password">
                  Confirm Password
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  className={styles.input}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat Your Password"
                  required
                  autoComplete="new-password"
                />
              </div>

              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="referral-code">
                  Referral Code{' '}
                  <span className={`${styles.optional} sc-ink--muted`}>(Optional)</span>
                </label>
                <input
                  id="referral-code"
                  type="text"
                  className={`${styles.input} ${styles.code}`}
                  value={referralCode}
                  onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                  placeholder="E.G. ABCD1234"
                  autoComplete="off"
                />
              </div>
            </>
          )}

          {/* Password Reset */}
          {mode === 'reset' && (
            <>
              <p className={styles.resetText}>
                Enter Your Email And We'll Send You A Link To Reset Your Password.
              </p>

              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="reset-email">
                  Email
                </label>
                <input
                  id="reset-email"
                  type="email"
                  className={styles.input}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Your Email Address"
                  required
                  autoComplete="email"
                />
              </div>
            </>
          )}

          {/* New Password (after a recovery link). One action, so the console
              takes the flat cap and the action is a lit word on the glass. */}
          {mode === 'update' && (
            <>
              <p className={styles.resetText}>Choose A New Password For Your Account.</p>

              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="new-password">
                  New Password
                </label>
                <input
                  id="new-password"
                  type="password"
                  className={styles.input}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At Least 8 Characters"
                  required
                  autoComplete="new-password"
                />
              </div>

              <div className={styles.field}>
                <label className="sc-label sc-ink--blue" htmlFor="new-password-confirm">
                  Confirm New Password
                </label>
                <input
                  id="new-password-confirm"
                  type="password"
                  className={styles.input}
                  value={newPasswordConfirm}
                  onChange={(e) => setNewPasswordConfirm(e.target.value)}
                  placeholder="Repeat Your New Password"
                  required
                  autoComplete="new-password"
                />
              </div>

              <button
                type="submit"
                className={`${styles.word} ${isLoading ? styles.busy : ''} sc-ink--white`}
                disabled={isLoading}
              >
                {primaryLabel}
              </button>
            </>
          )}
        </SpadeConsole>
      </form>
    </div>
  );
}
