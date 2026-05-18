import { describe, expect, it } from 'bun:test';
import { resolveCloudAdminProvisioningToken } from '../../../src/server/cloud-admin-token.js';

describe('resolveCloudAdminProvisioningToken', () => {
  it('leaves cloud-admin provisioning unconfigured when the token is missing', () => {
    expect(resolveCloudAdminProvisioningToken({})).toBeUndefined();
    expect(
      resolveCloudAdminProvisioningToken({
        TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN: ' '
      })
    ).toBeUndefined();
  });

  it('rejects configured weak service tokens', () => {
    expect(() =>
      resolveCloudAdminProvisioningToken({
        TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN: 'short-token'
      })
    ).toThrow('TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN must be a generated');

    expect(() =>
      resolveCloudAdminProvisioningToken({
        TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN:
          'replace-with-openssl-rand-hex-32'
      })
    ).toThrow('TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN must be a generated');
  });

  it('returns trimmed strong service tokens', () => {
    expect(
      resolveCloudAdminProvisioningToken({
        TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN:
          '  runtime-service-token-32bytes-ok  '
      })
    ).toBe('runtime-service-token-32bytes-ok');
  });
});
