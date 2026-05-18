import 'server-only';

import { Pool } from 'pg';

type TeamemCloudPoolConfig = {
  connectionString: string;
  ssl?: {
    ca: string;
    rejectUnauthorized: true;
  };
};

export function createTeamemCloudPostgresPool(
  connectionString: string,
  caCertificate = process.env.SUPABASE_POSTGRES_CA_CERT
): Pool {
  const normalizedCa = normalizeCaCertificate(caCertificate);
  const config: TeamemCloudPoolConfig = {
    connectionString: normalizedCa
      ? stripPostgresSslQueryParams(connectionString)
      : connectionString
  };

  if (normalizedCa) {
    config.ssl = {
      ca: normalizedCa,
      rejectUnauthorized: true
    };
  }

  return new Pool(config);
}

function normalizeCaCertificate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.includes('\\n') ? trimmed.replaceAll('\\n', '\n') : trimmed;
}

function stripPostgresSslQueryParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('sslcert');
    url.searchParams.delete('sslkey');
    url.searchParams.delete('sslrootcert');
    return url.toString();
  } catch {
    return connectionString;
  }
}
