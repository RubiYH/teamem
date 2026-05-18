import 'server-only';

import { nextCookies } from 'better-auth/next-js';
import { createTeamemCloudAuth } from './auth-core';

type TeamemCloudAuth = ReturnType<typeof createTeamemCloudAuth>;

let cachedAuth: TeamemCloudAuth | undefined;

export function getAuth(): TeamemCloudAuth {
  if (cachedAuth) {
    return cachedAuth;
  }

  cachedAuth = createTeamemCloudAuth([nextCookies()]);
  return cachedAuth;
}

export const auth = {
  get api() {
    return getAuth().api;
  },
  handler(request: Request) {
    return getAuth().handler(request);
  }
} satisfies Pick<TeamemCloudAuth, 'api' | 'handler'>;
