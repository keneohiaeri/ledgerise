-- Durable posting file exchange and scoped API keys for outbound integrations.

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_keys_operator_enabled_idx
  ON api_keys (operator_id, enabled, created_at DESC);

ALTER TABLE posting_batches
  ADD COLUMN idempotency_key text,
  ADD COLUMN created_by_api_key_id uuid REFERENCES api_keys(id);

CREATE UNIQUE INDEX posting_batches_operator_adapter_idempotency_idx
  ON posting_batches (operator_id, adapter_name, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE posting_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  posting_batch_id uuid NOT NULL REFERENCES posting_batches(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  filename text NOT NULL,
  content bytea NOT NULL,
  checksum_sha256 text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  row_count integer NOT NULL CHECK (row_count >= 0),
  created_by_api_key_id uuid REFERENCES api_keys(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, posting_batch_id)
);

CREATE INDEX posting_artifacts_operator_created_idx
  ON posting_artifacts (operator_id, created_at DESC);

CREATE TABLE posting_artifact_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  posting_artifact_id uuid NOT NULL REFERENCES posting_artifacts(id) ON DELETE CASCADE,
  posting_batch_id uuid NOT NULL REFERENCES posting_batches(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES api_keys(id),
  user_agent text,
  remote_addr text,
  downloaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX posting_artifact_downloads_artifact_idx
  ON posting_artifact_downloads (posting_artifact_id, downloaded_at DESC);

CREATE INDEX posting_artifact_downloads_operator_idx
  ON posting_artifact_downloads (operator_id, downloaded_at DESC);
