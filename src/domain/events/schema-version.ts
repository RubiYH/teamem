export const EVENT_SCHEMA_VERSION = '1.0' as const;

export function isSupportedSchemaVersion(version: string): boolean {
  return version === EVENT_SCHEMA_VERSION;
}
