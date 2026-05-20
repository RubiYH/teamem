ALTER TABLE cloud_audit_events
  DROP CONSTRAINT IF EXISTS cloud_audit_events_event_type_check;

ALTER TABLE cloud_audit_events
  ADD CONSTRAINT cloud_audit_events_event_type_check
  CHECK (
    event_type IN (
      'cloud_space_create_attempted',
      'cloud_space_create_quota_rejected',
      'cloud_space_create_succeeded',
      'cloud_space_create_failed',
      'cloud_space_suspended',
      'cloud_space_policy_override_attempted',
      'cloud_space_policy_override_succeeded',
      'cloud_space_policy_override_failed',
      'cloud_space_room_code_rotate_attempted',
      'cloud_space_room_code_rotate_succeeded',
      'cloud_space_room_code_rotate_failed',
      'cloud_space_delete_attempted',
      'cloud_space_delete_succeeded',
      'cloud_space_delete_failed'
    )
  );
