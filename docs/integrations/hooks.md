# Git Hooks

Teamem uses git hooks to make claim lifecycle match real work.

## What the hooks do

- `post-commit` releases normal `on_commit` claims for committed paths.
- `post-checkout` pauses claims when you leave a branch and resumes them when
  you return.

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
