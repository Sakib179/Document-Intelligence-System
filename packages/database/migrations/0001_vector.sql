-- Up Migration
CREATE EXTENSION IF NOT EXISTS vector;

-- Down Migration
-- The extension may predate this application or serve other schemas. Keep it.
SELECT 1;
