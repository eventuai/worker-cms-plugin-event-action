export interface ActionAdminAccess {
  canView: boolean;
  canEdit: boolean;
  canRun: boolean;
}

const FULL_ACCESS: ActionAdminAccess = { canView: true, canEdit: true, canRun: true };
const NO_ACCESS: ActionAdminAccess = { canView: false, canEdit: false, canRun: false };

/**
 * The signed-in CMS user's id from the forwarded `x-cms-user` summary, or
 * null on direct/anonymous calls. Echoed back to the host on CMS writes
 * (x-acting-user-id) so credit costs are charged to the right user.
 */
export function cmsUserId(request: Request): string | null {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id === 'string' && parsed.id.trim()) return parsed.id.trim();
    if (typeof parsed.id === 'number' && Number.isFinite(parsed.id)) return String(parsed.id);
    return null;
  } catch {
    return null;
  }
}

export function actionAdminAccessForRequest(request: Request): ActionAdminAccess {
  const roles = cmsUserRoles(request);
  const permissions = cmsUserPermissions(request);

  // Direct secret-authenticated calls predate x-cms-user forwarding in tests
  // and local tooling. Treat those as trusted full-access calls.
  if (!roles.length) return { ...FULL_ACCESS };
  if (roles.includes('admin') || roles.includes('editor')) return { ...FULL_ACCESS };

  const canEdit = permissions.includes('event-actions:write');
  const canRun = canEdit || permissions.includes('event-actions:run');
  const canView = canRun || permissions.includes('event-actions:view') || roles.includes('moderator');
  if (!canView) return { ...NO_ACCESS };
  return { canView: true, canEdit, canRun };
}

function cmsUserRoles(request: Request): string[] {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { role?: unknown };
    if (typeof parsed.role !== 'string') return [];
    return [...new Set(parsed.role.split(',').map((role) => role.trim().toLowerCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

function cmsUserPermissions(request: Request): string[] {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { permissions?: unknown };
    if (Array.isArray(parsed.permissions)) {
      return [...new Set(parsed.permissions
        .filter((permission): permission is string => typeof permission === 'string')
        .map((permission) => permission.trim().toLowerCase())
        .filter(Boolean))];
    }
    if (typeof parsed.permissions === 'string') {
      return [...new Set(parsed.permissions.split(',').map((permission) => permission.trim().toLowerCase()).filter(Boolean))];
    }
    return [];
  } catch {
    return [];
  }
}

export function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}
