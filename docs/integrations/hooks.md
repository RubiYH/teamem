# Git Hooks

Teamem uses git hooks to make claim lifecycle match real work.

## What the hooks do

- `post-commit` releases normal `on_commit` claims for committed paths.
- `post-checkout` pauses claims when you leave a branch and resumes them when
  you return.

Sprint mode scopes the claim picture used by hooks and tools. A claim created
while you are in a Sprint conflicts with claims in that same Sprint only.
Space-mode claims conflict with Space-mode claims. Cross-Sprint overlap is
non-blocking awareness for status/briefing; the normal git merge and review
workflow owns later integration across Sprints.

## Install

The npm bootstrapper can install hooks during `teamem init`.

For source-tree development, run:

```bash
bun run teamem install-git-hooks
```

Run the hook installer in every clone where you want automatic claim release.

## Hook managers

If your repo uses a hook manager such as Husky or Lefthook, configure that
manager to call Teamem's `post-commit` and `post-checkout` hook scripts from the
installed plugin.
