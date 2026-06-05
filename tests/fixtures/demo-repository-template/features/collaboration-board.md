# Collaboration Board Feature

## Intent

The board gives interactive smoke tests a stable product feature to inspect,
claim, discuss, edit, and hand off.

## Expected Behaviors

- Cards have stable ids and owners.
- Status values stay limited to `todo`, `doing`, and `done`.
- Summary text should remain deterministic for transcript assertions.

## Handoff Notes

- Feature edits normally target `src/features/collaboration-board.ts`.
- Product notes live here and can be claimed separately from source edits.
