# Independent public-history fixture IDs

The isolated PostgreSQL history proof inserted its 20,000-row skew sample and its later 100,000-row sparse-context sample into the same synthetic UUID range. The second insert failed on the primary key before the covering-index assertions ran. Give the sparse sample its own UUID range; keep all sample sizes, query assertions, privacy checks and runtime SQL unchanged.

Validation: the actual PostgreSQL 17 fixture completed all 121 assertions, including bounded history reads, exact prior-reader compatibility, card exclusion and covering-index access. No production database changes.
