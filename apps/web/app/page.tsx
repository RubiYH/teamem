import { Button } from '../src/components/ui/button';

const capabilityRows = [
  {
    label: 'Shared work context',
    text: 'Briefings give every Claude Code session the current plan, active claims, recent decisions, risks, and progress before edits begin.'
  },
  {
    label: 'Scope coordination',
    text: 'File and module claims make it clear who is changing what, then release through the existing git handoff flow.'
  },
  {
    label: 'Durable decisions',
    text: 'Decisions, gotchas, discussions, and Space Rules keep team memory outside one local chat transcript.'
  },
  {
    label: 'Safer conflict avoidance',
    text: 'Teamem surfaces competing work early so teammates can avoid duplicate Claude Code edits and late merge surprises.'
  }
];

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-between px-5 py-5 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between border-b border-border pb-4">
          <a className="text-sm font-semibold" href="/">
            Teamem Cloud
          </a>
          <nav
            aria-label="Primary"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <a
              className="hidden rounded-md px-3 py-2 transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
              href="https://github.com/RubiYH/teamem"
            >
              Self-host
            </a>
            <Button asChild className="h-9 px-3" href="/dashboard">
              Start
            </Button>
          </nav>
        </header>

        <div className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:py-16">
          <div className="max-w-3xl space-y-7">
            <p className="w-fit rounded-sm border border-border bg-muted px-3 py-1 text-xs font-medium uppercase text-muted-foreground">
              Managed Teamem server for Claude Code teams
            </p>
            <div className="space-y-5">
              <h1 className="text-5xl font-semibold leading-none sm:text-6xl">
                Teamem Cloud
              </h1>
              <p className="max-w-2xl text-2xl font-medium leading-tight text-foreground sm:text-3xl">
                Teamem is team memory for humans and their coding agents.
              </p>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground">
                Create a hosted Teamem Space, copy the setup command, and keep
                using the current Claude Code plugin, bridge, git hooks, room
                codes, claims, briefings, decisions, discussions, and Space
                Rules without running the shared server yourself.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild className="w-full sm:w-auto" href="/dashboard">
                Start with Teamem Cloud
              </Button>
              <Button
                asChild
                className="w-full sm:w-auto"
                href="https://github.com/RubiYH/teamem"
                variant="secondary"
              >
                Self-host instead
              </Button>
            </div>
          </div>

          <aside
            aria-label="Teamem Cloud setup path"
            className="rounded-md border border-border bg-panel p-4 shadow-panel"
          >
            <div className="border-b border-border pb-3">
              <p className="text-sm font-medium text-foreground">
                Managed-server path
              </p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Cloud provisions the hosted runtime. Your team still joins
                through the existing local Teamem setup flow.
              </p>
            </div>
            <ol className="divide-y divide-border">
              {[
                'Log in and explicitly create one free managed Space.',
                'Copy the hosted server URL, room code, and setup command.',
                'Run the normal CLI/plugin onboarding, then launch Claude Code.'
              ].map((step, index) => (
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
              Self-hosting remains available for teams that want to operate
              their own Teamem server. Cloud is the fastest managed path.
            </p>
          </aside>
        </div>

        <section
          aria-label="Current Teamem capabilities"
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
