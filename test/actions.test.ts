import { describe, expect, it } from 'vitest';
import {
  composeFileName,
  composeText,
  computeNextRun,
  guestContext,
  matchesFilters,
  parseFilters,
  type ComposeContext,
  type FilterRule,
} from '../src/actions';
import type { CmsPage } from '../src/cms';

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

  it('requires every rule to match', () => {
    const g = guest({ status: 'confirmed', organization: 'ACME' });
    const both: FilterRule[] = [
      { field: 'status', op: 'equals', value: 'confirmed' },
      { field: 'organization', op: 'contains', value: 'acme' },
    ];
    expect(matchesFilters(g, both)).toBe(true);
    expect(matchesFilters(guest({ status: 'confirmed' }), both)).toBe(false);
  });
});

describe('computeNextRun', () => {
  const from = new Date('2026-07-10T10:00:00.000Z');

  it('returns null for manual actions', () => {
    expect(computeNextRun('manual', '', '', from)).toBeNull();
    expect(computeNextRun('', '', '', from)).toBeNull();
  });

  it('adds the interval for minute/hourly repeats', () => {
    expect(computeNextRun('every_15m', '', '', from)?.toISOString()).toBe('2026-07-10T10:15:00.000Z');
    expect(computeNextRun('hourly', '', '', from)?.toISOString()).toBe('2026-07-10T11:00:00.000Z');
  });

  it('schedules daily at the given UTC time, rolling to tomorrow when passed', () => {
    expect(computeNextRun('daily', '11:30', '', from)?.toISOString()).toBe('2026-07-10T11:30:00.000Z');
    expect(computeNextRun('daily', '09:00', '', from)?.toISOString()).toBe('2026-07-11T09:00:00.000Z');
  });

  it('schedules weekly on the given weekday', () => {
    // 2026-07-10 is a Friday; next Monday is 2026-07-13.
    expect(computeNextRun('weekly', '08:00', '1', from)?.toISOString()).toBe('2026-07-13T08:00:00.000Z');
    // Same weekday but earlier time rolls a full week.
    expect(computeNextRun('weekly', '09:00', '5', from)?.toISOString()).toBe('2026-07-17T09:00:00.000Z');
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
