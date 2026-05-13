export type AppConfig = {
  nodeEnv: string;
  logLevel: string;
  repoId: string;
  dbUrl: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    logLevel: env.TEAMEM_LOG_LEVEL ?? 'info',
    repoId: env.TEAMEM_REPO_ID ?? 'teamem-poc',
    dbUrl: env.TEAMEM_DB_URL ?? 'file:./data/teamem.db'
  };
}
