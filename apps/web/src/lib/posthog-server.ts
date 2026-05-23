import 'server-only';

import { PostHog } from 'posthog-node';

const POSTHOG_FLUSH_TIMEOUT_MS = 1_000;

type PostHogServerEvent = {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
};

export async function capturePostHogServerEvent({
  distinctId,
  event,
  properties
}: PostHogServerEvent): Promise<void> {
  const token = process.env.NEXT_PUBLIC_POSTHOG_TOKEN;

  if (!token) {
    return;
  }

  const posthog = new PostHog(token, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0
  });

  posthog.capture({
    distinctId,
    event,
    properties
  });

  await flushPostHogBestEffort(posthog);
}

async function flushPostHogBestEffort(posthog: PostHog): Promise<void> {
  const shutdown = posthog.shutdown().catch((error: unknown) => {
    console.warn('PostHog server capture failed', error);
  });

  await Promise.race([
    shutdown,
    new Promise<void>((resolve) =>
      setTimeout(resolve, POSTHOG_FLUSH_TIMEOUT_MS)
    )
  ]);
}
