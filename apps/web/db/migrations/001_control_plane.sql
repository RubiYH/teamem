CREATE TABLE IF NOT EXISTS cloud_accounts (
  id TEXT PRIMARY KEY,
  better_auth_user_id TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cloud_spaces (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'team', 'enterprise')),
  status TEXT NOT NULL CHECK (
    status IN (
      'provisioning_pending',
      'active',
      'suspended',
      'delete_pending',
      'deleted',
      'provisioning_failed'
    )
  ),
  runtime_space_id TEXT,
  runtime_server_url TEXT,
  room_code_display_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_at TIMESTAMPTZ NOT NULL,
  provisioned_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_spaces_one_active_free_space_per_account
  ON cloud_spaces(owner_account_id)
  WHERE plan = 'free'
    AND status IN ('provisioning_pending', 'active', 'delete_pending');

CREATE INDEX IF NOT EXISTS cloud_spaces_owner_account_status_idx
  ON cloud_spaces(owner_account_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS cloud_audit_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  cloud_space_id TEXT REFERENCES cloud_spaces(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'cloud_space_create_attempted',
      'cloud_space_create_quota_rejected',
      'cloud_space_create_succeeded',
      'cloud_space_create_failed',
      'cloud_space_room_code_rotate_attempted',
      'cloud_space_room_code_rotate_succeeded',
      'cloud_space_room_code_rotate_failed',
      'cloud_space_delete_attempted',
      'cloud_space_delete_succeeded',
      'cloud_space_delete_failed'
    )
  ),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cloud_audit_events_account_created_idx
  ON cloud_audit_events(account_id, created_at DESC);
