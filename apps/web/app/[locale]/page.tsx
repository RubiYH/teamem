import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Button } from '../../src/components/ui/button';
import { LanguageSwitcher } from '../../src/components/language-switcher';
import { buildLocalizedMetadata } from '../../src/i18n/metadata';
import { normalizeLocale } from '../../src/i18n/return-target';

type CapabilityRow = {
  label: string;
  text: string;
};

export async function generateMetadata({
  params
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = normalizeLocale(rawLocale);
  const t = await getTranslations({ locale, namespace: 'Metadata.landing' });

  return buildLocalizedMetadata({
    locale,
    title: t('title'),
    description: t('description')
  });
}

export default async function Home({
  params
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'LandingPage' });
  const capabilityRows = t.raw('capabilities.rows') as CapabilityRow[];
  const setupSteps = t.raw('setup.steps') as string[];
  const dashboardHref = `/${locale}/dashboard`;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-between px-5 py-5 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between border-b border-border pb-4">
          <a className="text-sm font-semibold" href={`/${locale}`}>
            {t('brand')}
          </a>
          <nav
            aria-label={t('nav.label')}
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <LanguageSwitcher />
            <a
              className="hidden rounded-md px-3 py-2 transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
              href="https://github.com/RubiYH/teamem"
            >
              {t('nav.selfHost')}
            </a>
            <Button asChild className="h-9 px-3" href={dashboardHref}>
              {t('nav.start')}
            </Button>
          </nav>
        </header>

        <div className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:py-16">
          <div className="max-w-3xl space-y-7">
            <p className="w-fit rounded-sm border border-border bg-muted px-3 py-1 text-xs font-medium uppercase text-muted-foreground">
              {t('hero.eyebrow')}
            </p>
            <div className="space-y-5">
              <h1 className="text-5xl font-semibold leading-none sm:text-6xl">
                {t('hero.title')}
              </h1>
              <p className="max-w-2xl text-2xl font-medium leading-tight text-foreground sm:text-3xl">
                {t('hero.tagline')}
              </p>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground">
                {t('hero.description')}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild className="w-full sm:w-auto" href={dashboardHref}>
                {t('hero.primaryCta')}
              </Button>
              <Button
                asChild
                className="w-full sm:w-auto"
                href="https://github.com/RubiYH/teamem"
                variant="secondary"
              >
                {t('hero.secondaryCta')}
              </Button>
            </div>
          </div>

          <aside
            aria-label={t('setup.label')}
            className="rounded-md border border-border bg-panel p-4 shadow-panel"
          >
            <div className="border-b border-border pb-3">
              <p className="text-sm font-medium text-foreground">
                {t('setup.title')}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {t('setup.description')}
              </p>
            </div>
            <ol className="divide-y divide-border">
              {setupSteps.map((step, index) => (
                <li className="flex gap-3 py-4" key={step}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border bg-muted text-xs font-semibold text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="text-sm leading-6 text-foreground">
                    {step}
                  </span>
                </li>
              ))}
            </ol>
            <p className="border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
              {t('setup.note')}
            </p>
          </aside>
        </div>

        <section
          aria-label={t('capabilities.label')}
          className="grid gap-3 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-4"
        >
          {capabilityRows.map((row) => (
            <article
              className="space-y-2 border-l border-border pl-4"
              key={row.label}
            >
              <h2 className="text-sm font-semibold">{row.label}</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                {row.text}
              </p>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}
