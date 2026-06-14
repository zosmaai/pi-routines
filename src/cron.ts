/**
 * Cron expression parser and next-run calculator.
 * Port of Claude Code's src/utils/cron.ts.
 *
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week
 * Also supports 6-field cron: second minute hour day-of-month month day-of-week
 */

export interface CronFields {
  second: number[];
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let range: string;
    let step = 1;

    if (stepMatch) {
      range = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
      if (step === 0) throw new Error(`Invalid step value: 0`);
    } else {
      range = part;
    }

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes("-")) {
      const [startStr, endStr] = range.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max) {
        throw new Error(`Invalid range: ${range}`);
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else {
      const val = parseInt(range, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Invalid value: ${range} (must be ${min}-${max})`);
      }
      if (stepMatch) {
        for (let i = val; i <= max; i += step) values.add(i);
      } else {
        values.add(val);
      }
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function replaceName(field: string, names: Record<string, number>): string {
  let result = field.toLowerCase();
  for (const [name, num] of Object.entries(names)) {
    result = result.replaceAll(name, String(num));
  }
  return result;
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  let second: number[];
  let minute: number[];
  let hour: number[];
  let dayOfMonth: number[];
  let month: number[];
  let dayOfWeek: number[];

  if (parts.length === 6) {
    second = parseField(parts[0], 0, 59);
    minute = parseField(parts[1], 0, 59);
    hour = parseField(parts[2], 0, 23);
    dayOfMonth = parseField(parts[3], 1, 31);
    month = parseField(replaceName(parts[4], MONTH_NAMES), 1, 12);
    dayOfWeek = parseField(replaceName(parts[5], DAY_NAMES), 0, 7).map(
      (d) => (d === 7 ? 0 : d),
    );
  } else if (parts.length === 5) {
    second = [0];
    minute = parseField(parts[0], 0, 59);
    hour = parseField(parts[1], 0, 23);
    dayOfMonth = parseField(parts[2], 1, 31);
    month = parseField(replaceName(parts[3], MONTH_NAMES), 1, 12);
    dayOfWeek = parseField(replaceName(parts[4], DAY_NAMES), 0, 7).map(
      (d) => (d === 7 ? 0 : d),
    );
  } else {
    throw new Error(
      `Invalid cron expression: expected 5 or 6 fields, got ${parts.length}`,
    );
  }

  return { second, minute, hour, dayOfMonth, month, dayOfWeek };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Compute the next time a cron expression should fire after `after`.
 * Returns a Date or null if no valid time is found within 4 years (safety limit).
 */
export function computeNextCronRun(
  expression: string,
  after: Date = new Date(),
): Date | null {
  const fields = parseCron(expression);
  const maxDate = new Date(after);
  maxDate.setFullYear(maxDate.getFullYear() + 4);

  const d = new Date(after);
  d.setMilliseconds(0);
  d.setSeconds(d.getSeconds() + 1);

  // Align to next valid second
  const findNext = (arr: number[], current: number): number | null => {
    for (const v of arr) {
      if (v >= current) return v;
    }
    return null;
  };

  let iterations = 0;
  const MAX_ITERATIONS = 366 * 24 * 60 * 60; // ~1 year in seconds as safety

  while (d <= maxDate && iterations++ < MAX_ITERATIONS) {
    // Month
    if (!fields.month.includes(d.getMonth() + 1)) {
      const nextMonth = findNext(fields.month, d.getMonth() + 2);
      if (nextMonth !== null) {
        d.setMonth(nextMonth - 1, 1);
        d.setHours(0, 0, 0, 0);
      } else {
        d.setFullYear(d.getFullYear() + 1, fields.month[0] - 1, 1);
        d.setHours(0, 0, 0, 0);
      }
      continue;
    }

    // Day of month
    if (!fields.dayOfMonth.includes(d.getDate())) {
      const nextDay = findNext(fields.dayOfMonth, d.getDate() + 1);
      if (
        nextDay !== null &&
        nextDay <= daysInMonth(d.getFullYear(), d.getMonth() + 1)
      ) {
        d.setDate(nextDay);
        d.setHours(0, 0, 0, 0);
      } else {
        d.setMonth(d.getMonth() + 1, 1);
        d.setHours(0, 0, 0, 0);
      }
      continue;
    }

    // Day of week
    if (!fields.dayOfWeek.includes(d.getDay())) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    // Hour
    if (!fields.hour.includes(d.getHours())) {
      const nextHour = findNext(fields.hour, d.getHours() + 1);
      if (nextHour !== null) {
        d.setHours(nextHour, 0, 0, 0);
      } else {
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
      }
      continue;
    }

    // Minute
    if (!fields.minute.includes(d.getMinutes())) {
      const nextMin = findNext(fields.minute, d.getMinutes() + 1);
      if (nextMin !== null) {
        d.setMinutes(nextMin, 0, 0);
      } else {
        d.setHours(d.getHours() + 1, 0, 0, 0);
      }
      continue;
    }

    // Second
    if (!fields.second.includes(d.getSeconds())) {
      const nextSec = findNext(fields.second, d.getSeconds() + 1);
      if (nextSec !== null) {
        d.setSeconds(nextSec, 0);
      } else {
        d.setMinutes(d.getMinutes() + 1, 0, 0);
      }
      continue;
    }

    return new Date(d);
  }

  return null;
}

/**
 * Parse a simple interval string (e.g., "5m", "1h", "30s") into milliseconds.
 */
export function parseInterval(interval: string): number | null {
  const match = interval.trim().match(/^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit.startsWith("s")) return value * 1000;
  if (unit.startsWith("m")) return value * 60 * 1000;
  if (unit.startsWith("h")) return value * 60 * 60 * 1000;
  if (unit.startsWith("d")) return value * 24 * 60 * 60 * 1000;

  return null;
}

/**
 * Convert a millisecond interval to a cron expression that fires at that interval.
 * Only handles common cases: minutes, hours.
 */
export function intervalToCron(intervalMs: number): string | null {
  const minutes = intervalMs / (60 * 1000);
  const hours = intervalMs / (60 * 60 * 1000);

  if (minutes < 1) return null;

  if (Number.isInteger(minutes) && minutes <= 59) {
    return `*/${Math.round(minutes)} * * * *`;
  }
  if (Number.isInteger(hours) && hours <= 23) {
    return `0 */${Math.round(hours)} * * *`;
  }
  if (minutes === 60) {
    return "0 * * * *";
  }

  // For arbitrary intervals that don't map cleanly, use minute-level approximation
  if (minutes < 60) {
    return `*/${Math.round(minutes)} * * * *`;
  }

  return `0 */${Math.max(1, Math.round(hours))} * * *`;
}
