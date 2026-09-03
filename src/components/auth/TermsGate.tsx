import './TermsGate.css';

interface TermsGateProps {
  children: React.ReactNode;
  onAccept?: () => void;
}

/**
 * TermsGate — Passthrough wrapper for future TOS acceptance flow.
 * When TOS enforcement is enabled, this will block rendering until
 * the user accepts the current Terms of Service version.
 */
export default function TermsGate({ children }: TermsGateProps) {
  return <>{children}</>;
}

export { TermsGate };
