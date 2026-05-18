const EXAMPLE_CLOUD_ADMIN_TOKENS = new Set([
  'replace-with-openssl-rand-hex-32',
  'replace-with-runtime-provisioning-token'
]);

export function resolveCloudAdminProvisioningToken(
  env: Record<string, string | undefined>
): string | undefined {
  const token = env.TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN?.trim();
  if (!token) return undefined;
  if (token.length < 32 || EXAMPLE_CLOUD_ADMIN_TOKENS.has(token)) {
    throw new Error(
      'TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN must be a generated service token of at least 32 characters when configured.'
    );
  }
  return token;
}
