import { describe, it, expect } from 'vitest';
import { parseSwearCommand, isAllowedRole } from '../../src/commands/parser.js';

describe('parseSwearCommand', () => {
  it('parses bare /swear-review as full', () => {
    expect(parseSwearCommand('/swear-review')).toEqual({ kind: 'full' });
  });

  it('parses full / incremental / status', () => {
    expect(parseSwearCommand('/swear-review full')).toEqual({ kind: 'full' });
    expect(parseSwearCommand('/swear-review incremental')).toEqual({ kind: 'incremental' });
    expect(parseSwearCommand('/swear-review status')).toEqual({ kind: 'status' });
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseSwearCommand('  /SWEAR-REVIEW  INCREMENTAL  ')).toEqual({ kind: 'incremental' });
  });

  it('finds the command on any line of the comment', () => {
    expect(parseSwearCommand('Thanks for the review!\n\n/swear-review full\n\nMore text')).toEqual({ kind: 'full' });
  });

  it('returns none for unrelated comments', () => {
    expect(parseSwearCommand('LGTM')).toEqual({ kind: 'none' });
    expect(parseSwearCommand('/something-else')).toEqual({ kind: 'none' });
  });

  it('does not match substrings', () => {
    expect(parseSwearCommand('/swear-reviewer full')).toEqual({ kind: 'none' });
  });
});

describe('isAllowedRole', () => {
  it('allows owner/admin/write/maintain', () => {
    expect(isAllowedRole('admin')).toBe(true);
    expect(isAllowedRole('write')).toBe(true);
    expect(isAllowedRole('maintain')).toBe(true);
    expect(isAllowedRole('OWNER')).toBe(true);
  });

  it('denies read/none/undefined', () => {
    expect(isAllowedRole('read')).toBe(false);
    expect(isAllowedRole('none')).toBe(false);
    expect(isAllowedRole(undefined)).toBe(false);
  });
});
