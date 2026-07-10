// ============================================================
// Event Actions engine.
//
// An "action" is an `event_action` page: it selects guests (by guest list or
// whole event, narrowed by attribute / custom-input filters), composes a text
// file from a LiquidJS template stored on the page, and delivers the file to a
// webhook or an email address. Actions repeat on a schedule (evaluated by the
// cron tick) and can also be run manually from the admin UI.
// ============================================================

import { Liquid } from 'liquidjs';
import { CmsClient, attr, blocks, items, localized, pointer, pageId, type CmsPage } from './cms';

export interface OutboundActionEmail {
  from: string | { email: string; name?: string };
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ content: string; filename: string; type: string; disposition: string }>;
}

export interface ActionEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  /** Cloudflare Email Service binding — required for the email delivery channel. */
  EMAIL?: { send(message: OutboundActionEmail): Promise<unknown> };
  EMAIL_FROM?: string;
}

// ── Filters ───────────────────────────────────────────────────────────────────

export const FILTER_OPS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'not_empty', label: 'is not empty' },
  { value: 'empty', label: 'is empty' },
  { value: 'in', label: 'is one of (comma separated)' },
  { value: 'not_in', label: 'is none of (comma separated)' },
  { value: 'gte', label: '≥ (number)' },
  { value: 'lte', label: '≤ (number)' },
  { value: 'date_within_next', label: 'date (MM-DD) within next N days' },
] as const;

export type FilterOp = (typeof FILTER_OPS)[number]['value'];

export interface FilterRule {
  field: string;
  op: FilterOp;
  value: string;
}

/** How the rules combine: every rule must match (AND) or any one suffices (OR). */
export type FilterMode = 'all' | 'any';

export const FILTER_MODES = [
  { value: 'all', label: 'All rules must match (AND)' },
  { value: 'any', label: 'Any rule may match (OR)' },
] as const;

export function parseFilterMode(lect: Record<string, unknown>): FilterMode {
  return attr(lect, 'filter_mode') === 'any' ? 'any' : 'all';
}

/** Guest attributes offered in the filter field picker; any other lect key
 *  (including `rsvp_custom_*` custom inputs) can be typed in freely. */
export const GUEST_FIELDS = [
  'status', 'email', 'name', 'last_name', 'organization', 'job_title', 'phone',
  'plus_guests', 'prefer_language', 'cc', 'remarks', 'color_tag', 'nationality',
  'checked_in',
] as const;

function customFieldSlug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** "RSVP custom information" blocks (`_type: 'rsvp-custom'`) on an event or
 *  guest list page — the source of admin-defined guest custom inputs. */
function customInputBlocksOf(page: CmsPage | null): Array<{ type: string; id: string; block: Record<string, unknown> }> {
  if (!page) return [];
  return blocks(page.lect)
    .map((block, index) => ({
      type: attr(block, '_type'),
      id: attr(block, '_id') || String(block._index ?? block._weight ?? index),
      block,
    }))
    .filter((entry) => entry.type === 'rsvp-custom' && items(entry.block, 'custom_input').length > 0);
}

/**
 * Custom-input keys (`rsvp_custom_*`) declared by "RSVP custom information"
 * blocks on the event and/or guest list, for suggesting real filter field
 * names. Mirrors cms-plugin-events' own key derivation
 * (`rsvp.ts` `adminCustomFieldsForGuest`) exactly — including the rule that
 * only the second-and-later block of the same type gets its block id folded
 * into the key — so a suggested key always matches what's actually stored on
 * a guest who has answered it. Only `rsvp-custom` blocks count (not
 * `rsvp-public-form`, whose fields belong to public visitor registration,
 * not the guest-list admin form).
 */
export function customFieldKeysForScope(event: CmsPage | null, list: CmsPage | null): string[] {
  const keys = new Set<string>();
  const seenTypes = new Set<string>();
  for (const source of [...customInputBlocksOf(event), ...customInputBlocksOf(list)]) {
    const includeBlockId = seenTypes.has(source.type);
    seenTypes.add(source.type);
    const blockKey = includeBlockId ? `${source.type}-${source.id}` : source.type;
    for (const input of items(source.block, 'custom_input')) {
      const label = localized(input, 'label') || attr(input, 'label') || attr(input, 'name');
      if (!label) continue;
      keys.add(`rsvp_custom_${includeBlockId ? `${customFieldSlug(blockKey)}_` : ''}${customFieldSlug(label)}`);
    }
  }
  return [...keys].sort();
}

const VALID_OPS = new Set<string>(FILTER_OPS.map((op) => op.value));

/**
 * Filter rows stored on the action page. The host seeds every nested blueprint
 * block with one empty item on create, so rows without a field are skipped —
 * never treat `items(...).length` as "has filters".
 */
export function parseFilters(lect: Record<string, unknown>): FilterRule[] {
  return items(lect, 'filter')
    .map((row) => ({
      field: String(row.field ?? '').trim(),
      op: (VALID_OPS.has(String(row.op ?? '')) ? String(row.op) : 'equals') as FilterOp,
      value: String(row.value ?? ''),
    }))
    .filter((rule) => rule.field !== '');
}

/**
 * Real check-in entries for a guest. Same seeding caveat as above: a row
 * counts only once it carries an actual status or date.
 */
export function checkins(lect: Record<string, unknown>): Array<Record<string, unknown>> {
  return items(lect, 'checkin').filter(
    (entry) => String(entry.status ?? '').trim() !== '' || String(entry.date ?? '').trim() !== '',
  );
}

/** A guest's value for a filter field / template column, always as a string. */
export function guestFieldValue(guest: CmsPage, field: string): string {
  if (field === 'name') return guest.name ?? '';
  if (field === 'last_name') return localized(guest.lect, 'last_name');
  if (field === 'checked_in') return checkins(guest.lect).length > 0 ? 'yes' : 'no';
  return attr(guest.lect, field);
}

/** Month/day parsed from a guest date field: `MM-DD`, `MM/DD` or
 *  `YYYY-MM-DD` (the year is ignored — anniversaries recur). */
function parseMonthDay(raw: string): { month: number; day: number } | null {
  const text = raw.trim();
  const match = /^(?:\d{4}-)?(\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day } : null;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function matchesMonthDay(date: Date, md: { month: number; day: number }): boolean {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  if (month === md.month && day === md.day) return true;
  // Feb 29 anniversaries are honored on Feb 28 in non-leap years.
  return md.month === 2 && md.day === 29 && month === 2 && day === 28 && !isLeapYear(date.getUTCFullYear());
}

export function matchesFilter(guest: CmsPage, rule: FilterRule, now = new Date()): boolean {
  const raw = guestFieldValue(guest, rule.field);
  const value = raw.trim().toLowerCase();
  const expected = rule.value.trim().toLowerCase();
  switch (rule.op) {
    case 'equals': return value === expected;
    case 'not_equals': return value !== expected;
    case 'contains': return expected !== '' && value.includes(expected);
    case 'not_contains': return expected === '' || !value.includes(expected);
    case 'empty': return value === '';
    case 'not_empty': return value !== '';
    // Set membership — the per-field OR: `status is one of confirmed, invited`.
    case 'in': return expectedList(rule).includes(value);
    case 'not_in': return !expectedList(rule).includes(value);
    case 'gte': {
      const [a, b] = [Number.parseFloat(raw), Number.parseFloat(rule.value)];
      return Number.isFinite(a) && Number.isFinite(b) && a >= b;
    }
    case 'lte': {
      const [a, b] = [Number.parseFloat(raw), Number.parseFloat(rule.value)];
      return Number.isFinite(a) && Number.isFinite(b) && a <= b;
    }
    // Recurring-date window (birthdays, anniversaries): matches when the
    // field's month/day falls on any of the next N days counting today
    // (UTC), across year boundaries. A weekly Monday run with N=7 covers
    // Mon..Sun with no gap or overlap.
    case 'date_within_next': {
      const md = parseMonthDay(raw);
      const days = Number.parseInt(rule.value, 10);
      if (!md || !Number.isFinite(days) || days <= 0) return false;
      for (let offset = 0; offset < Math.min(days, 366); offset++) {
        const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
        if (matchesMonthDay(candidate, md)) return true;
      }
      return false;
    }
  }
}

function expectedList(rule: FilterRule): string[] {
  return rule.value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

export function matchesFilters(guest: CmsPage, rules: FilterRule[], now = new Date(), mode: FilterMode = 'all'): boolean {
  if (!rules.length) return true; // no rules selects everyone, in either mode
  return mode === 'any'
    ? rules.some((rule) => matchesFilter(guest, rule, now))
    : rules.every((rule) => matchesFilter(guest, rule, now));
}

/**
 * Makes filter values dynamic: a value containing Liquid syntax is rendered
 * with the run clock before matching, so e.g. `{{ date }}` compares against
 * the day the action runs instead of the day it was saved. A value that fails
 * to render is used literally.
 */
export async function resolveFilterRules(rules: FilterRule[], now: Date): Promise<FilterRule[]> {
  const context = { now: now.toISOString(), date: now.toISOString().slice(0, 10) };
  return Promise.all(rules.map(async (rule) => {
    if (!rule.value.includes('{{') && !rule.value.includes('{%')) return rule;
    try {
      const rendered = String(await composeEngine.parseAndRender(rule.value, context)).trim();
      return { ...rule, value: rendered };
    } catch {
      return rule;
    }
  }));
}

// ── Schedule ──────────────────────────────────────────────────────────────────

export const REPEAT_OPTIONS = [
  { value: 'manual', label: 'Manual only (Run now button)' },
  { value: 'every_5m', label: 'Every 5 minutes' },
  { value: 'every_15m', label: 'Every 15 minutes' },
  { value: 'every_30m', label: 'Every 30 minutes' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Daily at a set time (UTC)' },
  { value: 'weekly', label: 'Weekly on a set day (UTC)' },
  { value: 'monthly', label: 'Monthly on a set date (UTC)' },
] as const;

export type RepeatKind = (typeof REPEAT_OPTIONS)[number]['value'];

const INTERVAL_MS: Partial<Record<RepeatKind, number>> = {
  every_5m: 5 * 60_000,
  every_15m: 15 * 60_000,
  every_30m: 30 * 60_000,
  hourly: 60 * 60_000,
};

function parseTimeOfDay(time: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hours = match ? Number(match[1]) : 0;
  const minutes = match ? Number(match[2]) : 0;
  return hours < 24 && minutes < 60 ? { hours, minutes } : { hours: 0, minutes: 0 };
}

/**
 * The next moment (strictly after `from`) this schedule should fire, or null
 * for manual-only actions. Daily/weekly/monthly times are interpreted in UTC.
 * A monthly date past a month's end runs on that month's last day (the 31st →
 * Apr 30, Feb 28/29) instead of silently skipping the month.
 */
export function computeNextRun(repeat: string, repeatTime: string, repeatDay: string, repeatDate: string, from: Date): Date | null {
  const interval = INTERVAL_MS[repeat as RepeatKind];
  if (interval) return new Date(from.getTime() + interval);

  if (repeat === 'daily' || repeat === 'weekly') {
    const { hours, minutes } = parseTimeOfDay(repeatTime);
    const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hours, minutes, 0, 0));
    if (repeat === 'daily') {
      if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
    const day = Math.min(6, Math.max(0, Number.parseInt(repeatDay, 10) || 0));
    while (next.getUTCDay() !== day || next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  if (repeat === 'monthly') {
    const { hours, minutes } = parseTimeOfDay(repeatTime);
    const date = Math.min(31, Math.max(1, Number.parseInt(repeatDate, 10) || 1));
    for (let offset = 0; ; offset++) {
      const month = from.getUTCMonth() + offset;
      // Day 0 of the following month = this month's last day.
      const lastDay = new Date(Date.UTC(from.getUTCFullYear(), month + 1, 0)).getUTCDate();
      const candidate = new Date(Date.UTC(from.getUTCFullYear(), month, Math.min(date, lastDay), hours, minutes, 0, 0));
      if (candidate.getTime() > from.getTime()) return candidate;
    }
  }

  return null; // manual / unknown
}

// ── Composition ───────────────────────────────────────────────────────────────

export const DEFAULT_TEMPLATE = `Guest export for {{ event.name | default: list.name }} — generated {{ now }}

{% for guest in guests -%}
{{ guest.name }}{% if guest.last_name != blank %} {{ guest.last_name }}{% endif %} | {{ guest.email }} | {{ guest.status }}
{% endfor -%}

Total guests: {{ count }}
`;

export const DEFAULT_FILE_NAME = 'guests-{{ date }}.txt';

export interface GuestContext {
  id: number;
  name: string;
  last_name: string;
  email: string;
  phone: string;
  organization: string;
  job_title: string;
  status: string;
  plus_guests: string;
  prefer_language: string;
  cc: string;
  remarks: string;
  color_tag: string;
  nationality: string;
  checked_in: boolean;
  /** Custom-input answers (`rsvp_custom_*` / legacy `rsvp-custom-*` lect keys), prefix stripped. */
  custom: Record<string, string>;
  list_id: number | null;
  list_name: string;
}

const CUSTOM_PREFIX = /^(rsvp_custom_|rsvp-custom-)/;

export function guestContext(guest: CmsPage, list?: CmsPage | null): GuestContext {
  const custom: Record<string, string> = {};
  for (const [key, value] of Object.entries(guest.lect)) {
    if (!CUSTOM_PREFIX.test(key) || value == null || typeof value === 'object') continue;
    custom[key.replace(CUSTOM_PREFIX, '')] = String(value);
  }
  return {
    id: guest.id,
    name: guest.name ?? '',
    last_name: localized(guest.lect, 'last_name'),
    email: attr(guest.lect, 'email'),
    phone: attr(guest.lect, 'phone'),
    organization: attr(guest.lect, 'organization'),
    job_title: attr(guest.lect, 'job_title'),
    status: attr(guest.lect, 'status') || 'to be invited',
    plus_guests: attr(guest.lect, 'plus_guests'),
    prefer_language: attr(guest.lect, 'prefer_language'),
    cc: attr(guest.lect, 'cc'),
    remarks: attr(guest.lect, 'remarks'),
    color_tag: attr(guest.lect, 'color_tag'),
    nationality: attr(guest.lect, 'nationality'),
    checked_in: checkins(guest.lect).length > 0,
    custom,
    list_id: list?.id ?? null,
    list_name: list?.name ?? '',
  };
}

export interface ComposeContext {
  action: { id: number; name: string };
  event: { id: number | null; name: string };
  list: { id: number | null; name: string };
  guests: GuestContext[];
  count: number;
  now: string;
  date: string;
}

/** One shared engine for the user-authored templates. No file system access —
 *  templates are single self-contained strings, so include/render are unavailable. */
const composeEngine = new Liquid({ cache: false, relativeReference: false });

export async function composeText(templateSource: string, context: ComposeContext): Promise<string> {
  return String(await composeEngine.parseAndRender(templateSource, context as unknown as Record<string, unknown>));
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]+/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned || 'export.txt';
}

export async function composeFileName(templateSource: string, context: ComposeContext): Promise<string> {
  const rendered = await composeText(templateSource || DEFAULT_FILE_NAME, { ...context, guests: [] });
  return sanitizeFileName(rendered);
}

// ── Guest gathering ───────────────────────────────────────────────────────────

export interface GatheredGuests {
  event: CmsPage | null;
  list: CmsPage | null;
  /** Matching guests, each paired with the list it belongs to. */
  guests: Array<{ guest: CmsPage; list: CmsPage | null }>;
  totalBeforeFilters: number;
}

/**
 * Resolves the action's audience: a single guest list when the `mail_list`
 * pointer is set, otherwise every list of the pointed event. Filters then
 * narrow the set by guest attributes / custom inputs.
 */
export async function gatherGuests(cms: CmsClient, action: CmsPage, now = new Date()): Promise<GatheredGuests> {
  const listId = pageId(pointer(action.lect, 'mail_list'));
  const eventId = pageId(pointer(action.lect, 'event'));
  const rules = await resolveFilterRules(parseFilters(action.lect), now);
  const mode = parseFilterMode(action.lect);

  let event: CmsPage | null = null;
  const lists: CmsPage[] = [];
  if (listId) {
    const list = await cms.get(listId);
    if (list.page_type !== 'mail_list') throw new Error(`Page ${listId} is not a guest list`);
    lists.push(list);
    const listEventId = pageId(pointer(list.lect, 'event'));
    if (listEventId) event = await cms.get(listEventId).catch(() => null);
  } else if (eventId) {
    event = await cms.get(eventId);
    if (event.page_type !== 'event') throw new Error(`Page ${eventId} is not an event`);
    lists.push(...await cms.listAll('mail_list', { pointer: { key: 'event', value: eventId } }));
  } else {
    throw new Error('The action has no guest list or event selected');
  }

  const guests: Array<{ guest: CmsPage; list: CmsPage | null }> = [];
  let total = 0;
  for (const list of lists) {
    const listGuests = await cms.listAll('guest', { pointer: { key: 'mail_list', value: list.id } });
    total += listGuests.length;
    for (const guest of listGuests) {
      if (matchesFilters(guest, rules, now, mode)) guests.push({ guest, list });
    }
  }

  return { event, list: listId ? lists[0] : null, guests, totalBeforeFilters: total };
}

// ── Delivery ──────────────────────────────────────────────────────────────────

export type DeliveryKind = 'webhook' | 'email';

async function deliverWebhook(url: string, fileName: string, content: string, actionName: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Webhook URL must start with http:// or https://');
  const response = await globalThis.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName.replace(/"/g, "'")}"`,
      'x-event-action': actionName,
      'x-file-name': fileName,
    },
    body: content,
  });
  if (!response.ok) throw new Error(`Webhook responded ${response.status}`);
}

async function deliverEmail(
  env: ActionEnv,
  to: string,
  subject: string,
  fileName: string,
  content: string,
): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM) throw new Error('EMAIL and EMAIL_FROM must be configured before email delivery');
  const recipients = to.split(/[,;\s]+/).map((address) => address.trim()).filter(Boolean);
  if (!recipients.length) throw new Error('The action has no email recipient');
  await env.EMAIL.send({
    from: env.EMAIL_FROM,
    to: recipients,
    subject,
    text: `The file "${fileName}" produced by this event action is attached.`,
    html: `<p>The file <strong>${escapeHtml(fileName)}</strong> produced by this event action is attached.</p>`,
    attachments: [{ content, filename: fileName, type: 'text/plain; charset=utf-8', disposition: 'attachment' }],
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string
  ));
}

// ── Run pipeline ──────────────────────────────────────────────────────────────

export interface RunResult {
  ok: boolean;
  message: string;
  guestCount: number;
  delivery: string;
  fileName: string;
  output: string;
}

export const RUN_LOG_LIMIT = 20;

function composeContext(action: CmsPage, gathered: GatheredGuests, now: Date): ComposeContext {
  return {
    action: { id: action.id, name: action.name },
    event: { id: gathered.event?.id ?? null, name: gathered.event?.name ?? '' },
    list: { id: gathered.list?.id ?? null, name: gathered.list?.name ?? '' },
    guests: gathered.guests.map(({ guest, list }) => guestContext(guest, list)),
    count: gathered.guests.length,
    now: now.toISOString(),
    date: now.toISOString().slice(0, 10),
  };
}

/** Composes the file for the action's current audience without delivering it. */
export async function previewAction(cms: CmsClient, action: CmsPage, now = new Date()): Promise<{
  fileName: string;
  output: string;
  guestCount: number;
  totalBeforeFilters: number;
}> {
  const gathered = await gatherGuests(cms, action, now);
  const context = composeContext(action, gathered, now);
  const template = attr(action.lect, 'template') || DEFAULT_TEMPLATE;
  return {
    fileName: await composeFileName(attr(action.lect, 'file_name'), context),
    output: await composeText(template, context),
    guestCount: gathered.guests.length,
    totalBeforeFilters: gathered.totalBeforeFilters,
  };
}

/**
 * Executes one action end to end: gather → compose → deliver, then writes the
 * outcome back to the action page (run log capped at RUN_LOG_LIMIT, last/next
 * run stamps). Failures are recorded, not thrown — and next_run_at still
 * advances so a failing action can't retry on every cron tick.
 */
export async function runAction(
  cms: CmsClient,
  env: ActionEnv,
  action: CmsPage,
  opts: { now?: Date; trigger?: 'manual' | 'schedule' } = {},
): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const delivery = (attr(action.lect, 'delivery') || 'webhook') as DeliveryKind;
  let result: RunResult;

  try {
    const gathered = await gatherGuests(cms, action, now);
    const context = composeContext(action, gathered, now);
    const template = attr(action.lect, 'template') || DEFAULT_TEMPLATE;
    const output = await composeText(template, context);
    const fileName = await composeFileName(attr(action.lect, 'file_name'), context);

    if (delivery === 'email') {
      const subjectTemplate = attr(action.lect, 'email_subject') || `${action.name} — {{ date }}`;
      const subject = (await composeText(subjectTemplate, { ...context, guests: [] })).trim() || action.name;
      await deliverEmail(env, attr(action.lect, 'email_to'), subject, fileName, output);
    } else {
      await deliverWebhook(attr(action.lect, 'webhook_url'), fileName, output, action.name);
    }

    result = {
      ok: true,
      message: `Delivered ${fileName} to ${delivery === 'email' ? attr(action.lect, 'email_to') : 'webhook'}`,
      guestCount: gathered.guests.length,
      delivery,
      fileName,
      output,
    };
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      guestCount: 0,
      delivery,
      fileName: '',
      output: '',
    };
  }

  await recordRun(cms, action, result, now).catch((error) => {
    console.error(`[event-actions] unable to record run for action ${action.id}`, error);
  });
  return result;
}

/** Appends the run to the action's log and advances the schedule stamps. */
async function recordRun(cms: CmsClient, action: CmsPage, result: RunResult, now: Date): Promise<void> {
  const entry = {
    date: now.toISOString(),
    status: result.ok ? 'ok' : 'error',
    message: result.message,
    guest_count: String(result.guestCount),
    delivery: result.delivery,
  };
  // Newest first; skip seeded/blank rows so the first real run replaces the
  // empty item the host blueprint seeds on create.
  const previous = items(action.lect, 'run').filter((row) => String(row.date ?? '').trim() !== '');
  const runs = [entry, ...previous].slice(0, RUN_LOG_LIMIT);
  const next = computeNextRun(attr(action.lect, 'repeat'), attr(action.lect, 'repeat_time'), attr(action.lect, 'repeat_day'), attr(action.lect, 'repeat_date'), now);
  await cms.update(action.id, {
    lect: {
      run: runs,
      last_run_at: now.toISOString(),
      next_run_at: next ? next.toISOString() : '',
    },
  });
}

/** True when the cron tick should execute this action now. */
export function isDue(action: CmsPage, now: Date): boolean {
  if (attr(action.lect, 'enabled') !== 'yes') return false;
  const repeat = attr(action.lect, 'repeat');
  if (!repeat || repeat === 'manual') return false;
  const nextAt = Date.parse(attr(action.lect, 'next_run_at'));
  return Number.isFinite(nextAt) && nextAt <= now.getTime();
}

/**
 * Cron entry point: runs every enabled action whose next_run_at has passed.
 * Actions with a schedule but no stamp yet (created before scheduling was
 * saved, or edited by hand) get their next_run_at seeded without running.
 */
export async function runDueActions(cms: CmsClient, env: ActionEnv, now = new Date()): Promise<number> {
  const actions = await cms.listAll('event_action');
  let ran = 0;
  for (const action of actions) {
    const repeat = attr(action.lect, 'repeat');
    if (attr(action.lect, 'enabled') !== 'yes' || !repeat || repeat === 'manual') continue;
    if (!attr(action.lect, 'next_run_at')) {
      const next = computeNextRun(repeat, attr(action.lect, 'repeat_time'), attr(action.lect, 'repeat_day'), attr(action.lect, 'repeat_date'), now);
      if (next) {
        await cms.update(action.id, { lect: { next_run_at: next.toISOString() } })
          .catch((error) => console.error(`[event-actions] unable to seed next_run_at for action ${action.id}`, error));
      }
      continue;
    }
    if (!isDue(action, now)) continue;
    try {
      await runAction(cms, env, action, { now, trigger: 'schedule' });
      ran += 1;
    } catch (error) {
      console.error(`[event-actions] scheduled run failed for action ${action.id}`, error);
    }
  }
  return ran;
}
