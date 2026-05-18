'use client';

import { useState } from 'react';

export function CopyButton({
  label,
  value
}: {
  label: string;
  value: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const isDisabled = !value;

  async function copyValue() {
    if (!value) {
      return;
    }
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      aria-label={`Copy ${label}`}
      className="border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      disabled={isDisabled}
      onClick={copyValue}
      type="button"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
