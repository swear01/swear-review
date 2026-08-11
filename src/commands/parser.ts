/** Manual command parsing for PR conversation comments. */

export type SwearCommand =
  | { kind: 'full' }
  | { kind: 'incremental' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'none' };

const COMMAND_RE = /^\s*\/swear-review(?:\s+(full|incremental|status|help))?\s*$/i;

/** Parses a comment body; returns the first matching /swear-review command. */
export function parseSwearCommand(body: string): SwearCommand {
  for (const line of body.split('\n')) {
    const m = COMMAND_RE.exec(line);
    if (!m) continue;
    const arg = (m[1] ?? 'full').toLowerCase();
    switch (arg) {
      case 'full':
        return { kind: 'full' };
      case 'incremental':
        return { kind: 'incremental' };
      case 'status':
        return { kind: 'status' };
      case 'help':
        return { kind: 'help' };
      default:
        return { kind: 'full' };
    }
  }
  return { kind: 'none' };
}

/** Roles allowed to trigger reviews (GitHub collaborator permission levels). */
export const ALLOWED_ROLES = new Set(['owner', 'admin', 'write', 'maintain']);

export function isAllowedRole(permission: string | undefined): boolean {
  return permission ? ALLOWED_ROLES.has(permission.toLowerCase()) : false;
}
