import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDueActions, type ActionEnv, type OutboundActionEmail } from '../src/actions';
import { CmsClient } from '../src/cms';
import worker from '../src/index';
import { renderView } from '../src/templates/liquid';

interface PluginEnv extends ActionEnv {
  VIEWS: Fetcher;
}

const plugin = worker as {
  fetch(request: Request, env: PluginEnv, ctx?: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: PluginEnv, ctx: ExecutionContext): Promise<void>;
};

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

async function renderedText(response: Response): Promise<string> {
  if (response.headers.get('x-cms-client-view') !== '1') return response.text();
  const viewPath = response.headers.get('x-cms-view-path');
  if (!viewPath) throw new Error('Missing x-cms-view-path');
  const data = await response.clone().json() as Record<string, unknown>;
  return renderView(views(), viewPath, data);
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return { VIEWS: views(), CMS_URL: 'http://cms.test', PLUGIN_SECRET: 'secret', ...overrides };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('x-plugin-secret', 'secret');
  return new Request(`https://event-actions.test${path}`, { ...init, headers });
}

function cmsUser(role: string, permissions: string[] = []): string {
  return JSON.stringify({ id: '42', email: `${role}@example.com`, name: role, role, permissions });
}

interface Page {
  id: number;
  page_type: string;
  name: string;
  lect: Record<string, unknown>;
  uuid?: string;
  slug?: string;
  weight?: number;
}

function eventPage(id = 5): Page {
  return { id, page_type: 'event', name: 'Gala Dinner', lect: { _type: 'event' } };
}

function listPage(id = 77, eventId = 5): Page {
  return { id, page_type: 'mail_list', name: 'VIP', lect: { _type: 'mail_list', _pointers: { event: String(eventId) } } };
}

function guestPage(id: number, name: string, lect: Record<string, unknown>): Page {
  return { id, page_type: 'guest', name, lect };
}

function actionPage(lectOverrides: Record<string, unknown> = {}, id = 900): Page {
  return {
    id,
    page_type: 'event_action',
    name: 'Daily export',
    lect: {
      _pointers: { mail_list: '77', event: '' },
      enabled: 'yes',
      repeat: 'manual',
      delivery: 'webhook',
      webhook_url: 'https://hooks.test/in',
      file_name: 'guests-{{ date }}.txt',
      template: '{% for g in guests %}{{ g.name }},{{ g.email }},{{ g.status }}\n{% endfor %}count={{ count }}',
      filter: [{}, { field: 'status', op: 'equals', value: 'confirmed' }],
      run: [{}],
      ...lectOverrides,
    },
  };
}

const GUESTS: Page[] = [
  guestPage(1, 'Ada', { email: 'ada@example.com', status: 'confirmed', rsvp_custom_meal: 'vegetarian', _pointers: { mail_list: '77' } }),
  guestPage(2, 'Bob', { email: 'bob@example.com', status: 'declined', _pointers: { mail_list: '77' } }),
  guestPage(3, 'Cyd', { email: 'cyd@example.com', status: 'confirmed', _pointers: { mail_list: '77' } }),
];

interface CmsStub {
  puts: Array<{ id: number; body: Record<string, unknown> }>;
  posts: Array<Record<string, unknown>>;
  webhooks: Array<{ url: string; headers: Record<string, string>; body: string }>;
  webhookStatus: number;
}

/**
 * Stubs globalThis.fetch with a tiny router covering the CMS Plugin API
 * endpoints this plugin calls, plus the outbound webhook target.
 */
function stubCms(pages: Page[], overrides: { webhookStatus?: number } = {}): CmsStub {
  const stub: CmsStub = { puts: [], posts: [], webhooks: [], webhookStatus: overrides.webhookStatus ?? 200 };
  const byId = new Map(pages.map((page) => [page.id, page]));

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

    if (url.hostname === 'hooks.test') {
      stub.webhooks.push({
        url: url.href,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body ?? ''),
      });
      return new Response(stub.webhookStatus === 200 ? 'ok' : 'nope', { status: stub.webhookStatus });
    }

    if (url.hostname !== 'cms.test') throw new Error(`Unexpected fetch: ${url.href}`);

    const pageMatch = /^\/__cms\/pages\/(\d+)$/.exec(url.pathname);
    if (pageMatch) {
      const id = Number(pageMatch[1]);
      const page = byId.get(id);
      if (!page) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        stub.puts.push({ id, body });
        const lect = { ...page.lect, ...(body.lect as Record<string, unknown> ?? {}) };
        byId.set(id, { ...page, lect });
        return Response.json({ page: { ...page, lect } });
      }
      if (method === 'DELETE') return Response.json({ ok: true });
      return Response.json({ page });
    }

    if (url.pathname === '/__cms/pages' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      stub.posts.push(body);
      return Response.json({ page: { id: 901, ...body } });
    }

    if (url.pathname === '/__cms/pages') {
      const pageType = url.searchParams.get('page_type');
      const pointerKey = url.searchParams.get('pointer_key');
      const pointerValue = url.searchParams.get('pointer_value');
      const matches = [...byId.values()].filter((page) => {
        if (page.page_type !== pageType) return false;
        if (!pointerKey) return true;
        const pointers = (page.lect._pointers ?? {}) as Record<string, unknown>;
        return String(pointers[pointerKey] ?? '') === String(pointerValue ?? '');
      });
      return Response.json({ pages: matches, total: matches.length });
    }

    throw new Error(`Unhandled CMS call: ${method} ${url.pathname}`);
  });

  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('plugin contract', () => {
  it('serves the manifest without a secret', async () => {
    const response = await plugin.fetch(new Request('https://event-actions.test/__plugin/manifest'), env());
    const manifest = await response.json() as { id: string; contentTypes: { readTypes: string[] } };
    expect(manifest.id).toBe('event-actions');
    expect(manifest.contentTypes.readTypes).toEqual(['event', 'mail_list', 'guest']);
  });

  it('rejects admin calls without the plugin secret', async () => {
    const response = await plugin.fetch(new Request('https://event-actions.test/__plugin/admin/actions'), env());
    expect(response.status).toBe(403);
  });
});

describe('actions list', () => {
  it('renders configured actions with audience and last-run state', async () => {
    stubCms([actionPage({ run: [{ date: '2026-07-09T09:00:00.000Z', status: 'ok', message: 'Delivered', guest_count: '2', delivery: 'webhook' }] }), eventPage(), listPage()]);
    const response = await plugin.fetch(request('/__plugin/admin/actions'), env());
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('Daily export');
    expect(html).toContain('List: VIP');
    expect(html).toContain('Run now');
  });

  it('hides mutating controls from view-only users', async () => {
    stubCms([actionPage(), eventPage(), listPage()]);
    const response = await plugin.fetch(
      request('/__plugin/admin/actions', { headers: { 'x-cms-user': cmsUser('helper', ['event-actions:view']) } }),
      env(),
    );
    const html = await renderedText(response);
    expect(html).toContain('Daily export');
    expect(html).not.toContain('/actions/900/run');
    expect(html).not.toContain('/actions/900/delete');
    expect(html).not.toContain('New action');
  });

  it('explains the page-type approval step when the CMS returns forbidden_page_type', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> => new Response(
      JSON.stringify({ error: 'forbidden_page_type', page_type: 'event_action', message: 'not approved' }),
      { status: 403 },
    ));
    const response = await plugin.fetch(request('/__plugin/admin/actions'), env());
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('Page types not approved');
    expect(html).toContain('Page types');
    expect(html).not.toContain('PLUGIN_SECRET');
  });

  it('forbids users with no event-actions permission', async () => {
    stubCms([]);
    const response = await plugin.fetch(
      request('/__plugin/admin/actions', { headers: { 'x-cms-user': cmsUser('helper', []) } }),
      env(),
    );
    expect(response.status).toBe(403);
  });
});

describe('create and update', () => {
  it('creates an event_action page from the form', async () => {
    const stub = stubCms([eventPage(), listPage()]);
    const form = new URLSearchParams({
      name: 'Confirmed guests',
      event_id: '',
      list_id: '77',
      enabled: 'yes',
      repeat: 'daily',
      repeat_time: '09:00',
      repeat_day: '1',
      delivery: 'webhook',
      webhook_url: 'https://hooks.test/in',
      file_name: 'confirmed-{{ date }}.txt',
      template: '{{ count }} guests',
    });
    form.append('filter_field', 'status');
    form.append('filter_op', 'equals');
    form.append('filter_value', 'confirmed');
    form.append('filter_field', '');
    form.append('filter_op', 'equals');
    form.append('filter_value', '');

    const response = await plugin.fetch(request('/__plugin/admin/actions/new', {
      method: 'POST',
      body: form,
      headers: { 'x-cms-user': cmsUser('admin') },
    }), env());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/plugins/event-actions/actions/901');
    expect(stub.posts).toHaveLength(1);
    const lect = stub.posts[0].lect as Record<string, unknown>;
    expect(stub.posts[0].page_type).toBe('event_action');
    expect(lect._pointers).toEqual({ event: '', mail_list: '77' });
    expect(lect.filter).toEqual([{ field: 'status', op: 'equals', value: 'confirmed' }]);
    expect(lect.filter_mode).toBe('all'); // default when the form sends nothing
    expect(lect.next_run_at).toBeTruthy();
  });

  it('re-renders the form with an error when validation fails', async () => {
    stubCms([eventPage(), listPage()]);
    const form = new URLSearchParams({ name: 'Broken', delivery: 'webhook', webhook_url: 'not-a-url', list_id: '77' });
    const response = await plugin.fetch(request('/__plugin/admin/actions/new', {
      method: 'POST',
      body: form,
      headers: { 'x-cms-user': cmsUser('admin') },
    }), env());
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('needs a webhook URL');
  });

  it('renders the filter row editor with its add/remove enhancement hooks', async () => {
    stubCms([actionPage(), eventPage(), listPage()]);
    const response = await plugin.fetch(request('/__plugin/admin/actions/900', {
      headers: { 'x-cms-user': cmsUser('admin') },
    }), env());
    const html = await renderedText(response);
    expect(html).toContain('data-filter-rows');
    expect(html).toContain('data-filter-add');
    expect(html).toContain('data-filter-remove');
    expect(html).toContain('/admin/plugins/event-actions/assets/filter-rows.js');
    // View-only users get no mutation buttons and no script.
    const readOnly = await plugin.fetch(request('/__plugin/admin/actions/900', {
      headers: { 'x-cms-user': cmsUser('helper', ['event-actions:view']) },
    }), env());
    const readOnlyHtml = await renderedText(readOnly);
    expect(readOnlyHtml).not.toContain('data-filter-add');
    expect(readOnlyHtml).not.toContain('filter-rows.js');
  });

  it('serves the filter-rows asset', async () => {
    const response = await plugin.fetch(request('/__plugin/admin/assets/filter-rows.js'), env());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(await response.text()).toContain('data-filter-row');
  });

  it('serves declared assets at the bare path the CMS approval/proxy flow fetches', async () => {
    // No plugin secret on purpose: the host's approve + serve fetches carry none.
    for (const [file, marker] of [['filter-rows.js', 'data-filter-row'], ['schedule-fields.js', 'data-schedule-repeat']]) {
      const response = await plugin.fetch(new Request(`https://event-actions.test/assets/${file}`), env());
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('javascript');
      expect(await response.text()).toContain(marker);
    }
  });

  it('marks the schedule fields for the per-repeat visibility enhancement', async () => {
    stubCms([actionPage(), eventPage(), listPage()]);
    const response = await plugin.fetch(request('/__plugin/admin/actions/900', {
      headers: { 'x-cms-user': cmsUser('admin') },
    }), env());
    const html = await renderedText(response);
    expect(html).toContain('data-schedule-repeat');
    expect(html).toContain('data-schedule-field="time"');
    expect(html).toContain('data-schedule-field="weekday"');
    expect(html).toContain('data-schedule-field="monthday"');
    expect(html).toContain('/admin/plugins/event-actions/assets/schedule-fields.js');
  });

  it('forbids creation for users without write permission', async () => {
    stubCms([]);
    const response = await plugin.fetch(request('/__plugin/admin/actions/new', {
      method: 'POST',
      body: new URLSearchParams({ name: 'x' }),
      headers: { 'x-cms-user': cmsUser('helper', ['event-actions:view']) },
    }), env());
    expect(response.status).toBe(403);
  });
});

describe('run now', () => {
  it('composes the filtered guests and POSTs the file to the webhook', async () => {
    const stub = stubCms([actionPage(), eventPage(), listPage(), ...GUESTS]);
    const response = await plugin.fetch(request('/__plugin/admin/actions/900/run', { method: 'POST' }), env());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('Run%20complete');
    expect(stub.webhooks).toHaveLength(1);
    const hook = stub.webhooks[0];
    expect(hook.body).toContain('Ada,ada@example.com,confirmed');
    expect(hook.body).toContain('Cyd,cyd@example.com,confirmed');
    expect(hook.body).not.toContain('Bob');
    expect(hook.body).toContain('count=2');
    expect(hook.headers['x-file-name']).toMatch(/^guests-\d{4}-\d{2}-\d{2}\.txt$/);

    // The run is recorded on the action page and replaces the seeded blank row.
    const recorded = stub.puts.find((put) => put.id === 900);
    expect(recorded).toBeTruthy();
    const lect = recorded!.body.lect as { run: Array<Record<string, string>>; last_run_at: string; next_run_at: string };
    expect(lect.run).toHaveLength(1);
    expect(lect.run[0].status).toBe('ok');
    expect(lect.run[0].guest_count).toBe('2');
    expect(lect.last_run_at).toBeTruthy();
    expect(lect.next_run_at).toBe(''); // manual repeat
  });

  it('records a failed run when the webhook rejects', async () => {
    const stub = stubCms([actionPage(), eventPage(), listPage(), ...GUESTS], { webhookStatus: 500 });
    const response = await plugin.fetch(request('/__plugin/admin/actions/900/run', { method: 'POST' }), env());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('Run%20failed');
    const lect = stub.puts.find((put) => put.id === 900)!.body.lect as { run: Array<Record<string, string>> };
    expect(lect.run[0].status).toBe('error');
    expect(lect.run[0].message).toContain('500');
  });

  it('delivers by email with the file attached', async () => {
    const sent: OutboundActionEmail[] = [];
    const stub = stubCms([
      actionPage({ delivery: 'email', email_to: 'ops@example.com, boss@example.com', email_subject: 'Guests {{ date }}' }),
      eventPage(),
      listPage(),
      ...GUESTS,
    ]);
    const response = await plugin.fetch(request('/__plugin/admin/actions/900/run', { method: 'POST' }), env({
      EMAIL: { send: async (message) => { sent.push(message); } },
      EMAIL_FROM: 'actions@test.dev',
    }));
    expect(response.status).toBe(302);
    expect(stub.webhooks).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['ops@example.com', 'boss@example.com']);
    expect(sent[0].subject).toMatch(/^Guests \d{4}-\d{2}-\d{2}$/);
    expect(sent[0].attachments?.[0].filename).toMatch(/^guests-.*\.txt$/);
    expect(sent[0].attachments?.[0].content).toContain('count=2');
  });

  it('fails the run when email delivery is unconfigured', async () => {
    const stub = stubCms([actionPage({ delivery: 'email', email_to: 'ops@example.com' }), eventPage(), listPage(), ...GUESTS]);
    const response = await plugin.fetch(request('/__plugin/admin/actions/900/run', { method: 'POST' }), env());
    expect(response.headers.get('location')).toContain('Run%20failed');
    const lect = stub.puts.find((put) => put.id === 900)!.body.lect as { run: Array<Record<string, string>> };
    expect(lect.run[0].message).toContain('EMAIL');
  });
});

describe('preview', () => {
  it('renders the composed output without delivering', async () => {
    const stub = stubCms([actionPage(), eventPage(), listPage(), ...GUESTS]);
    const response = await plugin.fetch(request('/__plugin/admin/actions/900/preview'), env());
    const html = await renderedText(response);
    expect(html).toContain('Ada,ada@example.com,confirmed');
    expect(html).toContain('2 of 3 guest(s)');
    expect(stub.webhooks).toHaveLength(0);
    expect(stub.puts).toHaveLength(0);
  });

  it('honors OR mode across rules', async () => {
    stubCms([
      actionPage({
        filter_mode: 'any',
        filter: [
          { field: 'status', op: 'equals', value: 'declined' },
          { field: 'rsvp_custom_meal', op: 'not_empty', value: '' },
        ],
      }),
      eventPage(),
      listPage(),
      ...GUESTS,
    ]);
    const response = await plugin.fetch(request('/__plugin/admin/actions/900/preview'), env());
    const html = await renderedText(response);
    expect(html).toContain('Ada'); // has a meal custom input
    expect(html).toContain('Bob'); // declined
    expect(html).not.toContain('Cyd,'); // matches neither rule
  });

  it('gathers guests from every list of the event when no list is set', async () => {
    stubCms([
      actionPage({ _pointers: { mail_list: '', event: '5' }, filter: [] }),
      eventPage(),
      listPage(77),
      listPage(78),
      ...GUESTS,
      guestPage(4, 'Dee', { email: 'dee@example.com', status: 'invited', _pointers: { mail_list: '78' } }),
    ]);
    const response = await plugin.fetch(request('/__plugin/admin/actions/900/preview'), env());
    const html = await renderedText(response);
    expect(html).toContain('Dee,dee@example.com,invited');
    expect(html).toContain('count=4');
  });
});

describe('scheduled runs', () => {
  it('runs due actions and skips disabled, manual and future ones', async () => {
    const due = actionPage({ repeat: 'hourly', next_run_at: '2026-07-10T09:00:00.000Z' }, 900);
    const future = actionPage({ repeat: 'hourly', next_run_at: '2099-01-01T00:00:00.000Z' }, 910);
    const disabled = actionPage({ repeat: 'hourly', next_run_at: '2026-07-10T09:00:00.000Z', enabled: 'no' }, 920);
    const manual = actionPage({}, 930);
    const stub = stubCms([due, future, disabled, manual, eventPage(), listPage(), ...GUESTS]);

    const ran = await runDueActions(
      new CmsClient({ CMS_URL: 'http://cms.test', PLUGIN_SECRET: 'secret' }),
      {},
      new Date('2026-07-10T10:00:00.000Z'),
    );

    expect(ran).toBe(1);
    expect(stub.webhooks).toHaveLength(1);
    const lect = stub.puts.find((put) => put.id === 900)!.body.lect as { next_run_at: string };
    expect(lect.next_run_at).toBe('2026-07-10T11:00:00.000Z');
  });

  it('emails the weekly birthday list: guests whose MM-DD custom input falls in the next 7 days', async () => {
    const sent: OutboundActionEmail[] = [];
    const birthdayAction = actionPage({
      repeat: 'weekly',
      repeat_day: '1',
      repeat_time: '09:00',
      next_run_at: '2026-07-13T09:00:00.000Z', // a Monday
      delivery: 'email',
      email_to: 'gifts@example.com',
      filter: [{ field: 'rsvp_custom_birthday', op: 'date_within_next', value: '7' }],
      template: '{% for g in guests %}{{ g.name }} {{ g.custom.birthday }}\n{% endfor %}',
    }, 900);
    stubCms([
      birthdayAction,
      eventPage(),
      listPage(),
      guestPage(1, 'Ada', { email: 'ada@example.com', rsvp_custom_birthday: '07-15', _pointers: { mail_list: '77' } }),
      guestPage(2, 'Bob', { email: 'bob@example.com', rsvp_custom_birthday: '12-01', _pointers: { mail_list: '77' } }),
      guestPage(3, 'Cyd', { email: 'cyd@example.com', _pointers: { mail_list: '77' } }),
    ]);

    const ran = await runDueActions(
      new CmsClient({ CMS_URL: 'http://cms.test', PLUGIN_SECRET: 'secret' }),
      { EMAIL: { send: async (message: OutboundActionEmail) => { sent.push(message); } }, EMAIL_FROM: 'actions@test.dev' },
      new Date('2026-07-13T09:02:00.000Z'),
    );

    expect(ran).toBe(1);
    expect(sent).toHaveLength(1);
    const attachment = sent[0].attachments?.[0].content ?? '';
    expect(attachment).toContain('Ada 07-15');
    expect(attachment).not.toContain('Bob');
    expect(attachment).not.toContain('Cyd');
  });

  it('seeds next_run_at for scheduled actions missing a stamp, without running them', async () => {
    const unstamped = actionPage({ repeat: 'hourly', next_run_at: '' }, 900);
    const stub = stubCms([unstamped, eventPage(), listPage(), ...GUESTS]);

    const ran = await runDueActions(
      new CmsClient({ CMS_URL: 'http://cms.test', PLUGIN_SECRET: 'secret' }),
      {},
      new Date('2026-07-10T10:00:00.000Z'),
    );

    expect(ran).toBe(0);
    expect(stub.webhooks).toHaveLength(0);
    const lect = stub.puts.find((put) => put.id === 900)!.body.lect as { next_run_at: string };
    expect(lect.next_run_at).toBe('2026-07-10T11:00:00.000Z');
  });
});
