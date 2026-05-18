-- Migration 027: cloud-admin provisioning metadata for runtime Spaces.
--
-- Stores only opaque control-plane correlation data. Do not add OAuth
-- provider IDs, web account IDs, or user emails to runtime metadata.

ALTER TABLE spaces ADD COLUMN cloud_provisioning_source TEXT;
ALTER TABLE spaces ADD COLUMN cloud_control_plane_space_id TEXT;
ALTER TABLE spaces ADD COLUMN cloud_provisioning_request_id TEXT;
ALTER TABLE spaces ADD COLUMN cloud_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_control_plane_space
  ON spaces(cloud_control_plane_space_id)
  WHERE cloud_control_plane_space_id IS NOT NULL AND disbanded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_idempotency_key
  ON spaces(cloud_idempotency_key)
  WHERE cloud_idempotency_key IS NOT NULL AND disbanded_at IS NULL;

-- Cloud create correlations must remain durable after runtime soft-delete so
-- late control-plane retries cannot recreate a deleted runtime Space.
CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_control_plane_space_durable
  ON spaces(cloud_control_plane_space_id)
  WHERE cloud_control_plane_space_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_idempotency_key_durable
  ON spaces(cloud_idempotency_key)
  WHERE cloud_idempotency_key IS NOT NULL;
