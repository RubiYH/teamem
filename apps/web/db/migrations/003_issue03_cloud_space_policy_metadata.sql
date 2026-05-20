ALTER TABLE cloud_spaces
  ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ;

ALTER TABLE cloud_spaces
  ADD COLUMN IF NOT EXISTS member_limit INTEGER CHECK (member_limit IS NULL OR member_limit > 0);

ALTER TABLE cloud_spaces
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

UPDATE cloud_spaces
SET
  trial_expires_at = COALESCE(
    cloud_spaces.trial_expires_at,
    COALESCE(cloud_spaces.requested_at, cloud_spaces.created_at)
      + (active_free_policy.trial_days * INTERVAL '1 day')
  ),
  member_limit = COALESCE(
    cloud_spaces.member_limit,
    active_free_policy.member_limit
  ),
  updated_at = NOW()
FROM (
  SELECT trial_days, member_limit
  FROM cloud_plan_policies
  WHERE plan = 'free'
    AND active = TRUE
  ORDER BY updated_at DESC, created_at DESC, id ASC
  LIMIT 1
) AS active_free_policy
WHERE cloud_spaces.plan = 'free'
  AND cloud_spaces.status <> 'provisioning_failed'
  AND (
    cloud_spaces.trial_expires_at IS NULL
    OR cloud_spaces.member_limit IS NULL
  );
