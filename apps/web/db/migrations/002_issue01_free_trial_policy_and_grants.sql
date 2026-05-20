CREATE TABLE IF NOT EXISTS cloud_plan_policies (
  id TEXT PRIMARY KEY,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'team', 'enterprise')),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  trial_days INTEGER NOT NULL CHECK (trial_days >= 0),
  member_limit INTEGER NOT NULL CHECK (member_limit > 0),
  quota_mode TEXT NOT NULL CHECK (quota_mode IN ('one_lifetime_space')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO cloud_plan_policies (
  id,
  plan,
  active,
  trial_days,
  member_limit,
  quota_mode
)
VALUES (
  'policy_free_trial_v1',
  'free',
  TRUE,
  14,
  3,
  'one_lifetime_space'
)
ON CONFLICT (id)
DO UPDATE SET
  plan = EXCLUDED.plan,
  active = EXCLUDED.active,
  trial_days = EXCLUDED.trial_days,
  member_limit = EXCLUDED.member_limit,
  quota_mode = EXCLUDED.quota_mode,
  updated_at = NOW();

CREATE UNIQUE INDEX IF NOT EXISTS cloud_plan_policies_one_active_free
  ON cloud_plan_policies(plan)
  WHERE plan = 'free'
    AND active = TRUE;

CREATE TABLE IF NOT EXISTS cloud_free_plan_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES cloud_plan_policies(id),
  accepted_cloud_space_id TEXT NOT NULL UNIQUE REFERENCES cloud_spaces(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_free_plan_grants_one_non_voided_per_account
  ON cloud_free_plan_grants(account_id)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS cloud_free_plan_grants_account_created_idx
  ON cloud_free_plan_grants(account_id, created_at DESC);

INSERT INTO cloud_free_plan_grants (
  id,
  account_id,
  policy_id,
  accepted_cloud_space_id,
  granted_at,
  voided_at,
  void_reason,
  created_at,
  updated_at
)
SELECT
  'fpg_backfill_' || ranked_spaces.id,
  ranked_spaces.owner_account_id,
  active_free_policy.id,
  ranked_spaces.id,
  ranked_spaces.requested_at,
  NULL,
  NULL,
  ranked_spaces.created_at,
  NOW()
FROM (
  SELECT
    cloud_spaces.*,
    ROW_NUMBER() OVER (
      PARTITION BY owner_account_id
      ORDER BY requested_at ASC, created_at ASC, id ASC
    ) AS account_free_space_rank
  FROM cloud_spaces
  WHERE plan = 'free'
    AND status <> 'provisioning_failed'
) AS ranked_spaces
JOIN cloud_plan_policies AS active_free_policy
  ON active_free_policy.plan = 'free'
  AND active_free_policy.active = TRUE
WHERE ranked_spaces.account_free_space_rank = 1
  AND NOT EXISTS (
    SELECT 1
    FROM cloud_free_plan_grants AS existing_grant
    WHERE existing_grant.account_id = ranked_spaces.owner_account_id
      AND existing_grant.voided_at IS NULL
  )
ON CONFLICT DO NOTHING;
