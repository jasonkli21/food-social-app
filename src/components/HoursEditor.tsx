import { View } from 'react-native';
import type { Schedule } from '../types';
import { dayNames, periodText, readSchedule } from '../hours';
import { Button, Chip, Field, T } from './ui';
import { colors } from '../theme';

export type HoursFields = { enabled: boolean; timezone: string; week: string[]; exceptions: string };
export function scheduleFields(schedule?: Schedule | null): HoursFields {
  return { enabled: Boolean(schedule), timezone: schedule?.timezone ?? '',
    week: dayNames.map((_, day) => periodText(schedule?.week[day] ?? [])),
    exceptions: schedule?.exceptions.map(row => row.date + ' ' + periodText(row.periods)).join('\n') ?? '' };
}
export const scheduleValue = (fields: HoursFields) => fields.enabled ? readSchedule(fields.timezone, fields.week, fields.exceptions) : null;

export function HoursEditor({ value, onChange, preview }: { value: HoursFields; onChange: (value: HoursFields) => void; preview: () => void }) {
  return <View style={{ gap: 10 }}>
    <Chip title="Set weekly hours and exceptions" active={value.enabled} onPress={() => onChange({ ...value, enabled: !value.enabled })} />
    {value.enabled && <>
      <Field label="Restaurant timezone" value={value.timezone} onChangeText={timezone => onChange({ ...value, timezone })}
        autoCapitalize="none" placeholder="America/New_York" maxLength={80} />
      <T kind="small" color={colors.muted}>Use 24-hour time. Separate split service with a comma. An end time earlier than its start continues into the next day.</T>
      {dayNames.map((day, index) => <Field key={day} label={day + ' hours'} value={value.week[index] ?? ''}
        onChangeText={text => onChange({ ...value, week: value.week.map((entry, i) => i === index ? text : entry) })}
        placeholder="11:30-15:00, 17:00-22:00 or Closed" maxLength={80} />)}
      <Field label="Date exceptions" value={value.exceptions} onChangeText={exceptions => onChange({ ...value, exceptions })}
        hint="One per line, such as 2026-12-25 Closed. An exception replaces the entire local date." multiline maxLength={3600} />
      <Button title="Preview diner hours" mode="line" onPress={preview} />
    </>}
  </View>;
}
