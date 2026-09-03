-- ═══════════════════════════════════════════════════════════════════════════════
-- Set logo_url for Club JAQK and Midway Union
-- ═══════════════════════════════════════════════════════════════════════════════

UPDATE clubs
SET logo_url = '/hub/club-arena/images/club-jaqk-logo.jpg'
WHERE id = 'a0000000-0000-0000-0000-000000000001';

UPDATE clubs
SET logo_url = '/hub/club-arena/images/midway-union-logo.jpg'
WHERE id = 'fade0000-0000-0000-0000-000000000001';
