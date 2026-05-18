'use client';

import { useFormStatus } from 'react-dom';

export function RotateRoomCodeButton() {
  const { pending } = useFormStatus();

  return (
    <button
      className="border border-foreground bg-foreground px-3 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:border-muted disabled:bg-muted disabled:text-muted-foreground"
      disabled={pending}
      type="submit"
    >
      {pending ? 'Rotating...' : 'Rotate room code'}
    </button>
  );
}
