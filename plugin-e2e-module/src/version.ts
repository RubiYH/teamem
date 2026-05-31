export function parseVersion(text: string): string | null {
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\b/);
  return match?.[0] ?? null;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = toParts(left);
  const rightParts = toParts(right);

  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function toParts(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return [0, 0, 0];
  }

  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10)
  ];
}
