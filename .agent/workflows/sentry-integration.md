---
description: Complete Sentry.io integration for error tracking and performance monitoring
---

# Sentry.io Integration Skill

This skill provides comprehensive guidance for integrating Sentry.io error tracking and performance monitoring into React/Vite applications.

## When to Use This Skill

- Setting up error tracking and performance monitoring
- Implementing session replay for debugging
- Integrating Sentry with Supabase or other backends
- Configuring release tracking and source maps
- Setting up user feedback and context

## Prerequisites

- Sentry.io account (Team plan recommended: $26/month)
- React application with Vite build system
- Environment variables configured

## Installation

```bash
npm install --save @sentry/react @sentry/vite-plugin
```

## Core Integration Files

### 1. Sentry Initialization (`src/core/SentryInit.ts`)

Create a comprehensive initialization module with:

- Environment-based initialization (skip in development)
- React Router integration for route tracking
- Session replay with privacy controls
- Error filtering (ad blockers, browser extensions, benign errors)
- Performance transaction filtering
- Helper functions for user context, tags, and breadcrumbs

Key features:

```typescript
export function initSentry(); // Main initialization
export function setSentryUser(user); // Set user context
export function clearSentryUser(); // Clear on logout
export function setSentryContext(key, context); // Custom context
export function setSentryTags(tags); // Custom tags
export function captureException(error, context); // Manual error capture
export function captureMessage(message, level); // Manual message capture
export function addBreadcrumb(breadcrumb); // Add debugging breadcrumbs
export function startTransaction(name, op); // Performance tracking
```

### 2. Supabase Integration (`src/core/SupabaseIntegration.ts`)

Create helper functions to track Supabase operations:

```typescript
export function trackSupabaseOperation<T>(table, operation, promise);
export function trackSupabaseQuery<T>(table, operation, query);
```

These wrap Supabase queries to:

- Track query performance
- Capture database errors
- Detect RLS policy violations
- Log slow queries (>1s)

## Environment Variables

Add to `.env.example` and `.env.production.local`:

```bash
# Sentry Error Tracking & Performance Monitoring
VITE_SENTRY_DSN=https://your-sentry-dsn@sentry.io/project-id
SENTRY_AUTH_TOKEN=your-sentry-auth-token
SENTRY_ORG=your-org-name
SENTRY_PROJECT=your-project-name
VITE_APP_VERSION=1.0.0
```

## Vite Configuration

Update `vite.config.ts`:

```typescript
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig({
  plugins: [
    react(),
    process.env.NODE_ENV === 'production' &&
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        sourcemaps: {
          assets: './dist/**',
          ignore: ['node_modules'],
        },
        release: {
          name: `${process.env.SENTRY_PROJECT}@${process.env.npm_package_version}`,
          setCommits: { auto: true },
        },
      }),
  ].filter(Boolean),
  build: {
    sourcemap: true, // Required for Sentry
  },
});
```

## Boot Sequence Integration

In your main entry point (e.g., `src/main.tsx`), initialize Sentry FIRST:

```typescript
import { initSentry } from './core/SentryInit';

async function boot() {
  // PHASE 0: Initialize Sentry (FIRST - before any errors can occur)
  initSentry();

  // ... rest of boot sequence
}

boot();
```

## User Identity Tracking

Integrate with your auth system:

```typescript
// After login
import { setSentryUser } from './core/SentryInit';

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session?.user) {
    setSentryUser({
      id: session.user.id,
      email: session.user.email,
      username: session.user.user_metadata?.username,
    });
  } else if (event === 'SIGNED_OUT') {
    clearSentryUser();
  }
});
```

## Error Boundary Enhancement

Wrap your app with Sentry's error boundary:

```typescript
import * as Sentry from '@sentry/react';

class ErrorBoundary extends Component {
  componentDidCatch(error, errorInfo) {
    Sentry.withScope((scope) => {
      scope.setContext('react', {
        componentStack: errorInfo.componentStack,
      });
      const eventId = Sentry.captureException(error);
      this.setState({ eventId });
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <button onClick={() => Sentry.showReportDialog({ eventId: this.state.eventId })}>
          Report Feedback
        </button>
      );
    }
    return this.props.children;
  }
}

export default Sentry.withErrorBoundary(ErrorBoundary, {
  fallback: <ErrorFallback />,
  showDialog: true,
});
```

## Service-Level Error Tracking

Pattern for all service modules:

```typescript
import * as Sentry from '@sentry/react';
import { trackSupabaseQuery } from '../core/SupabaseIntegration';

export class MyService {
  async getData(id: string) {
    return Sentry.startSpan({ name: 'MyService.getData', op: 'service.call' }, async () => {
      const { data, error } = await trackSupabaseQuery(
        'my_table',
        'select',
        supabase.from('my_table').select('*').eq('id', id)
      );

      if (error) throw error;
      return data;
    });
  }
}
```

## Custom Context and Tags

Set context for specific features:

```typescript
import { setSentryContext, setSentryTags, addBreadcrumb } from './core/SentryInit';

// Set feature context
setSentryContext('club', {
  id: clubId,
  name: clubName,
  member_count: clubData.member_count,
});

// Set tags for filtering
setSentryTags({
  club_id: clubId,
  game_type: 'holdem',
});

// Add breadcrumbs for user actions
addBreadcrumb({
  category: 'game',
  message: 'Player joined table',
  level: 'info',
  data: { player_id: playerId, table_id: tableId },
});
```

## Session Replay Configuration

Privacy-first configuration (already in SentryInit.ts):

- `maskAllText: true` - Mask all text content
- `blockAllMedia: true` - Block images and videos
- `maskAllInputs: true` - Mask form inputs
- `replaysSessionSampleRate: 0.1` - 10% of normal sessions
- `replaysOnErrorSampleRate: 1.0` - 100% of error sessions

## Sentry Dashboard Setup

### 1. Create Organization

- Organization name: `smarter-poker` (or your company name)
- Plan: Team ($26/month) or Business ($80/month)

### 2. Create Projects

- **Project 1**: `club-arena` (Club Arena application)
- **Project 2**: `smarter-poker-hub` (Main World Hub)
- **Project 3**: `diamond-arena` (Diamond Arena)
- Platform: React for all

### 3. Configure Integrations

- **GitHub**: Link repository for commit tracking
- **Slack**: Connect for alert notifications
- **Vercel**: Link for deployment tracking (optional)

### 4. Set Up Alerts

Create alert rules for:

- **Critical Errors**: >100 users affected → Slack + Email
- **Performance Degradation**: Page load >5s → Slack
- **New Issues**: First occurrence → Slack
- **Release Health**: Crash rate >5% → Email

### 5. Configure Source Maps

- Enable automatic source map upload via Vite plugin
- Verify source maps are uploaded after first production build
- Check that stack traces are readable in Sentry dashboard

## Testing the Integration

### 1. Test Error Tracking

```typescript
// Trigger a test error
throw new Error('Sentry test error');
```

Verify in Sentry dashboard:

- Error appears with full stack trace
- Source maps correctly map to original code
- User context is attached
- Breadcrumbs show user journey

### 2. Test Performance Monitoring

Check Sentry Performance tab for:

- Page load transactions
- Route change transactions
- API call spans
- Database query spans

### 3. Test Session Replay

- Trigger an error
- Check that session replay is attached
- Verify privacy controls (text/images masked)

## Production Deployment Checklist

- [ ] Sentry DSN configured in production environment
- [ ] Auth token set for source map uploads
- [ ] Source maps uploading successfully
- [ ] Error filtering working (no spam from ad blockers)
- [ ] User identification working
- [ ] Performance monitoring active
- [ ] Session replay capturing errors
- [ ] Alert rules configured
- [ ] Team members invited to Sentry
- [ ] Slack integration working

## Common Issues and Solutions

### Issue: Source maps not uploading

**Solution**: Ensure `SENTRY_AUTH_TOKEN` is set in CI/CD environment

### Issue: Too many errors from ad blockers

**Solution**: Error filtering already configured in `beforeSend`

### Issue: Performance overhead

**Solution**: Adjust sampling rates:

- Production: `tracesSampleRate: 0.1` (10%)
- Staging: `tracesSampleRate: 1.0` (100%)

### Issue: Session replays not capturing

**Solution**: Check sampling rates and ensure errors are occurring

## Best Practices

1. **Initialize Early**: Call `initSentry()` before any other code
2. **Set User Context**: Always identify users after authentication
3. **Use Breadcrumbs**: Add breadcrumbs for critical user actions
4. **Tag Everything**: Use tags for filtering (club_id, game_type, etc.)
5. **Monitor Performance**: Track critical user flows with custom spans
6. **Privacy First**: Keep privacy controls enabled for session replay
7. **Filter Noise**: Ignore non-actionable errors (ad blockers, extensions)
8. **Release Tracking**: Always tag releases with version numbers

## Cost Management

**Team Plan ($26/month)**:

- Base: 50k errors, 5GB logs, 5M spans, 50 replays/month
- Recommended for: Small to medium teams, <100k monthly users

**Upgrade to Business ($80/month) when**:

- Need 90-day lookback (vs 30-day)
- Require unlimited dashboards
- Need advanced quota management

**Cost Optimization**:

- Adjust sampling rates based on traffic
- Filter out non-actionable errors
- Use prepaid volume for discounts

## Reference Documentation

- [Sentry React Docs](https://docs.sentry.io/platforms/javascript/guides/react/)
- [Performance Monitoring](https://docs.sentry.io/product/performance/)
- [Session Replay](https://docs.sentry.io/product/session-replay/)
- [User Feedback](https://docs.sentry.io/product/user-feedback/)
- [Release Tracking](https://docs.sentry.io/product/releases/)

## Skill Maintenance

This skill should be updated when:

- Sentry SDK major version changes
- New Sentry features are released
- Integration patterns change
- Best practices evolve

**Last Updated**: February 1, 2026
**Sentry SDK Version**: @sentry/react v8.x
