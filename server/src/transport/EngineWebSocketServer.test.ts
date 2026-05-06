import { describe, it, expect } from 'vitest';
import { extractBearerToken, parseTableIdFromPath } from './wsHelpers.js';

describe('parseTableIdFromPath', () => {
  it('accepts a well-formed /ws/table/:uuid path', () => {
    const id = parseTableIdFromPath('/ws/table/6e1f8768-3baa-479e-b912-b8736123e840');
    expect(id).toBe('6e1f8768-3baa-479e-b912-b8736123e840');
  });

  it('accepts trailing slash', () => {
    const id = parseTableIdFromPath('/ws/table/6e1f8768-3baa-479e-b912-b8736123e840/');
    expect(id).toBe('6e1f8768-3baa-479e-b912-b8736123e840');
  });

  it('lowercases the uuid', () => {
    const id = parseTableIdFromPath('/ws/table/6E1F8768-3BAA-479E-B912-B8736123E840');
    expect(id).toBe('6e1f8768-3baa-479e-b912-b8736123e840');
  });

  it('rejects non-uuid tail', () => {
    expect(parseTableIdFromPath('/ws/table/not-a-uuid')).toBeNull();
  });

  it('rejects wrong prefix', () => {
    expect(parseTableIdFromPath('/ws/game/6e1f8768-3baa-479e-b912-b8736123e840')).toBeNull();
  });

  it('rejects empty path', () => {
    expect(parseTableIdFromPath('')).toBeNull();
    expect(parseTableIdFromPath(undefined)).toBeNull();
  });

  it('rejects path-traversal attempts', () => {
    expect(parseTableIdFromPath('/ws/table/../admin')).toBeNull();
    expect(
      parseTableIdFromPath('/ws/table/6e1f8768-3baa-479e-b912-b8736123e840/../admin')
    ).toBeNull();
  });
});

describe('extractBearerToken', () => {
  const validJwt = 'eyJhbGciOi.eyJzdWIiOi.signaturepart';

  it('extracts JWT from "bearer, <token>" subprotocol', () => {
    const t = extractBearerToken(`bearer, ${validJwt}`);
    expect(t).toBe(validJwt);
  });

  it('handles case-insensitive bearer keyword', () => {
    const t = extractBearerToken(`Bearer, ${validJwt}`);
    expect(t).toBe(validJwt);
  });

  it('accepts array-form header (some proxies split)', () => {
    const t = extractBearerToken(['bearer', validJwt]);
    expect(t).toBe(validJwt);
  });

  it('returns null when header missing', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null when bearer keyword absent', () => {
    expect(extractBearerToken(validJwt)).toBeNull();
    expect(extractBearerToken(`basic, ${validJwt}`)).toBeNull();
  });

  it('returns null when no token follows bearer', () => {
    expect(extractBearerToken('bearer')).toBeNull();
    expect(extractBearerToken('bearer, ')).toBeNull();
  });

  it('rejects malformed tokens (not three JWT segments)', () => {
    expect(extractBearerToken('bearer, not.a.jwt.tooMany')).toBeNull();
    expect(extractBearerToken('bearer, missing.parts')).toBeNull();
    expect(extractBearerToken('bearer, plain-token')).toBeNull();
  });
});
