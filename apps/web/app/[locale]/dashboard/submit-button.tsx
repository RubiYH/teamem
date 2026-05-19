'use client';

import { useFormStatus } from 'react-dom';

export function SubmitButton({
  className,
  label,
  pendingLabel
}: {
  className: string;
  label: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button className={className} disabled={pending} type="submit">
      {pending ? pendingLabel : label}
    </button>
  );
}
