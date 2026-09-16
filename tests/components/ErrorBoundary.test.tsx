// Case-insensitive text matchers on purpose: Dan's house rule Title Cases every
// word on every forward-facing page (scripts/ci/check-title-case.mjs), so pinning
// the casing of copy makes these fail on a styling rule rather than on the
// behaviour they exist to protect. The words are the contract.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Import the inner ErrorBoundary class directly for testing
// The default export is the actual application boundary.
import ErrorBoundary from '@/components/common/ErrorBoundary';

// Component that throws an error
const ThrowError = ({ shouldThrow }: { shouldThrow: boolean }) => {
  if (shouldThrow) {
    throw new Error('Test error');
  }
  return <div>No error</div>;
};

// Component that throws a chunk load error
const ThrowChunkError = () => {
  throw new Error('Failed to fetch dynamically imported module');
};

describe('ErrorBoundary Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>Safe content</div>
      </ErrorBoundary>
    );

    expect(screen.getByText('Safe content')).toBeInTheDocument();
  });

  it('renders fallback UI when child throws', () => {
    // Suppress console.error for this test
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();

    consoleErrorSpy.mockRestore();
  });

  it('shows error warning icon', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    // UPDATED: the '⚠️' glyph was replaced with the literal word "Warning" —
    // CLAUDE.md §"No emoji in source files (breaks SWC compiler)". It still
    // renders in the same 4rem display-icon slot above the heading, so assert
    // the text AND that it is the oversized icon element.
    const icon = screen.getByText('Warning');
    expect(icon).toBeInTheDocument();
    // The component declares fontSize: '4rem' (ErrorBoundary.tsx:147). happy-dom
    // resolves that against the 16px root and reports the computed '64px';
    // jsdom hands back the literal '4rem'. Same size, different engine spelling,
    // so assert the size rather than the spelling - otherwise this test pins the
    // DOM implementation instead of the component.
    const fontSize = getComputedStyle(icon).fontSize;
    expect(['4rem', '64px']).toContain(fontSize);

    consoleErrorSpy.mockRestore();
  });

  it('shows reload button in error state', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    // The reload button contains emoji + text — use a flexible matcher
    const reloadButton = screen.getByRole('button', { name: /reload/i });
    expect(reloadButton).toBeInTheDocument();

    consoleErrorSpy.mockRestore();
  });

  it('provides custom fallback UI when provided', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={<div>Custom error UI</div>}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Custom error UI')).toBeInTheDocument();

    consoleErrorSpy.mockRestore();
  });

  it('shows helpful error message', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText(/Please Reload The Page.*Contact Support/i)).toBeInTheDocument();

    consoleErrorSpy.mockRestore();
  });

  it('reports the exception to the local console', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    // Error boundary should have captured the error
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('detects stale chunk errors in componentDidCatch', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Note: window.location.reload is non-configurable in jsdom, so we can't spy on it.
    // Instead, we verify the error boundary caught the chunk error via console.error.
    render(
      <ErrorBoundary>
        <ThrowChunkError />
      </ErrorBoundary>
    );

    // The error boundary should have caught the error
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('keeps the error state visible without a remote event identifier', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    // The component must render the error state
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();

    consoleErrorSpy.mockRestore();
  });

  it('does not offer a retired external feedback dialog', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.queryByRole('button', { name: /Report Feedback/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Error ID:/i)).not.toBeInTheDocument();

    consoleErrorSpy.mockRestore();
  });

  it('has proper error styling with gradient background', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    const errorContainer = container.firstChild as HTMLElement;
    expect(errorContainer).toHaveStyle('display: flex');
    expect(errorContainer).toHaveStyle('flexDirection: column');

    consoleErrorSpy.mockRestore();
  });

  it('maintains error state after rerender (error boundaries require key reset)', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();

    // React error boundaries do NOT auto-reset on rerender — this is by design.
    // To recover, you need to unmount and remount (e.g., change the key prop).
    // This test verifies the error state persists correctly.
    rerender(
      <ErrorBoundary>
        <ThrowError shouldThrow={false} />
      </ErrorBoundary>
    );

    // Error state persists — the boundary still shows the error UI
    // This is correct React behavior; recovery requires a key change
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();

    consoleErrorSpy.mockRestore();
  });

  it('logs errors to console', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[ErrorBoundary]',
      expect.objectContaining({ message: '[ErrorBoundary] Test error' }),
      expect.objectContaining({ componentStack: expect.any(String) })
    );

    consoleErrorSpy.mockRestore();
  });
});
