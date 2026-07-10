// ============================================================
// Worker CMS plugin — "event-actions".
//
// Repeatable actions over the events plugin's guest data: each action selects
// guests (guest list or whole event, narrowed by attribute / custom-input
// filters), composes a text file from a LiquidJS template, and delivers it to
// a webhook or an email address — manually ("Run now") or on a repeat
// schedule evaluated by the cron tick.
//
// Companion to cms-plugin-events: the guest / mail_list / event page types are
// owned by that plugin; this manifest only declares them as readTypes plus its
// own `event_action` type.
// ============================================================

import {
  CmsClient,
  CmsApiError,
  CmsNotConfiguredError,
  PLUGIN_ID,
  attr,
  items,
  localized,
  pointer,
  pageId,
  type CmsPage,
} from './cms';
import {
  DEFAULT_FILE_NAME,
  DEFAULT_TEMPLATE,
  FILTER_MODES,
  FILTER_OPS,
  GUEST_FIELDS,
  REPEAT_OPTIONS,
  computeNextRun,
  customFieldKeysForScope,
  parseFilterMode,
  parseFilters,
  previewAction,
  runAction,
  runDueActions,
  type ActionEnv,
  type FilterRule,
} from './actions';
import { actionAdminAccessForRequest, cmsUserId, forbidden, type ActionAdminAccess } from './permissions';
import { adminView, redirect, requirePluginSecret, serveViewAsset } from '@lionrockjs/worker-cms-plugin';
// The plugin manifest (content types, nav, permissions) is plain data, so it
// lives as a static JSON file served verbatim at /__plugin/manifest.
import MANIFEST from './manifest.json';

interface PluginEnv extends ActionEnv {
  /** Plugin-owned Liquid templates and other view assets. */
  VIEWS: Fetcher;
}

const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;

export default {
  async fetch(request: Request, env: PluginEnv, _ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const secretRequired = path.startsWith('/__plugin/hooks/') || path.startsWith('/__plugin/admin');
    if (secretRequired) {
      const denied = requirePluginSecret(request, env.PLUGIN_SECRET);
      if (denied) return denied;
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    // Plugin-owned view templates, served to the CMS's composite view resolver.
    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    // Static assets declared in the plugin manifest. The CMS fetches these at
    // this bare path — both when an admin approves one (hash pinning) and on
    // every proxied serve — before allowing them to run under CMS chrome.
    if (path.startsWith('/assets/')) {
      return serveViewAsset(env.VIEWS, path);
    }

    // This plugin declares no hooks, but answer politely if the host ever
    // delivers one (e.g. after a manifest change) instead of 404-ing.
    if (path.startsWith('/__plugin/hooks/')) {
      return new Response('ok');
    }

    if (path.startsWith('/__plugin/admin')) {
      return handleAdmin(request, env, url);
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: PluginEnv, ctx: ExecutionContext): Promise<void> {
    if (!env.CMS_URL || !env.PLUGIN_SECRET) return;
    ctx.waitUntil(
      runDueActions(new CmsClient(env), env)
        .catch((error) => console.error('[event-actions] scheduled tick failed', error)),
    );
  },
};

// ── Admin router ──────────────────────────────────────────────────────────────

function wantsJson(url: URL): boolean {
  const json = url.searchParams.get('json')?.trim().toLowerCase();
  const format = url.searchParams.get('format')?.trim().toLowerCase();
  return format === 'json' || (url.searchParams.has('json') && json !== '0' && json !== 'false');
}

function withFlash(path: string, message: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}flash=${encodeURIComponent(message)}`;
}

/** Renders an error panel when the CMS link is unconfigured or returns an error. */
function errorPanel(views: Fetcher, message: string, showConfig = false, jsonOnly = false): Promise<Response> {
  return adminView(views, 'Error', 'error', { message, showConfig }, jsonOnly);
}

function notFoundPanel(views: Fetcher, jsonOnly: boolean): Promise<Response> {
  return adminView(views, 'Not found', 'error', { heading: 'Not found', message: 'Action not found.' }, jsonOnly);
}

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const section = segments[0] || 'actions';
  const jsonOnly = wantsJson(url);

  if (section === 'assets') {
    return serveViewAsset(env.VIEWS, `/assets/${segments.slice(1).join('/')}`);
  }
  if (section === 'views') {
    return serveViewAsset(env.VIEWS, `/${segments.slice(1).join('/')}`, { bareLiquidSnippets: true });
  }
  if (section !== 'actions') return new Response('not found', { status: 404 });

  let cms: CmsClient;
  try {
    // Attribute all CMS writes in this request to the signed-in admin.
    cms = new CmsClient(env).actAs(cmsUserId(request));
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) return errorPanel(env.VIEWS, error.message, true, jsonOnly);
    throw error;
  }

  const access = actionAdminAccessForRequest(request);
  if (!access.canView) return forbidden();

  // Each handler is `await`ed so a CmsApiError renders as an error panel
  // instead of escaping as an unhandled 500.
  try {
    if (!segments[1]) return await actionsList(cms, env.VIEWS, url, jsonOnly, access);
    if (segments[1] === 'new') {
      if (request.method === 'POST') {
        if (!access.canEdit) return forbidden();
        return await createAction(request, cms, env.VIEWS, jsonOnly);
      }
      return await actionForm(cms, env.VIEWS, null, url, jsonOnly, access);
    }

    const actionId = pageId(segments[1]);
    if (!actionId) return await notFoundPanel(env.VIEWS, jsonOnly);
    const sub = segments[2] ?? '';

    if (sub === 'run' && request.method === 'POST') {
      if (!access.canRun) return forbidden();
      return await runNow(cms, env, actionId);
    }
    if (sub === 'preview') return await preview(cms, env.VIEWS, actionId, jsonOnly);
    if (sub === 'toggle' && request.method === 'POST') {
      if (!access.canEdit) return forbidden();
      return await toggleAction(cms, actionId);
    }
    if (sub === 'delete' && request.method === 'POST') {
      if (!access.canEdit) return forbidden();
      return await deleteAction(cms, actionId);
    }
    if (!sub) {
      if (request.method === 'POST') {
        if (!access.canEdit) return forbidden();
        return await updateAction(request, cms, env.VIEWS, actionId, jsonOnly);
      }
      return await actionForm(cms, env.VIEWS, actionId, url, jsonOnly, access);
    }
    return await notFoundPanel(env.VIEWS, jsonOnly);
  } catch (error) {
    if (error instanceof CmsApiError) {
      if (error.code === 'limit_exceeded') {
        return errorPanel(
          env.VIEWS,
          'A configured limit has been reached, so nothing was created. Remove existing actions, or ask an administrator to raise the limit under Plugins → Limits.',
          false,
          jsonOnly,
        );
      }
      // The manifest's readTypes (event, mail_list, guest) and its own
      // event_action type stay inert until an admin approves them — a fresh
      // install always hits this until then, so don't suggest a
      // CMS_URL/PLUGIN_SECRET problem.
      if (error.code === 'forbidden_page_type') {
        return adminView(env.VIEWS, 'Page types not approved', 'error', {
          heading: 'Page types not approved',
          message: 'The CMS refused access to a page type this plugin needs. In the CMS admin, open '
            + `Plugins → ${PLUGIN_ID} → Page types and approve the plugin's declared page types `
            + '(read access to event, mail_list and guest), then reload this page.',
        }, jsonOnly);
      }
      return errorPanel(env.VIEWS, `CMS responded ${error.status} (${error.code}).`, error.status === 403, jsonOnly);
    }
    throw error;
  }
}

// ── Form state ────────────────────────────────────────────────────────────────

interface ActionFormState {
  name: string;
  eventId: string;
  listId: string;
  enabled: boolean;
  repeat: string;
  repeatTime: string;
  repeatDay: string;
  repeatDate: string;
  delivery: string;
  webhookUrl: string;
  emailTo: string;
  emailSubject: string;
  fileName: string;
  template: string;
  filters: FilterRule[];
  filterMode: string;
}

function defaultFormState(): ActionFormState {
  return {
    name: '',
    eventId: '',
    listId: '',
    enabled: true,
    repeat: 'manual',
    repeatTime: '09:00',
    repeatDay: '1',
    repeatDate: '1',
    delivery: 'webhook',
    webhookUrl: '',
    emailTo: '',
    emailSubject: '',
    fileName: DEFAULT_FILE_NAME,
    template: DEFAULT_TEMPLATE,
    filters: [],
    filterMode: 'all',
  };
}

function formStateFromAction(action: CmsPage): ActionFormState {
  return {
    name: action.name,
    eventId: pointer(action.lect, 'event'),
    listId: pointer(action.lect, 'mail_list'),
    enabled: attr(action.lect, 'enabled') === 'yes',
    repeat: attr(action.lect, 'repeat') || 'manual',
    repeatTime: attr(action.lect, 'repeat_time') || '09:00',
    repeatDay: attr(action.lect, 'repeat_day') || '1',
    repeatDate: attr(action.lect, 'repeat_date') || '1',
    delivery: attr(action.lect, 'delivery') || 'webhook',
    webhookUrl: attr(action.lect, 'webhook_url'),
    emailTo: attr(action.lect, 'email_to'),
    emailSubject: attr(action.lect, 'email_subject'),
    fileName: attr(action.lect, 'file_name') || DEFAULT_FILE_NAME,
    template: attr(action.lect, 'template') || DEFAULT_TEMPLATE,
    filters: parseFilters(action.lect),
    filterMode: parseFilterMode(action.lect),
  };
}

async function formStateFromRequest(request: Request): Promise<ActionFormState> {
  const form = await request.formData();
  const text = (name: string) => String(form.get(name) ?? '').trim();

  const fields = form.getAll('filter_field').map(String);
  const ops = form.getAll('filter_op').map(String);
  const values = form.getAll('filter_value').map(String);
  const filters: FilterRule[] = fields
    .map((field, index) => ({
      field: field.trim(),
      op: (ops[index] ?? 'equals') as FilterRule['op'],
      value: values[index] ?? '',
    }))
    .filter((rule) => rule.field !== '');

  return {
    name: text('name'),
    eventId: text('event_id'),
    listId: text('list_id'),
    enabled: form.get('enabled') === 'yes',
    repeat: text('repeat') || 'manual',
    repeatTime: text('repeat_time'),
    repeatDay: text('repeat_day'),
    repeatDate: text('repeat_date'),
    delivery: text('delivery') === 'email' ? 'email' : 'webhook',
    webhookUrl: text('webhook_url'),
    emailTo: text('email_to'),
    emailSubject: text('email_subject'),
    fileName: text('file_name'),
    // Keep the template verbatim (no trim) — leading whitespace is meaningful
    // in a plain-text layout.
    template: String(form.get('template') ?? ''),
    filters,
    filterMode: text('filter_mode') === 'any' ? 'any' : 'all',
  };
}

function validateFormState(state: ActionFormState): string | null {
  if (!state.name) return 'A name is required.';
  if (!state.eventId && !state.listId) return 'Select an event or a guest list to act on.';
  if (state.delivery === 'webhook' && !/^https?:\/\//i.test(state.webhookUrl)) {
    return 'Webhook delivery needs a webhook URL starting with http:// or https://.';
  }
  if (state.delivery === 'email' && !state.emailTo) return 'Email delivery needs at least one recipient address.';
  return null;
}

function lectFromFormState(state: ActionFormState, now: Date): Record<string, unknown> {
  const schedulable = state.enabled && state.repeat !== 'manual';
  const next = schedulable ? computeNextRun(state.repeat, state.repeatTime, state.repeatDay, state.repeatDate, now) : null;
  return {
    name: { en: state.name },
    _pointers: { event: state.eventId, mail_list: state.listId },
    enabled: state.enabled ? 'yes' : 'no',
    repeat: state.repeat,
    repeat_time: state.repeatTime,
    repeat_day: state.repeatDay,
    repeat_date: state.repeatDate,
    delivery: state.delivery,
    webhook_url: state.webhookUrl,
    email_to: state.emailTo,
    email_subject: state.emailSubject,
    file_name: state.fileName,
    template: state.template,
    next_run_at: next ? next.toISOString() : '',
    filter_mode: state.filterMode,
    filter: state.filters.map((rule) => ({ field: rule.field, op: rule.op, value: rule.value })),
  };
}

// ── Views ─────────────────────────────────────────────────────────────────────

const REPEAT_LABELS = new Map(REPEAT_OPTIONS.map((option) => [option.value as string, option.label]));

async function actionsList(
  cms: CmsClient,
  views: Fetcher,
  url: URL,
  jsonOnly: boolean,
  access: ActionAdminAccess,
): Promise<Response> {
  const [actions, events, lists] = await Promise.all([
    cms.listAll('event_action'),
    cms.listAll('event', { fields: ['id', 'name'] }),
    cms.listAll('mail_list', { fields: ['id', 'name'] }),
  ]);
  const eventNames = new Map(events.map((event) => [String(event.id), event.name]));
  const listNames = new Map(lists.map((list) => [String(list.id), list.name]));

  return adminView(views, 'Event Actions', 'actions', {
    flash: url.searchParams.get('flash') ?? '',
    newHref: access.canEdit ? `${ADMIN_BASE}/actions/new` : '',
    canRun: access.canRun,
    canEdit: access.canEdit,
    actions: actions
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((action) => {
        const listId = pointer(action.lect, 'mail_list');
        const eventId = pointer(action.lect, 'event');
        const lastRun = items(action.lect, 'run').find((row) => String(row.date ?? '').trim() !== '');
        return {
          id: action.id,
          name: action.name,
          href: `${ADMIN_BASE}/actions/${action.id}`,
          audience: listId
            ? `List: ${listNames.get(listId) ?? `#${listId}`}`
            : eventId
              ? `Event: ${eventNames.get(eventId) ?? `#${eventId}`}`
              : 'Not set',
          repeat: REPEAT_LABELS.get(attr(action.lect, 'repeat') || 'manual') ?? 'Manual only',
          delivery: attr(action.lect, 'delivery') === 'email' ? 'Email' : 'Webhook',
          enabled: attr(action.lect, 'enabled') === 'yes',
          lastRunAt: lastRun ? String(lastRun.date) : '',
          lastRunOk: lastRun ? String(lastRun.status) === 'ok' : true,
          lastRunMessage: lastRun ? String(lastRun.message ?? '') : '',
          nextRunAt: attr(action.lect, 'next_run_at'),
          runAction: `${ADMIN_BASE}/actions/${action.id}/run`,
          toggleAction: `${ADMIN_BASE}/actions/${action.id}/toggle`,
          deleteAction: `${ADMIN_BASE}/actions/${action.id}/delete`,
        };
      }),
  }, jsonOnly);
}

// No-JS fallback: saving always appends this many blank rows. With the
// filter-rows.js enhancement active, "Add rule" / "Remove" buttons take over,
// so one blank row (doubling as the clone template) is enough.
const BLANK_FILTER_ROWS = 1;

async function actionForm(
  cms: CmsClient,
  views: Fetcher,
  actionId: number | null,
  url: URL,
  jsonOnly: boolean,
  access: ActionAdminAccess,
  override?: { state: ActionFormState; error: string },
): Promise<Response> {
  let action: CmsPage | null = null;
  if (actionId) {
    action = await cms.get(actionId);
    if (action.page_type !== 'event_action') return notFoundPanel(views, jsonOnly);
  }
  const state = override?.state ?? (action ? formStateFromAction(action) : defaultFormState());

  const [events, lists] = await Promise.all([
    cms.listAll('event', { fields: ['id', 'name'] }),
    cms.listAll('mail_list'),
  ]);
  const eventNames = new Map(events.map((event) => [String(event.id), event.name]));

  // Suggest real rsvp_custom_* keys once a scope is picked, so the filter
  // field datalist matches what's actually stored on guests — the owning
  // event's custom-input blocks apply to a list even when only the list is
  // selected (mirrors cms-plugin-events, which reads custom fields from both).
  const selectedList = state.listId ? lists.find((list) => String(list.id) === state.listId) ?? null : null;
  const scopeEventId = pageId(state.eventId) ?? (selectedList ? pageId(pointer(selectedList.lect, 'event')) : null);
  const scopeEvent = scopeEventId ? await cms.get(scopeEventId).catch(() => null) : null;
  const customFieldKeys = customFieldKeysForScope(scopeEvent, selectedList);

  const runs = action
    ? items(action.lect, 'run')
      .filter((row) => String(row.date ?? '').trim() !== '')
      .map((row) => ({
        date: String(row.date ?? ''),
        ok: String(row.status ?? '') === 'ok',
        message: String(row.message ?? ''),
        guestCount: String(row.guest_count ?? ''),
        delivery: String(row.delivery ?? ''),
      }))
    : [];

  const filterRows = [
    ...state.filters,
    ...Array.from({ length: BLANK_FILTER_ROWS }, () => ({ field: '', op: 'equals', value: '' })),
  ];

  return adminView(views, action ? `Action: ${action.name}` : 'New action', 'action-form', {
    flash: url.searchParams.get('flash') ?? '',
    error: override?.error ?? '',
    backHref: `${ADMIN_BASE}/actions`,
    title: action ? action.name : 'New action',
    isNew: !action,
    canEdit: access.canEdit,
    canRun: access.canRun,
    formAction: action ? `${ADMIN_BASE}/actions/${action.id}` : `${ADMIN_BASE}/actions/new`,
    runAction: action ? `${ADMIN_BASE}/actions/${action.id}/run` : '',
    previewHref: action ? `${ADMIN_BASE}/actions/${action.id}/preview` : '',
    deleteAction: action ? `${ADMIN_BASE}/actions/${action.id}/delete` : '',
    name: state.name,
    enabled: state.enabled,
    events: events
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((event) => ({ id: String(event.id), name: event.name, selected: String(event.id) === state.eventId })),
    lists: lists
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((list) => {
        const eventName = eventNames.get(pointer(list.lect, 'event')) ?? '';
        return {
          id: String(list.id),
          name: eventName ? `${eventName} — ${list.name}` : list.name,
          selected: String(list.id) === state.listId,
        };
      }),
    filterRows,
    filterOps: FILTER_OPS.map((op) => ({ value: op.value, label: op.label })),
    filterModes: FILTER_MODES.map((mode) => ({ value: mode.value, label: mode.label, selected: mode.value === state.filterMode })),
    guestFields: [...GUEST_FIELDS, ...customFieldKeys],
    repeatOptions: REPEAT_OPTIONS.map((option) => ({ value: option.value, label: option.label, selected: option.value === state.repeat })),
    repeatTime: state.repeatTime,
    repeatDay: state.repeatDay,
    repeatDate: state.repeatDate,
    delivery: state.delivery,
    webhookUrl: state.webhookUrl,
    emailTo: state.emailTo,
    emailSubject: state.emailSubject,
    fileName: state.fileName,
    template: state.template,
    lastRunAt: action ? attr(action.lect, 'last_run_at') : '',
    nextRunAt: action ? attr(action.lect, 'next_run_at') : '',
    runs,
  }, jsonOnly);
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function createAction(request: Request, cms: CmsClient, views: Fetcher, jsonOnly: boolean): Promise<Response> {
  const url = new URL(request.url);
  const state = await formStateFromRequest(request);
  const error = validateFormState(state);
  if (error) {
    return actionForm(cms, views, null, url, jsonOnly, { canView: true, canEdit: true, canRun: true }, { state, error });
  }
  const page = await cms.create({
    page_type: 'event_action',
    name: state.name,
    lect: lectFromFormState(state, new Date()),
  });
  return redirect(withFlash(`${ADMIN_BASE}/actions/${page.id}`, 'Action created.'));
}

async function updateAction(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  actionId: number,
  jsonOnly: boolean,
): Promise<Response> {
  const existing = await cms.get(actionId);
  if (existing.page_type !== 'event_action') return notFoundPanel(views, jsonOnly);
  const url = new URL(request.url);
  const state = await formStateFromRequest(request);
  const error = validateFormState(state);
  if (error) {
    return actionForm(cms, views, actionId, url, jsonOnly, { canView: true, canEdit: true, canRun: true }, { state, error });
  }
  await cms.update(actionId, { name: state.name, lect: lectFromFormState(state, new Date()) });
  return redirect(withFlash(`${ADMIN_BASE}/actions/${actionId}`, 'Action saved.'));
}

async function toggleAction(cms: CmsClient, actionId: number): Promise<Response> {
  const action = await cms.get(actionId);
  if (action.page_type !== 'event_action') return new Response('not found', { status: 404 });
  const enabling = attr(action.lect, 'enabled') !== 'yes';
  const next = enabling
    ? computeNextRun(attr(action.lect, 'repeat'), attr(action.lect, 'repeat_time'), attr(action.lect, 'repeat_day'), attr(action.lect, 'repeat_date'), new Date())
    : null;
  await cms.update(actionId, {
    lect: { enabled: enabling ? 'yes' : 'no', next_run_at: next ? next.toISOString() : '' },
  });
  return redirect(withFlash(`${ADMIN_BASE}/actions`, enabling ? 'Action enabled.' : 'Action disabled.'));
}

async function deleteAction(cms: CmsClient, actionId: number): Promise<Response> {
  const action = await cms.get(actionId);
  if (action.page_type !== 'event_action') return new Response('not found', { status: 404 });
  await cms.remove(actionId);
  return redirect(withFlash(`${ADMIN_BASE}/actions`, 'Action deleted.'));
}

async function runNow(cms: CmsClient, env: PluginEnv, actionId: number): Promise<Response> {
  const action = await cms.get(actionId);
  if (action.page_type !== 'event_action') return new Response('not found', { status: 404 });
  const result = await runAction(cms, env, action, { trigger: 'manual' });
  const message = result.ok
    ? `Run complete: ${result.message} (${result.guestCount} guest${result.guestCount === 1 ? '' : 's'}).`
    : `Run failed: ${result.message}`;
  return redirect(withFlash(`${ADMIN_BASE}/actions/${actionId}`, message));
}

async function preview(cms: CmsClient, views: Fetcher, actionId: number, jsonOnly: boolean): Promise<Response> {
  const action = await cms.get(actionId);
  if (action.page_type !== 'event_action') return notFoundPanel(views, jsonOnly);
  try {
    const result = await previewAction(cms, action);
    return adminView(views, `Preview: ${action.name}`, 'action-preview', {
      backHref: `${ADMIN_BASE}/actions/${actionId}`,
      title: action.name,
      fileName: result.fileName,
      guestCount: result.guestCount,
      totalBeforeFilters: result.totalBeforeFilters,
      output: result.output,
      error: '',
    }, jsonOnly);
  } catch (error) {
    if (error instanceof CmsApiError) throw error;
    return adminView(views, `Preview: ${action.name}`, 'action-preview', {
      backHref: `${ADMIN_BASE}/actions/${actionId}`,
      title: action.name,
      fileName: '',
      guestCount: 0,
      totalBeforeFilters: 0,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    }, jsonOnly);
  }
}
