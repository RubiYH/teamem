import posthog from 'posthog-js';

const posthogToken = process.env.NEXT_PUBLIC_POSTHOG_TOKEN;
const posthogProxyPath = '/tmem';
const posthogHost =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
const posthogUiHost = posthogHost.includes('eu.')
  ? 'https://eu.posthog.com'
  : 'https://us.posthog.com';

if (posthogToken) {
  posthog.init(posthogToken, {
    api_host: posthogProxyPath,
    ui_host: posthogUiHost,
    defaults: '2026-01-30',
    capture_exceptions: true,
    debug: process.env.NODE_ENV === 'development'
  });
}
