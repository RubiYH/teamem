import {
  buildBoardSummary,
  demoBoard
} from './features/collaboration-board.js';

export function renderDemoWorkspace(): string {
  return buildBoardSummary(demoBoard);
}

if (import.meta.main) {
  console.log(renderDemoWorkspace());
}
