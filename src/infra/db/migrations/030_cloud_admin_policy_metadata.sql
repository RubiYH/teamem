-- Migration 030: account-opaque Cloud policy metadata for runtime Spaces.
--
-- These fields are resolved by the control plane at provisioning time. Keep
-- runtime storage account-opaque: no OAuth provider IDs, web account IDs, or
-- user emails belong here.

ALTER TABLE spaces ADD COLUMN cloud_plan TEXT;
ALTER TABLE spaces ADD COLUMN cloud_trial_expires_at TEXT;
ALTER TABLE spaces ADD COLUMN cloud_member_limit INTEGER;
ALTER TABLE spaces ADD COLUMN cloud_suspended_at TEXT;
ALTER TABLE spaces ADD COLUMN cloud_suspension_reason TEXT;

UPDATE spaces
   SET cloud_plan = COALESCE(cloud_plan, 'free'),
       cloud_trial_expires_at = COALESCE(
         cloud_trial_expires_at,
         strftime('%Y-%m-%dT%H:%M:%fZ', spaces.created_at, '+14 days')
       ),
       cloud_member_limit = COALESCE(cloud_member_limit, 3)
 WHERE cloud_provisioning_source = 'teamem-cloud'
   AND (cloud_plan IS NULL OR cloud_plan = 'free')
   AND (
     cloud_plan IS NULL
     OR cloud_trial_expires_at IS NULL
     OR cloud_member_limit IS NULL
   );
