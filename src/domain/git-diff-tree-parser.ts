/**
 * Pure parser for `git diff-tree --name-status -r -M HEAD` output.
 * First line is the commit SHA (no tab) and is skipped.
 */

export interface DiffEntry {
  status: 'M' | 'A' | 'D' | 'R';
  path: string;
  old_path?: string;
}

export function parseDiffTree(output: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const line of output.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const statusChar = (parts[0] ?? '').charAt(0);
    if (statusChar === 'M' || statusChar === 'A') {
      const path = parts[1];
      if (path) entries.push({ status: statusChar, path });
    } else if (statusChar === 'R' && parts.length >= 3) {
      const old_path = parts[1];
      const path = parts[2];
      if (old_path && path) entries.push({ status: 'R', path, old_path });
    } else if (statusChar === 'D') {
      const path = parts[1];
      if (path) entries.push({ status: 'D', path });
    }
    // SHA line (no tab, hex chars) and unknown statuses are silently skipped
  }
  return entries;
}
