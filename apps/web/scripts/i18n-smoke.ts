import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

type PublicPageExpectation = {
  path: string;
  lang: 'en' | 'ko';
  title: string;
  description: string;
  canonical: string;
  alternates: Record<'en' | 'ko', string>;
};

const cwd = process.cwd();

async function main() {
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startNextServer(port, baseUrl);

  try {
    await waitForServer(baseUrl);
    await verifyPublicPage(baseUrl, {
      path: '/en',
      lang: 'en',
      title: 'Teamem Cloud | Managed team memory',
      description:
        'Create a hosted Teamem Space for Claude Code teams and keep claims, briefings, decisions, discussions, and Space Rules in sync without self-hosting.',
      canonical: `${baseUrl}/en`,
      alternates: { en: `${baseUrl}/en`, ko: `${baseUrl}/ko` }
    });
    await verifyPublicPage(baseUrl, {
      path: '/ko',
      lang: 'ko',
      title: 'Teamem Cloud | 관리형 팀 메모리',
      description:
        'Claude Code 팀이 작업 맥락을 공유하고, 코드 수정 범위를 조율하고, 주요 결정사항들을 기록할 수 있는 호스팅 Teamem Space를 만듭니다.',
      canonical: `${baseUrl}/ko`,
      alternates: { en: `${baseUrl}/en`, ko: `${baseUrl}/ko` }
    });
    await verifyPublicPage(baseUrl, {
      path: '/en/login',
      lang: 'en',
      title: 'Sign in to Teamem Cloud',
      description:
        'Sign in to Teamem Cloud with OAuth while keeping runtime Teamem member identity separate from your web account.',
      canonical: `${baseUrl}/en/login`,
      alternates: { en: `${baseUrl}/en/login`, ko: `${baseUrl}/ko/login` }
    });
    await verifyPublicPage(baseUrl, {
      path: '/ko/login',
      lang: 'ko',
      title: 'Teamem Cloud 로그인',
      description:
        'Teamem 런타임 멤버 이름과 별개로, 웹 계정으로 Teamem Cloud에 로그인합니다.',
      canonical: `${baseUrl}/ko/login`,
      alternates: { en: `${baseUrl}/en/login`, ko: `${baseUrl}/ko/login` }
    });
    await verifyDashboardRedirect(baseUrl, '/en/dashboard', '/en/login');
    await verifyDashboardRedirect(baseUrl, '/ko/dashboard', '/ko/login');
    await verifyRootLocaleRedirect(baseUrl, undefined, '/en');
    await verifyRootLocaleRedirect(baseUrl, 'NEXT_LOCALE=en', '/en');
    await verifyRootLocaleRedirect(baseUrl, 'NEXT_LOCALE=ko', '/ko');
  } finally {
    server.kill('SIGTERM');
  }

  console.log('Teamem Cloud i18n smoke passed');
}

function startNextServer(
  port: number,
  baseUrl: string
): ChildProcessWithoutNullStreams {
  const server = spawn(
    process.execPath,
    [join(cwd, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port)],
    {
      cwd,
      env: {
        ...process.env,
        TEAMEM_CLOUD_APP_URL: baseUrl,
        BETTER_AUTH_URL: baseUrl,
        BETTER_AUTH_SECRET:
          process.env.BETTER_AUTH_SECRET ?? 'i18n-smoke-secret',
        GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? 'i18n-smoke-client',
        GITHUB_CLIENT_SECRET:
          process.env.GITHUB_CLIENT_SECRET ?? 'i18n-smoke-secret',
        SUPABASE_POSTGRES_URL:
          process.env.SUPABASE_POSTGRES_URL ??
          'postgres://teamem:teamem@127.0.0.1:1/teamem',
        SUPABASE_URL: process.env.SUPABASE_URL ?? 'https://teamem.local',
        SUPABASE_SERVICE_ROLE_KEY:
          process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'i18n-smoke-service-role',
        TEAMEM_CLOUD_RUNTIME_URL:
          process.env.TEAMEM_CLOUD_RUNTIME_URL ??
          'https://runtime.teamem.local',
        TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN:
          process.env.TEAMEM_CLOUD_RUNTIME_PROVISIONING_TOKEN ??
          'i18n-smoke-runtime-token'
      }
    }
  );

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  server.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`next start exited with ${code}: ${stderr}`);
    } else if (signal && signal !== 'SIGTERM') {
      console.error(`next start exited from ${signal}: ${stderr}`);
    }
  });

  return server;
}

async function verifyPublicPage(
  baseUrl: string,
  expectation: PublicPageExpectation
) {
  const response = await fetch(`${baseUrl}${expectation.path}`, {
    redirect: 'manual'
  });
  expect(
    response.status === 200,
    `${expectation.path} returned ${response.status}`
  );
  const html = await response.text();

  expect(
    html.includes(`<html lang="${expectation.lang}"`),
    `${expectation.path} did not render html lang=${expectation.lang}`
  );
  expect(
    html.includes(`<title>${expectation.title}</title>`),
    `${expectation.path} did not render the localized title`
  );
  expect(
    html.includes(
      `<meta name="description" content="${expectation.description}"/>`
    ),
    `${expectation.path} did not render the localized description`
  );
  expect(
    hasMetadataLink(html, 'canonical', expectation.canonical),
    `${expectation.path} did not render the canonical link`
  );

  for (const [locale, href] of Object.entries(expectation.alternates)) {
    expect(
      hasMetadataLink(html, 'alternate', href, locale),
      `${expectation.path} did not render alternate ${locale}`
    );
  }
}

async function verifyDashboardRedirect(
  baseUrl: string,
  path: string,
  expectedLoginPath: string
) {
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
  expect(
    [307, 308].includes(response.status),
    `${path} returned ${response.status} instead of redirecting`
  );
  const location = response.headers.get('location');
  expect(Boolean(location), `${path} did not include a location header`);
  const redirectUrl = new URL(location!, baseUrl);
  expect(
    redirectUrl.pathname === expectedLoginPath,
    `${path} redirected to ${redirectUrl.pathname}`
  );
  expect(
    redirectUrl.searchParams.get('from') === path,
    `${path} did not preserve localized return target`
  );
}

async function verifyRootLocaleRedirect(
  baseUrl: string,
  cookie: string | undefined,
  expectedPath: string
) {
  const response = await fetch(`${baseUrl}/`, {
    headers: cookie ? { cookie } : undefined,
    redirect: 'manual'
  });
  expect(
    [307, 308].includes(response.status),
    `/ with ${cookie ?? 'no cookie'} returned ${response.status}`
  );
  const location = response.headers.get('location');
  expect(Boolean(location), `/ with ${cookie ?? 'no cookie'} missed location`);
  const redirectUrl = new URL(location!, baseUrl);
  expect(
    redirectUrl.pathname === expectedPath,
    `/ with ${cookie ?? 'no cookie'} redirected to ${redirectUrl.pathname}`
  );
}

async function waitForServer(baseUrl: string) {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/en`, { redirect: 'manual' });
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`next start did not become ready: ${String(lastError)}`);
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function hasMetadataLink(
  html: string,
  rel: 'canonical' | 'alternate',
  expectedHref: string,
  hreflang?: string
): boolean {
  const linkPattern = /<link\s+[^>]*>/g;
  const links = html.match(linkPattern) ?? [];

  return links.some((link) => {
    if (!link.includes(`rel="${rel}"`)) {
      return false;
    }
    if (hreflang && !link.includes(`hrefLang="${hreflang}"`)) {
      return false;
    }

    const href = link.match(/\shref="([^"]+)"/)?.[1];
    return href === expectedHref;
  });
}

await main();
