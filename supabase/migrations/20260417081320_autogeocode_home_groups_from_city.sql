-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417081320 "autogeocode_home_groups_from_city"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f6b0c13a4fb9cb43344ec908a5c946fd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- AUTOGEOCODE HOME GROUPS — lookup table + backfill + BEFORE INSERT/UPDATE trigger
-- ============================================================================
-- Goal: every commander_home_groups row should have latitude/longitude populated
-- so /api/public/home-games/discover can emit map-pin coordinates (jittered for
-- privacy by the API layer). We don't need PostGIS or a geocoding API for this
-- — a hardcoded table of the top ~120 US cities covers the vast majority of
-- real home-game locations, and a state-center fallback handles the long tail.
-- ============================================================================

-- 1. City → (lat, lng) lookup. Returns NULL row if not matched.
CREATE OR REPLACE FUNCTION public.geocode_us_city(p_city text, p_state text)
RETURNS TABLE(lat numeric, lng numeric) AS $$
BEGIN
  RETURN QUERY
  WITH cities(city, state, lat, lng) AS (VALUES
    -- Top 120 US cities by population + notable poker metros
    ('New York', 'NY', 40.7128::numeric, -74.0060::numeric),
    ('Los Angeles', 'CA', 34.0522, -118.2437),
    ('Chicago', 'IL', 41.8781, -87.6298),
    ('Houston', 'TX', 29.7604, -95.3698),
    ('Phoenix', 'AZ', 33.4484, -112.0740),
    ('Philadelphia', 'PA', 39.9526, -75.1652),
    ('San Antonio', 'TX', 29.4241, -98.4936),
    ('San Diego', 'CA', 32.7157, -117.1611),
    ('Dallas', 'TX', 32.7767, -96.7970),
    ('San Jose', 'CA', 37.3382, -121.8863),
    ('Austin', 'TX', 30.2672, -97.7431),
    ('Jacksonville', 'FL', 30.3322, -81.6557),
    ('Fort Worth', 'TX', 32.7555, -97.3308),
    ('Columbus', 'OH', 39.9612, -82.9988),
    ('Charlotte', 'NC', 35.2271, -80.8431),
    ('Indianapolis', 'IN', 39.7684, -86.1581),
    ('San Francisco', 'CA', 37.7749, -122.4194),
    ('Seattle', 'WA', 47.6062, -122.3321),
    ('Denver', 'CO', 39.7392, -104.9903),
    ('Washington', 'DC', 38.9072, -77.0369),
    ('Nashville', 'TN', 36.1627, -86.7816),
    ('Oklahoma City', 'OK', 35.4676, -97.5164),
    ('El Paso', 'TX', 31.7619, -106.4850),
    ('Boston', 'MA', 42.3601, -71.0589),
    ('Portland', 'OR', 45.5152, -122.6784),
    ('Las Vegas', 'NV', 36.1699, -115.1398),
    ('Detroit', 'MI', 42.3314, -83.0458),
    ('Memphis', 'TN', 35.1495, -90.0490),
    ('Louisville', 'KY', 38.2527, -85.7585),
    ('Baltimore', 'MD', 39.2904, -76.6122),
    ('Milwaukee', 'WI', 43.0389, -87.9065),
    ('Albuquerque', 'NM', 35.0844, -106.6504),
    ('Tucson', 'AZ', 32.2226, -110.9747),
    ('Fresno', 'CA', 36.7378, -119.7871),
    ('Sacramento', 'CA', 38.5816, -121.4944),
    ('Mesa', 'AZ', 33.4152, -111.8315),
    ('Kansas City', 'MO', 39.0997, -94.5786),
    ('Atlanta', 'GA', 33.7490, -84.3880),
    ('Omaha', 'NE', 41.2565, -95.9345),
    ('Colorado Springs', 'CO', 38.8339, -104.8214),
    ('Raleigh', 'NC', 35.7796, -78.6382),
    ('Long Beach', 'CA', 33.7701, -118.1937),
    ('Virginia Beach', 'VA', 36.8529, -75.9780),
    ('Miami', 'FL', 25.7617, -80.1918),
    ('Oakland', 'CA', 37.8044, -122.2712),
    ('Minneapolis', 'MN', 44.9778, -93.2650),
    ('Tulsa', 'OK', 36.1540, -95.9928),
    ('Bakersfield', 'CA', 35.3733, -119.0187),
    ('Wichita', 'KS', 37.6872, -97.3301),
    ('Arlington', 'TX', 32.7357, -97.1081),
    ('Aurora', 'CO', 39.7294, -104.8319),
    ('Tampa', 'FL', 27.9506, -82.4572),
    ('New Orleans', 'LA', 29.9511, -90.0715),
    ('Cleveland', 'OH', 41.4993, -81.6944),
    ('Anaheim', 'CA', 33.8366, -117.9143),
    ('Honolulu', 'HI', 21.3069, -157.8583),
    ('Santa Ana', 'CA', 33.7455, -117.8677),
    ('Riverside', 'CA', 33.9806, -117.3755),
    ('Corpus Christi', 'TX', 27.8006, -97.3964),
    ('Lexington', 'KY', 38.0406, -84.5037),
    ('Stockton', 'CA', 37.9577, -121.2908),
    ('Henderson', 'NV', 36.0395, -114.9817),
    ('Saint Paul', 'MN', 44.9537, -93.0900),
    ('St. Paul', 'MN', 44.9537, -93.0900),
    ('Cincinnati', 'OH', 39.1031, -84.5120),
    ('St. Louis', 'MO', 38.6270, -90.1994),
    ('Saint Louis', 'MO', 38.6270, -90.1994),
    ('Pittsburgh', 'PA', 40.4406, -79.9959),
    ('Greensboro', 'NC', 36.0726, -79.7920),
    ('Lincoln', 'NE', 40.8136, -96.7026),
    ('Anchorage', 'AK', 61.2181, -149.9003),
    ('Plano', 'TX', 33.0198, -96.6989),
    ('Orlando', 'FL', 28.5383, -81.3792),
    ('Irvine', 'CA', 33.6846, -117.8265),
    ('Newark', 'NJ', 40.7357, -74.1724),
    ('Durham', 'NC', 35.9940, -78.8986),
    ('Chula Vista', 'CA', 32.6401, -117.0842),
    ('Toledo', 'OH', 41.6528, -83.5379),
    ('Fort Wayne', 'IN', 41.0793, -85.1394),
    ('St. Petersburg', 'FL', 27.7676, -82.6403),
    ('Laredo', 'TX', 27.5306, -99.4803),
    ('Jersey City', 'NJ', 40.7178, -74.0431),
    ('Chandler', 'AZ', 33.3062, -111.8413),
    ('Madison', 'WI', 43.0731, -89.4012),
    ('Lubbock', 'TX', 33.5779, -101.8552),
    ('Scottsdale', 'AZ', 33.4942, -111.9261),
    ('Reno', 'NV', 39.5296, -119.8138),
    ('Buffalo', 'NY', 42.8864, -78.8784),
    ('Gilbert', 'AZ', 33.3528, -111.7890),
    ('Glendale', 'AZ', 33.5387, -112.1860),
    ('North Las Vegas', 'NV', 36.1989, -115.1175),
    ('Winston-Salem', 'NC', 36.0999, -80.2442),
    ('Chesapeake', 'VA', 36.7682, -76.2875),
    ('Norfolk', 'VA', 36.8508, -76.2859),
    ('Fremont', 'CA', 37.5485, -121.9886),
    ('Garland', 'TX', 32.9126, -96.6389),
    ('Irving', 'TX', 32.8140, -96.9489),
    ('Hialeah', 'FL', 25.8576, -80.2781),
    ('Richmond', 'VA', 37.5407, -77.4360),
    ('Boise', 'ID', 43.6150, -116.2023),
    ('Spokane', 'WA', 47.6588, -117.4260),
    ('Baton Rouge', 'LA', 30.4515, -91.1871),
    ('Tacoma', 'WA', 47.2529, -122.4443),
    ('San Bernardino', 'CA', 34.1083, -117.2898),
    ('Modesto', 'CA', 37.6391, -120.9969),
    ('Fontana', 'CA', 34.0922, -117.4350),
    ('Des Moines', 'IA', 41.5868, -93.6250),
    ('Moreno Valley', 'CA', 33.9425, -117.2297),
    ('Santa Clarita', 'CA', 34.3917, -118.5426),
    ('Fayetteville', 'NC', 35.0527, -78.8784),
    ('Birmingham', 'AL', 33.5186, -86.8104),
    ('Oxnard', 'CA', 34.1975, -119.1771),
    ('Rochester', 'NY', 43.1566, -77.6088),
    ('Port St. Lucie', 'FL', 27.2730, -80.3582),
    ('Grand Rapids', 'MI', 42.9634, -85.6681),
    ('Huntsville', 'AL', 34.7304, -86.5861),
    ('Salt Lake City', 'UT', 40.7608, -111.8910),
    ('Frisco', 'TX', 33.1507, -96.8236),
    ('Yonkers', 'NY', 40.9312, -73.8987),
    ('Amarillo', 'TX', 35.2220, -101.8313),
    ('Glendale', 'CA', 34.1425, -118.2551),
    ('Huntington Beach', 'CA', 33.6595, -117.9988),
    ('McKinney', 'TX', 33.1972, -96.6397),
    ('Montgomery', 'AL', 32.3792, -86.3077),
    ('Augusta', 'GA', 33.4735, -82.0105),
    ('Akron', 'OH', 41.0814, -81.5190),
    ('Little Rock', 'AR', 34.7465, -92.2896),
    ('Tallahassee', 'FL', 30.4383, -84.2807),
    ('Providence', 'RI', 41.8240, -71.4128),
    ('Knoxville', 'TN', 35.9606, -83.9207),
    ('Grand Prairie', 'TX', 32.7460, -96.9978),
    ('Worcester', 'MA', 42.2626, -71.8023),
    ('Oceanside', 'CA', 33.1959, -117.3795),
    ('Chattanooga', 'TN', 35.0456, -85.3097),
    ('Overland Park', 'KS', 38.9822, -94.6708),
    ('Bridgeport', 'CT', 41.1865, -73.1952),
    ('Fort Lauderdale', 'FL', 26.1224, -80.1373)
  )
  SELECT c.lat, c.lng FROM cities c
  WHERE lower(trim(c.city)) = lower(trim(p_city))
    AND upper(trim(c.state)) = upper(trim(p_state))
  LIMIT 1;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 2. State-center fallback when the city isn't in our table.
CREATE OR REPLACE FUNCTION public.geocode_us_state_center(p_state text)
RETURNS TABLE(lat numeric, lng numeric) AS $$
BEGIN
  RETURN QUERY
  WITH states(state, lat, lng) AS (VALUES
    ('AL', 32.806671::numeric, -86.791130::numeric),
    ('AK', 61.370716, -152.404419),
    ('AZ', 33.729759, -111.431221),
    ('AR', 34.969704, -92.373123),
    ('CA', 36.116203, -119.681564),
    ('CO', 39.059811, -105.311104),
    ('CT', 41.597782, -72.755371),
    ('DE', 39.318523, -75.507141),
    ('DC', 38.897438, -77.026817),
    ('FL', 27.766279, -81.686783),
    ('GA', 33.040619, -83.643074),
    ('HI', 21.094318, -157.498337),
    ('ID', 44.240459, -114.478828),
    ('IL', 40.349457, -88.986137),
    ('IN', 39.849426, -86.258278),
    ('IA', 42.011539, -93.210526),
    ('KS', 38.526600, -96.726486),
    ('KY', 37.668140, -84.670067),
    ('LA', 31.169546, -91.867805),
    ('ME', 44.693947, -69.381927),
    ('MD', 39.063946, -76.802101),
    ('MA', 42.230171, -71.530106),
    ('MI', 43.326618, -84.536095),
    ('MN', 45.694454, -93.900192),
    ('MS', 32.741646, -89.678696),
    ('MO', 38.456085, -92.288368),
    ('MT', 46.921925, -110.454353),
    ('NE', 41.125370, -98.268082),
    ('NV', 38.313515, -117.055374),
    ('NH', 43.452492, -71.563896),
    ('NJ', 40.298904, -74.521011),
    ('NM', 34.840515, -106.248482),
    ('NY', 42.165726, -74.948051),
    ('NC', 35.630066, -79.806419),
    ('ND', 47.528912, -99.784012),
    ('OH', 40.388783, -82.764915),
    ('OK', 35.565342, -96.928917),
    ('OR', 44.572021, -122.070938),
    ('PA', 40.590752, -77.209755),
    ('RI', 41.680893, -71.511780),
    ('SC', 33.856892, -80.945007),
    ('SD', 44.299782, -99.438828),
    ('TN', 35.747845, -86.692345),
    ('TX', 31.054487, -97.563461),
    ('UT', 40.150032, -111.862434),
    ('VT', 44.045876, -72.710686),
    ('VA', 37.769337, -78.169968),
    ('WA', 47.400902, -121.490494),
    ('WV', 38.491226, -80.954453),
    ('WI', 44.268543, -89.616508),
    ('WY', 42.755966, -107.302490)
  )
  SELECT s.lat, s.lng FROM states s WHERE upper(trim(s.state)) = upper(trim(p_state)) LIMIT 1;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 3. Backfill the existing groups that have city+state but no coords.
-- City match first; fall back to state center.
WITH resolved AS (
  SELECT
    g.id,
    coalesce((SELECT lat FROM public.geocode_us_city(g.city, g.state)),
             (SELECT lat FROM public.geocode_us_state_center(g.state))) AS lat,
    coalesce((SELECT lng FROM public.geocode_us_city(g.city, g.state)),
             (SELECT lng FROM public.geocode_us_state_center(g.state))) AS lng
  FROM public.commander_home_groups g
  WHERE g.latitude IS NULL
    AND g.state IS NOT NULL
    AND trim(g.state) <> ''
)
UPDATE public.commander_home_groups g
SET latitude = r.lat, longitude = r.lng, updated_at = now()
FROM resolved r
WHERE g.id = r.id AND r.lat IS NOT NULL;

-- 4. Trigger so that any new INSERT or city/state UPDATE gets auto-geocoded.
-- Fires BEFORE INSERT/UPDATE OF city,state — only overwrites when latitude
-- is NULL, so an explicit lat/lng in the payload is always respected.
CREATE OR REPLACE FUNCTION public.autogeocode_home_group() RETURNS TRIGGER AS $$
DECLARE
  rec record;
BEGIN
  IF NEW.latitude IS NULL AND NEW.state IS NOT NULL AND trim(NEW.state) <> '' THEN
    -- Try the city table first.
    IF NEW.city IS NOT NULL AND trim(NEW.city) <> '' THEN
      SELECT lat, lng INTO rec FROM public.geocode_us_city(NEW.city, NEW.state);
      IF rec.lat IS NOT NULL THEN
        NEW.latitude  := rec.lat;
        NEW.longitude := rec.lng;
        RETURN NEW;
      END IF;
    END IF;
    -- Fallback to state center.
    SELECT lat, lng INTO rec FROM public.geocode_us_state_center(NEW.state);
    IF rec.lat IS NOT NULL THEN
      NEW.latitude  := rec.lat;
      NEW.longitude := rec.lng;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_autogeocode_home_group ON public.commander_home_groups;
CREATE TRIGGER trg_autogeocode_home_group
  BEFORE INSERT OR UPDATE OF city, state ON public.commander_home_groups
  FOR EACH ROW EXECUTE FUNCTION public.autogeocode_home_group();
