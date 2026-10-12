/**
 * Is this request a stranger arriving from the internet?
 *
 * The engine listens on localhost. Everything public reaches it through Caddy
 * (server/Caddyfile: `reverse_proxy localhost:8080`), and Caddy stamps every
 * request it forwards with `X-Forwarded-For`. The on-box monitoring stack
 * scrapes the engine directly and carries no such header.
 *
 * So a request with the header and without the internal key came from outside
 * and proved nothing about itself. The telemetry routes use this to decide
 * what a stranger may read: Dan, 2026-09-02, "NOBODY SHOULD EVER EVER EVER BE
 * ABLE TO LOOK AT OUR CODE OR USE A DEVELOPER TOOL AND FIND THIS OUT" - and a
 * seated player who can read how many seats are human knows which of their
 * opponents are horses (launch audit 2026-10-05).
 */
import type { IncomingMessage } from 'http';

export function arrivedThroughThePublicProxy(req: Pick<IncomingMessage, 'headers'>): boolean {
  const forwarded = req.headers['x-forwarded-for'];
  return Array.isArray(forwarded) ? forwarded.length > 0 : typeof forwarded === 'string';
}

/**
 * Prometheus families that say how the seats divide between humans and horses.
 * Matched on the family name, so a labelled series and its HELP/TYPE lines go
 * together. Horse decision-worker health (queue depth, compute time) says
 * nothing about who is seated and is not here.
 */
const SEAT_MIX_FAMILY =
  /^poker_(?:humans_seated|horses_seated|horses_seated_in_database|horses_in_decided_games|tables_with_humans|tables_with_horses|human_tables_ms_since_progress_max|spin_human_[a-z_]+|stats_human_[a-z_]+)$/;

export function isSeatMixFamily(name: string): boolean {
  return SEAT_MIX_FAMILY.test(name);
}

/** Drop every seat-mix family (samples and their HELP/TYPE headers) from exposition text. */
export function withoutSeatMix(exposition: string): string {
  return exposition
    .split('\n')
    .filter((line) => {
      if (line.startsWith('# HELP ') || line.startsWith('# TYPE ')) {
        return !isSeatMixFamily(line.split(' ')[2] ?? '');
      }
      if (!line || line.startsWith('#')) return true;
      return !isSeatMixFamily(line.split(/[{ ]/)[0] ?? '');
    })
    .join('\n');
}
