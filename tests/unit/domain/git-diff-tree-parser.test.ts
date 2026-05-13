import { describe, it, expect } from 'bun:test';
import { parseDiffTree } from '../../../src/domain/git-diff-tree-parser.js';

describe('parseDiffTree', () => {
  it('parses M (modify) entry', () => {
    const result = parseDiffTree('abc123sha\nM\tsrc/Form.tsx');
    expect(result).toEqual([{ status: 'M', path: 'src/Form.tsx' }]);
  });

  it('parses A (add) entry', () => {
    const result = parseDiffTree('abc123sha\nA\tsrc/NewFile.tsx');
    expect(result).toEqual([{ status: 'A', path: 'src/NewFile.tsx' }]);
  });

  it('parses D (delete) entry', () => {
    const result = parseDiffTree('abc123sha\nD\tsrc/Old.tsx');
    expect(result).toEqual([{ status: 'D', path: 'src/Old.tsx' }]);
  });

  it('parses R<score> (rename) entry with old_path and new path', () => {
    const result = parseDiffTree(
      'abc123sha\nR100\tsrc/Form.jsx\tsrc/NewForm.jsx'
    );
    expect(result).toEqual([
      { status: 'R', path: 'src/NewForm.jsx', old_path: 'src/Form.jsx' }
    ]);
  });

  it('parses R with partial rename score (R073)', () => {
    const result = parseDiffTree('abc123sha\nR073\tsrc/A.ts\tsrc/B.ts');
    expect(result).toEqual([
      { status: 'R', path: 'src/B.ts', old_path: 'src/A.ts' }
    ]);
  });

  it('skips the SHA line (first line without tab)', () => {
    const result = parseDiffTree('deadbeefdeadbeefdeadbeef\nM\tfile.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('M');
  });

  it('parses multiple entries of mixed types', () => {
    const input = [
      'abc123sha',
      'M\tsrc/Form.tsx',
      'A\tsrc/Added.tsx',
      'D\tsrc/Removed.tsx',
      'R100\tsrc/Old.tsx\tsrc/Renamed.tsx'
    ].join('\n');
    const result = parseDiffTree(input);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ status: 'M', path: 'src/Form.tsx' });
    expect(result[1]).toEqual({ status: 'A', path: 'src/Added.tsx' });
    expect(result[2]).toEqual({ status: 'D', path: 'src/Removed.tsx' });
    expect(result[3]).toEqual({
      status: 'R',
      path: 'src/Renamed.tsx',
      old_path: 'src/Old.tsx'
    });
  });

  it('returns empty array for empty output', () => {
    expect(parseDiffTree('')).toEqual([]);
  });

  it('mode-only change comes through as M (chmod +x)', () => {
    // git diff-tree reports chmod as M with the same path
    const result = parseDiffTree('abc123sha\nM\tscripts/run.sh');
    expect(result).toEqual([{ status: 'M', path: 'scripts/run.sh' }]);
  });
});
