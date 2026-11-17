import type { HoursPeriod, Schedule } from './types';

export const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (value: number) => String(value).padStart(2, '0');
export const localDate = () => {
  const date = new Date();
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
};
const clock = (minute: number) => pad(Math.floor(minute / 60) % 24) + ':' + pad(minute % 60);
export const periodText = (periods: HoursPeriod[]) => periods.map(p => clock(p.start) + '-' + (p.end === 1440 ? '24:00' : clock(p.end))).join(', ') || 'Closed';

function periods(text: string): HoursPeriod[] {
  if (!text.trim() || /^closed$/i.test(text.trim())) return [];
  return text.split(',').map(value => {
    const match = value.trim().match(/^(\d{2}):(\d{2})\s*[-–]\s*(\d{2}):(\d{2})$/);
    if (!match) throw Error('Use HH:MM-HH:MM, separate split service with a comma, or enter Closed.');
    const h1 = Number(match[1]), m1 = Number(match[2]), h2 = Number(match[3]), m2 = Number(match[4]);
    if (h1 >= 24 || h2 > 24 || m1 >= 60 || m2 >= 60 || (h2 === 24 && m2 !== 0)) throw Error('Check the hours and minutes.');
    const start = h1 * 60 + m1;
    let end = h2 * 60 + m2;
    if (end <= start) end += 1440;
    return { start, end };
  });
}

export function readSchedule(timezone: string, week: string[], dates: string): Schedule {
  const schedule = {
    timezone: timezone.trim(), week: week.map(periods),
    exceptions: dates.split('\n').filter(line => line.trim()).map(line => {
      const match = line.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
      if (!match?.[1] || !match[2] || !Number.isFinite(Date.parse(match[1])) || new Date(match[1]).toISOString().slice(0, 10) !== match[1]) throw Error('Use YYYY-MM-DD followed by service hours or Closed.');
      return { date: match[1], periods: periods(match[2]) };
    }),
  };
  validateSchedule(schedule);
  return schedule;
}

export function validateSchedule(schedule: Schedule) {
  try { new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format(); } catch { throw Error('Choose a valid IANA timezone.'); }
  if (!schedule.timezone || schedule.week.length !== 7 || schedule.exceptions.length > 60) throw Error('Supply a timezone, seven days, and up to 60 exceptions.');
  const validate = (values: HoursPeriod[]) => {
    if (values.length > 4 || values.some((p, i) => !Number.isInteger(p.start) || !Number.isInteger(p.end) ||
      p.start < 0 || p.start >= 1440 || p.end <= p.start || p.end > p.start + 1440 || (i > 0 && p.start < values[i - 1]!.end))) throw Error('Hours must be ordered without overlaps, with up to four periods per day.');
  };
  schedule.week.forEach((values, day) => {
    validate(values);
    const next = schedule.week[(day + 1) % 7] ?? [];
    if (values.length && next.length && values[values.length - 1]!.end > 1440 + next[0]!.start) throw Error('Hours overlap across midnight.');
  });
  const seen = new Set<string>();
  schedule.exceptions.forEach(e => {
    validate(e.periods);
    if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !Number.isFinite(Date.parse(e.date)) || new Date(e.date).toISOString().slice(0, 10) !== e.date) throw Error('Enter a valid exception date.');
    if (seen.has(e.date)) throw Error('Use one exception per date.');
    seen.add(e.date);
    const nextDay = new Date(e.date + 'T12:00:00Z');
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nextDate = nextDay.toISOString().slice(0, 10);
    const next = schedule.week[nextDay.getUTCDay()] ?? [];
    if (!schedule.exceptions.some(row => row.date === nextDate) && e.periods.length && next.length &&
      e.periods[e.periods.length - 1]!.end > 1440 + next[0]!.start) throw Error('Exception hours overlap the next day.');
  });
}

export function hoursStatus(schedule?: Schedule | null, at = new Date()) {
  const unknown = { state: 'unknown' as const, timezone: null, asOf: at.toISOString() };
  if (!schedule) return unknown;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = fields.year + '-' + fields.month + '-' + fields.day;
  const day = new Date(date + 'T12:00:00Z');
  const exception = schedule.exceptions.find(e => e.date === date);
  const today = exception?.periods ?? schedule.week[day.getUTCDay()] ?? [];
  const minute = Number(fields.hour) * 60 + Number(fields.minute);
  day.setUTCDate(day.getUTCDate() - 1);
  const yesterday = schedule.exceptions.find(e => e.date === day.toISOString().slice(0, 10))?.periods ?? schedule.week[day.getUTCDay()] ?? [];
  const open = today.some(p => minute >= p.start && minute < p.end) ||
    (!exception && yesterday.some(p => minute + 1440 >= p.start && minute + 1440 < p.end));
  return { state: open ? 'open' as const : 'closed' as const, timezone: schedule.timezone, asOf: at.toISOString() };
}

export const legacyHours = (schedule: Schedule) => schedule.week.map((values, day) => dayNames[day]!.slice(0, 3) + ' ' +
  (values.map(period => periodText([period]).replace('-', '–') + (period.end > 1440 ? ' (+1)' : '')).join(', ') || 'Closed'));
