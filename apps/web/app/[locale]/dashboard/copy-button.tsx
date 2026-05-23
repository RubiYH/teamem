'use client';

import { useState } from 'react';
import posthog from 'posthog-js';

export function CopyButton({
  ariaLabel,
  copiedLabel,
  copyLabel,
  value
}: {
  ariaLabel: string;
  copiedLabel: string;
  copyLabel: string;
  value: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const isDisabled = !value;

  async function copyValue() {
    if (!value) {
      return;
    }
    await navigator.clipboard.writeText(value);
    posthog.capture('setup_command_copied', { label: ariaLabel });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      aria-label={ariaLabel}
      className="border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      disabled={isDisabled}
      onClick={copyValue}
      type="button"
    >
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}
