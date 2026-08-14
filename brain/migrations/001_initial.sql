-- VidGen database schema v1
-- Run with: psql $DATABASE_URL < migrations/001_initial.sql

CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  brief        TEXT NOT NULL,
  graph_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',  -- running | waiting | completed | blocked
  cost_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS run_records (
  id                      BIGSERIAL PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES runs(run_id),
  node_id                 TEXT,
  transformation          TEXT NOT NULL,
  transformation_version  TEXT NOT NULL DEFAULT '1',
  inputs                  JSONB NOT NULL DEFAULT '[]',
  output_artifact_id      TEXT,
  status                  TEXT NOT NULL,
  attempt                 INTEGER NOT NULL DEFAULT 1,
  max_attempts            INTEGER NOT NULL DEFAULT 1,
  provider                TEXT,
  model                   TEXT,
  prompt_ref              TEXT,
  usage_json              JSONB,
  confidence_json         JSONB,
  error                   TEXT,
  external_job_id         TEXT,
  detail                  TEXT,
  started_at              TIMESTAMPTZ NOT NULL,
  duration_ms             INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_records_run_id ON run_records(run_id);
CREATE INDEX IF NOT EXISTS idx_run_records_node ON run_records(run_id, node_id);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id     TEXT PRIMARY KEY,  -- sha256:...
  schema_id       TEXT NOT NULL,
  schema_version  TEXT,
  payload_json    JSONB NOT NULL,
  produced_by     JSONB NOT NULL,
  parents         JSONB NOT NULL DEFAULT '[]',
  confidence_json JSONB,
  blobs           JSONB NOT NULL DEFAULT '[]',
  labels          JSONB,
  retained        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_schema ON artifacts(schema_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_retained ON artifacts(retained) WHERE retained = FALSE;

CREATE TABLE IF NOT EXISTS blob_refs (
  uri         TEXT PRIMARY KEY,  -- blob://sha256:...
  role        TEXT NOT NULL,
  media_type  TEXT,
  bytes       INTEGER NOT NULL DEFAULT 0,
  run_id      TEXT,
  retained    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blob_refs_run ON blob_refs(run_id);
CREATE INDEX IF NOT EXISTS idx_blob_refs_retained ON blob_refs(retained) WHERE retained = FALSE;
