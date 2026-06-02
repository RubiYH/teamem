export type BoardCard = {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  owner: string;
};

export type CollaborationBoard = {
  name: string;
  cards: BoardCard[];
};

export const demoBoard: CollaborationBoard = {
  name: 'Teamem Smoke Board',
  cards: [
    {
      id: 'card-briefing',
      title: 'Summarize current workspace context',
      status: 'todo',
      owner: 'alice'
    },
    {
      id: 'card-scope',
      title: 'Claim the collaboration board feature path',
      status: 'doing',
      owner: 'bob'
    },
    {
      id: 'card-handoff',
      title: 'Prepare git handoff notes',
      status: 'done',
      owner: 'alice'
    }
  ]
};

export function buildBoardSummary(board: CollaborationBoard): string {
  const counts = board.cards.reduce<Record<BoardCard['status'], number>>(
    (acc, card) => {
      acc[card.status] += 1;
      return acc;
    },
    { todo: 0, doing: 0, done: 0 }
  );

  return `${board.name}: ${counts.todo} todo, ${counts.doing} doing, ${counts.done} done`;
}
