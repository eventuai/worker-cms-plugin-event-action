import { describe, expect, it } from 'vitest';
import {
  composeFileName,
  composeText,
  computeNextRun,
  customFieldKeysForScope,
  guestContext,
  matchesFilters,
  parseFilters,
  resolveFilterRules,
  type ComposeContext,
  type FilterRule,
} from '../src/actions';
import type { CmsPage } from '../src/cms';

function page(pageType: string, lect: Record<string, unknown>, id = 1, name = 'Page'): CmsPage {
  return {
    id,
    uuid: `uuid-${id}`,
    page_type: pageType,
    name,
    slug: `page-${id}`,
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    created_at: '',
    updated_at: '',
    lect,
  };
}

/** A `rsvp-custom` block as stored in a page's `_blocks` array. */
function customBlock(id: string, weight: number, labels: string[]): Record<string, unknown> {
  return { _type: 'rsvp-custom', _id: id, _weight: weight, custom_input: labels.map((label) => ({ label })) };
}

function guest(lect: Record<string, unknown>, name = 'Ada', id = 1): CmsPage {
  return {
    id,
    uuid: `uuid-${id}`,
    page_type: 'guest',
    name,
    slug: `guest-${id}`,
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    created_at: '',
    updated_at: '',
    lect,
  };
}

describe('parseFilters', () => {
  it('skips the empty row the host blueprint seeds on create', () => {
    const rules = parseFilters({ filter: [{}, { field: 'status', op: 'equals', value: 'confirmed' }] });
    expect(rules).toEqual([{ field: 'status', op: 'equals', value: 'confirmed' }]);
  });

  it('falls back to equals for unknown operators', () => {
    const rules = parseFilters({ filter: [{ field: 'status', op: 'wat', value: 'x' }] });
    expect(rules[0].op).toBe('equals');
  });
});

describe('matchesFilters', () => {
  const rules = (rule: Partial<FilterRule>): FilterRule[] => [{ field: 'status', op: 'equals', value: '', ...rule } as FilterRule];

  it('matches attributes case-insensitively', () => {
    expect(matchesFilters(guest({ status: 'Confirmed' }), rules({ value: 'confirmed' }))).toBe(true);
    expect(matchesFilters(guest({ status: 'declined' }), rules({ value: 'confirmed' }))).toBe(false);
  });

  it('matches guest custom inputs stored flat in lect', () => {
    const g = guest({ rsvp_custom_meal: 'vegetarian' });
    expect(matchesFilters(g, rules({ field: 'rsvp_custom_meal', op: 'contains', value: 'veg' }))).toBe(true);
    expect(matchesFilters(g, rules({ field: 'rsvp_custom_meal', op: 'not_contains', value: 'beef' }))).toBe(true);
    expect(matchesFilters(g, rules({ field: 'rsvp_custom_meal', op: 'empty' }))).toBe(false);
  });

  it('treats checked_in as yes/no derived from real check-in rows only', () => {
    const seededOnly = guest({ checkin: [{}] });
    const checkedIn = guest({ checkin: [{}, { status: 'checked-in', date: '2026-07-01' }] });
    expect(matchesFilters(seededOnly, rules({ field: 'checked_in', value: 'no' }))).toBe(true);
    expect(matchesFilters(checkedIn, rules({ field: 'checked_in', value: 'yes' }))).toBe(true);
  });

  it('compares numbers for gte/lte', () => {
    const g = guest({ plus_guests: '3' });
    expect(matchesFilters(g, rules({ field: 'plus_guests', op: 'gte', value: '2' }))).toBe(true);
    expect(matchesFilters(g, rules({ field: 'plus_guests', op: 'lte', value: '2' }))).toBe(false);
    expect(matchesFilters(guest({}), rules({ field: 'plus_guests', op: 'gte', value: '0' }))).toBe(false);
  });

  it('matches recurring dates within the next N days (birthday window)', () => {
    const monday = new Date('2026-07-13T09:00:00.000Z'); // weekly Monday run
    const birthday = (value: string) => guest({ rsvp_custom_birthday: value });
    const withinWeek = rules({ field: 'rsvp_custom_birthday', op: 'date_within_next', value: '7' });

    expect(matchesFilters(birthday('07-13'), withinWeek, monday)).toBe(true);  // today
    expect(matchesFilters(birthday('07-19'), withinWeek, monday)).toBe(true);  // Sunday, last covered day
    expect(matchesFilters(birthday('07-20'), withinWeek, monday)).toBe(false); // next Monday's window
    expect(matchesFilters(birthday('07-12'), withinWeek, monday)).toBe(false); // yesterday
    // Year part is ignored; MM/DD works too.
    expect(matchesFilters(birthday('1990-07-15'), withinWeek, monday)).toBe(true);
    expect(matchesFilters(birthday('7/15'), withinWeek, monday)).toBe(true);
    // Unparseable or blank dates never match.
    expect(matchesFilters(birthday('July 15'), withinWeek, monday)).toBe(false);
    expect(matchesFilters(guest({}), withinWeek, monday)).toBe(false);
  });

  it('wraps the date window across the new year', () => {
    const late = new Date('2026-12-29T09:00:00.000Z');
    const withinWeek = rules({ field: 'rsvp_custom_birthday', op: 'date_within_next', value: '7' });
    expect(matchesFilters(guest({ rsvp_custom_birthday: '01-02' }), withinWeek, late)).toBe(true);
    expect(matchesFilters(guest({ rsvp_custom_birthday: '01-05' }), withinWeek, late)).toBe(false);
  });

  it('honors Feb 29 birthdays on Feb 28 in non-leap years', () => {
    const withinDay = rules({ field: 'rsvp_custom_birthday', op: 'date_within_next', value: '1' });
    const leapling = guest({ rsvp_custom_birthday: '02-29' });
    expect(matchesFilters(leapling, withinDay, new Date('2026-02-28T09:00:00.000Z'))).toBe(true); // 2026 is not a leap year
    expect(matchesFilters(leapling, withinDay, new Date('2028-02-28T09:00:00.000Z'))).toBe(false); // 2028 is — the 29th exists
    expect(matchesFilters(leapling, withinDay, new Date('2028-02-29T09:00:00.000Z'))).toBe(true);
  });

  it('renders Liquid filter values with the run clock', async () => {
    const now = new Date('2026-07-13T09:00:00.000Z');
    const resolved = await resolveFilterRules([
      { field: 'rsvp_custom_signup_date', op: 'equals', value: '{{ date }}' },
      { field: 'status', op: 'equals', value: 'confirmed' },
      { field: 'remarks', op: 'contains', value: '{{ broken' },
    ], now);
    expect(resolved[0].value).toBe('2026-07-13');
    expect(resolved[1].value).toBe('confirmed'); // untouched, no Liquid syntax
    expect(resolved[2].value).toBe('{{ broken'); // render failure falls back to the literal
  });

  it('requires every rule to match', () => {
    const g = guest({ status: 'confirmed', organization: 'ACME' });
    const both: FilterRule[] = [
      { field: 'status', op: 'equals', value: 'confirmed' },
      { field: 'organization', op: 'contains', value: 'acme' },
    ];
    expect(matchesFilters(g, both)).toBe(true);
    expect(matchesFilters(guest({ status: 'confirmed' }), both)).toBe(false);
  });

  it('matches set membership with is one of / is none of', () => {
    const g = guest({ status: 'Invited' });
    expect(matchesFilters(g, rules({ op: 'in', value: 'confirmed, invited' }))).toBe(true);
    expect(matchesFilters(g, rules({ op: 'in', value: 'confirmed,declined' }))).toBe(false);
    expect(matchesFilters(g, rules({ op: 'not_in', value: 'confirmed, declined' }))).toBe(true);
    expect(matchesFilters(g, rules({ op: 'not_in', value: 'invited' }))).toBe(false);
    expect(matchesFilters(g, rules({ op: 'in', value: '' }))).toBe(false); // empty set matches nobody
  });

  it('combines rules with OR when the mode is any', () => {
    const now = new Date();
    const either: FilterRule[] = [
      { field: 'status', op: 'equals', value: 'confirmed' },
      { field: 'organization', op: 'contains', value: 'acme' },
    ];
    expect(matchesFilters(guest({ status: 'confirmed' }), either, now, 'any')).toBe(true);
    expect(matchesFilters(guest({ organization: 'ACME Ltd' }), either, now, 'any')).toBe(true);
    expect(matchesFilters(guest({ status: 'declined' }), either, now, 'any')).toBe(false);
    // No rules selects everyone in either mode.
    expect(matchesFilters(guest({}), [], now, 'any')).toBe(true);
  });
});

describe('computeNextRun', () => {
  const from = new Date('2026-07-10T10:00:00.000Z');

  it('returns null for manual actions', () => {
    expect(computeNextRun('manual', '', '', '', from)).toBeNull();
    expect(computeNextRun('', '', '', '', from)).toBeNull();
  });

  it('adds the interval for minute/hourly repeats', () => {
    expect(computeNextRun('every_15m', '', '', '', from)?.toISOString()).toBe('2026-07-10T10:15:00.000Z');
    expect(computeNextRun('hourly', '', '', '', from)?.toISOString()).toBe('2026-07-10T11:00:00.000Z');
  });

  it('schedules daily at the given UTC time, rolling to tomorrow when passed', () => {
    expect(computeNextRun('daily', '11:30', '', '', from)?.toISOString()).toBe('2026-07-10T11:30:00.000Z');
    expect(computeNextRun('daily', '09:00', '', '', from)?.toISOString()).toBe('2026-07-11T09:00:00.000Z');
  });

  it('schedules weekly on the given weekday', () => {
    // 2026-07-10 is a Friday; next Monday is 2026-07-13.
    expect(computeNextRun('weekly', '08:00', '1', '', from)?.toISOString()).toBe('2026-07-13T08:00:00.000Z');
    // Same weekday but earlier time rolls a full week.
    expect(computeNextRun('weekly', '09:00', '5', '', from)?.toISOString()).toBe('2026-07-17T09:00:00.000Z');
  });

  it('schedules monthly on the given date, rolling to next month when passed', () => {
    expect(computeNextRun('monthly', '09:00', '', '15', from)?.toISOString()).toBe('2026-07-15T09:00:00.000Z');
    expect(computeNextRun('monthly', '09:00', '', '5', from)?.toISOString()).toBe('2026-08-05T09:00:00.000Z');
    // Same date but earlier time rolls a full month.
    expect(computeNextRun('monthly', '09:00', '', '10', from)?.toISOString()).toBe('2026-08-10T09:00:00.000Z');
  });

  it('clamps a monthly date past the month end to the last day', () => {
    // Day 31 from mid-February 2026 (non-leap) → Feb 28.
    const feb = new Date('2026-02-10T10:00:00.000Z');
    expect(computeNextRun('monthly', '09:00', '', '31', feb)?.toISOString()).toBe('2026-02-28T09:00:00.000Z');
    // From Jan 31 after the run time → next month is February, still clamped.
    const jan31 = new Date('2026-01-31T10:00:00.000Z');
    expect(computeNextRun('monthly', '09:00', '', '31', jan31)?.toISOString()).toBe('2026-02-28T09:00:00.000Z');
  });
});

describe('composition', () => {
  const context: ComposeContext = {
    action: { id: 900, name: 'Daily export' },
    event: { id: 5, name: 'Gala Dinner' },
    list: { id: 77, name: 'VIP' },
    guests: [
      guestContext(guest({ email: 'ada@example.com', status: 'confirmed', rsvp_custom_meal: 'vegetarian' }, 'Ada')),
      guestContext(guest({ email: 'bob@example.com', status: 'confirmed' }, 'Bob', 2)),
    ],
    count: 2,
    now: '2026-07-10T10:00:00.000Z',
    date: '2026-07-10',
  };

  it('renders the LiquidJS template with guests, custom inputs and totals', async () => {
    const template = '{{ event.name }}\n{% for g in guests %}{{ g.name }} <{{ g.email }}> meal={{ g.custom.meal | default: "none" }}\n{% endfor %}total={{ count }}';
    const output = await composeText(template, context);
    expect(output).toContain('Gala Dinner');
    expect(output).toContain('Ada <ada@example.com> meal=vegetarian');
    expect(output).toContain('Bob <bob@example.com> meal=none');
    expect(output).toContain('total=2');
  });

  it('renders and sanitizes the file name', async () => {
    expect(await composeFileName('guests-{{ date }}.txt', context)).toBe('guests-2026-07-10.txt');
    expect(await composeFileName('a/b:c*"d".txt', context)).toBe('a-b-c-d-.txt');
    expect(await composeFileName('   ', context)).toBe('export.txt');
  });

  it('strips the rsvp_custom prefixes into the custom map', () => {
    const g = guestContext(guest({ rsvp_custom_meal: 'fish', 'rsvp-custom-12-dietary': 'halal' }));
    expect(g.custom).toEqual({ meal: 'fish', '12-dietary': 'halal' });
  });
});

describe('customFieldKeysForScope', () => {
  it('derives rsvp_custom_* keys from an event\'s "RSVP custom information" block', () => {
    const event = page('event', { _blocks: [customBlock('blk1', 0, ['Meal Preference', 'T-Shirt Size'])] });
    expect(customFieldKeysForScope(event, null)).toEqual(['rsvp_custom_meal_preference', 'rsvp_custom_t_shirt_size']);
  });

  it('reads blocks from both the event and the guest list', () => {
    // The list's block is the second `rsvp-custom` block seen overall (by
    // type, not by label), so — matching cms-plugin-events — its keys get the
    // block id folded in even though the labels don't collide with the
    // event's block.
    const event = page('event', { _blocks: [customBlock('e1', 0, ['Meal'])] });
    const list = page('mail_list', { _blocks: [customBlock('l1', 0, ['Dietary Notes'])] });
    expect(customFieldKeysForScope(event, list)).toEqual(['rsvp_custom_meal', 'rsvp_custom_rsvp_custom_l1_dietary_notes']);
  });

  it('folds the block id into the key only for the second-and-later block of a repeated type', () => {
    // Matches cms-plugin-events' adminCustomFieldsForGuest exactly: the first
    // rsvp-custom block seen (here, the event's) keeps a bare key; a second
    // block of the same type (the list's) gets its block id embedded so the
    // two "Meal" fields don't collide.
    const event = page('event', { _blocks: [customBlock('e1', 0, ['Meal'])] });
    const list = page('mail_list', { _blocks: [customBlock('l1', 0, ['Meal'])] });
    expect(customFieldKeysForScope(event, list)).toEqual(['rsvp_custom_meal', 'rsvp_custom_rsvp_custom_l1_meal']);
  });

  it('ignores rsvp-public-form blocks and blocks with no custom_input rows', () => {
    const event = page('event', {
      _blocks: [
        { _type: 'rsvp-public-form', _id: 'pf1', custom_input: [{ name: 'referral', label: 'Referral' }] },
        { _type: 'rsvp-custom', _id: 'empty1', custom_input: [] },
      ],
    });
    expect(customFieldKeysForScope(event, null)).toEqual([]);
  });

  it('returns no keys when neither page is set or neither has a custom block', () => {
    expect(customFieldKeysForScope(null, null)).toEqual([]);
    expect(customFieldKeysForScope(page('event', {}), page('mail_list', {}))).toEqual([]);
  });
});
