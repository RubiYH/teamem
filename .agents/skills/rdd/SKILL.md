---
name: rdd
description: Run review-driven development. Use when the user asks for RDD, review-driven development, or wants each issue handled by an executor-reviewer-debugger loop until reviewer approval before moving to the next issue.
---

# Review-Driven Development

## Overview

Use this workflow to process issues one at a time with separated implementation, review, and fix roles. Keep each issue bounded, verify the result, and carry deferred out-of-scope findings to the final report.

## Workflow

1. Pick the next issue and define the expected done state.
2. Summon a dedicated executor for only that issue.
3. Summon a dedicated reviewer to inspect the executor's work.
4. If the reviewer requests fixes, summon a debugger to address all in-scope fixes.
5. Repeat review and debug until the reviewer approves.
6. If reviewer-requested fixes are too far out of scope, defer them and report them after all issues finish.
7. Discard the issue-specific agents and restart from step 1 with the next issue.
8. Finish with changed files, verification evidence, deferred items, and remaining risks.

## Role Rules

- Keep each executor, reviewer, and debugger scoped to the current issue.
- Only the main agent may summon RDD subagents, and each summon must happen from the main agent's context stream so every handoff is visible and auditable.
- Executors, reviewers, debuggers, and other child agents must not summon additional subagents or delegate to sub-subagents.
- Spawn issue-specific agents through oh-my-codex first when that surface is available.
- If oh-my-codex subagents are unavailable, try Codex native subagents.
- If neither oh-my-codex nor Codex native subagents are available, halt the RDD workflow and alert the user instead of emulating the roles in the main thread.
- Do not let a reviewer implement fixes; route fixes through the debugger role.
- Do not move to the next issue until the current reviewer approves or the remaining requests are explicitly deferred as out of scope.

## Completion Report

Report:

- Issues completed.
- Files changed.
- Tests or verification run.
- Reviewer approval status.
- Deferred out-of-scope requests.
- Remaining risks.
