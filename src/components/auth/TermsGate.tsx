import { useState, useEffect } from 'react';
import { useUserStore } from '../../stores/useUserStore';
import './TermsGate.css';

interface TermsGateProps {
    children: React.ReactNode;
    onAccept?: () => void;
}

const TERMS_STORAGE_KEY = 'club_arena_tos_accepted';
const HUB_SESSION_KEY = 'smarter_poker_session';

export default function TermsGate({ children, onAccept }: TermsGateProps) {
    const [hasAccepted, setHasAccepted] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const { user, setUser } = useUserStore();

    useEffect(() => {
        checkAuthAndTerms();
    }, []);

    const checkAuthAndTerms = async () => {
        setIsLoading(true);

        // 1. Check for SSO session from Hub
        const sessionValid = await verifyHubSession();
        setIsAuthenticated(sessionValid);

        if (!sessionValid) {
            setIsLoading(false);
            return;
        }

        // 2. Check if TOS already accepted
        const tosAccepted = localStorage.getItem(TERMS_STORAGE_KEY);
        if (tosAccepted === 'true') {
            setHasAccepted(true);
        }

        setIsLoading(false);
    };

    const verifyHubSession = async (): Promise<boolean> => {
        // Check for existing session token from Hub
        const hubSession = localStorage.getItem(HUB_SESSION_KEY) ||
            sessionStorage.getItem(HUB_SESSION_KEY);

        // Check URL params for SSO handshake
        const urlParams = new URLSearchParams(window.location.search);
        const ssoToken = urlParams.get('sso_token');

        if (ssoToken) {
            // Validate SSO token and create session
            try {
                // In production, this would validate with the Hub API
                const sessionData = await validateSSOToken(ssoToken);
                if (sessionData) {
                    localStorage.setItem(HUB_SESSION_KEY, JSON.stringify(sessionData));
                    setUser(sessionData.user);
                    // Clean URL
                    window.history.replaceState({}, '', window.location.pathname);
                    return true;
                }
            } catch (error) {
                console.error('SSO validation failed:', error);
            }
        }

        if (hubSession) {
            try {
                const session = JSON.parse(hubSession);
                if (session.expires_at > Date.now()) {
                    setUser(session.user);
                    return true;
                }
            } catch {
                localStorage.removeItem(HUB_SESSION_KEY);
            }
        }

        // Demo mode fallback - auto-authenticate for development
        if (import.meta.env.DEV) {
            const demoUser = {
                id: 'demo-user-001',
                username: 'DemoPlayer',
                avatar_url: null,
                chip_balance: 10000,
            };
            setUser(demoUser);
            return true;
        }

        return false;
    };

    const validateSSOToken = async (token: string) => {
        // In production: POST to Hub API to validate token
        // For now, decode and trust the token (dev mode)
        try {
            // Simulated token validation
            return {
                user: {
                    id: 'user-from-hub',
                    username: 'HubUser',
                    avatar_url: null,
                    chip_balance: 5000,
                },
                expires_at: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
            };
        } catch {
            return null;
        }
    };

    const handleAcceptTerms = () => {
        localStorage.setItem(TERMS_STORAGE_KEY, 'true');
        setHasAccepted(true);
        onAccept?.();
    };

    const handleDecline = () => {
        // Redirect back to Hub
        window.location.href = 'https://smarter.poker/hub';
    };

    // Loading state
    if (isLoading) {
        return (
            <div className="terms-gate loading">
                <div className="loader-spinner" />
                <p>Connecting to Club Arena...</p>
            </div>
        );
    }

    // Not authenticated - redirect to Hub
    if (!isAuthenticated) {
        return (
            <div className="terms-gate auth-required">
                <div className="auth-card">
                    <div className="club-logo">♠</div>
                    <h2>Club Arena</h2>
                    <p>Please sign in through Smarter.Poker Hub to access Club Arena.</p>
                    <a href="https://smarter.poker/hub" className="btn btn-primary">
                        Go to Hub
                    </a>
                </div>
            </div>
        );
    }

    // Terms not accepted - show TOS
    if (!hasAccepted) {
        return (
            <div className="terms-gate">
                <div className="terms-modal">
                    <div className="terms-header">
                        <div className="club-logo">♠</div>
                        <h1>Welcome to Club Arena</h1>
                        <p className="subtitle">Please review and accept our Terms of Service</p>
                    </div>

                    <div className="terms-content">
                        <h3>Terms of Service</h3>
                        <div className="terms-scroll">
                            <h4>1. Play Chips Only</h4>
                            <p>
                                Club Arena uses <strong>PLAY CHIPS ONLY</strong>. No real money is
                                involved in any games on this platform. Play chips have no real-world
                                monetary value and cannot be exchanged for cash or prizes.
                            </p>

                            <h4>2. Entertainment Purpose</h4>
                            <p>
                                This platform is designed for entertainment and skill development
                                purposes only. By using Club Arena, you acknowledge that you are
                                playing for fun and practice, not for financial gain.
                            </p>

                            <h4>3. Age Requirement</h4>
                            <p>
                                You must be at least 18 years old to use Club Arena. By accepting
                                these terms, you confirm that you meet this age requirement.
                            </p>

                            <h4>4. Fair Play</h4>
                            <p>
                                You agree to play fairly and not use any automated tools, bots,
                                or other software to gain an unfair advantage. Collusion with
                                other players is strictly prohibited.
                            </p>

                            <h4>5. Privacy</h4>
                            <p>
                                Your game data and statistics are stored to provide you with
                                features like hand history and performance tracking. We respect
                                your privacy and do not share personal information with third parties.
                            </p>

                            <h4>6. Responsible Gaming</h4>
                            <p>
                                While this is a play-chip platform, we encourage responsible gaming
                                habits. Take breaks and remember that this is for entertainment only.
                            </p>
                        </div>
                    </div>

                    <div className="terms-footer">
                        <p className="agreement-text">
                            By clicking "Accept & Enter", you agree to our Terms of Service
                            and acknowledge that Club Arena uses play chips only with no real
                            monetary value.
                        </p>
                        <div className="terms-actions">
                            <button className="btn btn-ghost" onClick={handleDecline}>
                                Decline
                            </button>
                            <button className="btn btn-primary" onClick={handleAcceptTerms}>
                                Accept & Enter
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Authenticated and accepted - render children
    return <>{children}</>;
}

export { TermsGate };
