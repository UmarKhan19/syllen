import { describe, expect, it } from "vitest";
import { makeSavedWhen } from "./dateLabel";

const DAY = 86_400_000;

// The pre-change implementation from src/App.tsx, with the clock pinned instead
// of read per row. Oracle only: the shipped code is makeSavedWhen.
function savedWhenBefore(millis: number, now: Date): string {
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return "Saved";
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${time}`;
  }
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return date.getFullYear() === now.getFullYear()
    ? `${day}, ${time}`
    : date.toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

const NOW = new Date(2026, 2, 30, 12, 0, 0);
const midnight = new Date(NOW);
midnight.setHours(0, 0, 0, 0);
const yesterdayMidnight = new Date(midnight);
yesterdayMidnight.setDate(midnight.getDate() - 1);
const yearAgo = new Date(NOW);
yearAgo.setFullYear(NOW.getFullYear() - 1);

const CASES: Array<{ label: string; millis: number }> = [
  { label: "now", millis: NOW.getTime() },
  { label: "just before now", millis: NOW.getTime() - 1 },
  { label: "today midnight", millis: midnight.getTime() },
  { label: "today last minute", millis: midnight.getTime() + 59_999 },
  { label: "just before midnight", millis: midnight.getTime() - 1 },
  { label: "yesterday midnight", millis: yesterdayMidnight.getTime() },
  { label: "two days ago", millis: yesterdayMidnight.getTime() - 1 },
  { label: "two days in ms", millis: NOW.getTime() - 2 * DAY },
  { label: "200 days ago", millis: NOW.getTime() - 200 * DAY },
  { label: "previous year", millis: yearAgo.getTime() },
  { label: "previous year minus 5 days", millis: yearAgo.getTime() - 5 * DAY },
  { label: "invalid", millis: Number.NaN },
  // Instants around common DST switches; text must stay identical in any zone.
  { label: "dst eu start", millis: new Date(2026, 2, 29, 2, 30).getTime() },
  { label: "dst eu end", millis: new Date(2026, 9, 25, 2, 30).getTime() },
  { label: "dst us start", millis: new Date(2026, 2, 8, 2, 30).getTime() },
];

function countFormatters<T>(run: () => T): { value: T; created: number } {
  const Real = Intl.DateTimeFormat;
  let created = 0;
  const Counting = new Proxy(Real, {
    construct(target, args) {
      created += 1;
      return Reflect.construct(target, args);
    },
  });
  Intl.DateTimeFormat = Counting as unknown as typeof Intl.DateTimeFormat;
  try {
    return { value: run(), created };
  } finally {
    Intl.DateTimeFormat = Real;
  }
}

describe("makeSavedWhen", () => {
  it("matches the previous labels for every relative, invalid and DST case", () => {
    const label = makeSavedWhen(NOW);
    for (const { label: name, millis } of CASES) {
      expect(label(millis), name).toBe(savedWhenBefore(millis, NOW));
    }
  });

  it("reuses its formatters across rows in one render", () => {
    const rows = [
      NOW.getTime(),
      midnight.getTime() + 3_600_000,
      yesterdayMidnight.getTime() + 60_000,
      NOW.getTime() - 2 * DAY,
      yearAgo.getTime(),
      Number.NaN,
    ];
    const { value, created } = countFormatters(() => {
      const label = makeSavedWhen(NOW);
      return rows.map((millis) => label(millis));
    });
    expect(created).toBeLessThanOrEqual(3);
    expect(value.map((text) => text.length > 0)).toEqual(rows.map(() => true));
  });

  it("creates no formatter until a label is asked for", () => {
    const { created } = countFormatters(() => makeSavedWhen(NOW));
    expect(created).toBe(0);
  });

  it("refreshes the today boundary with a new render snapshot", () => {
    const rowAtNoon = NOW.getTime();
    const firstRender = makeSavedWhen(NOW);
    const nextDayRender = makeSavedWhen(new Date(NOW.getTime() + DAY));

    const today = firstRender(rowAtNoon);
    const tomorrow = nextDayRender(rowAtNoon);
    expect(today.startsWith("Today, ")).toBe(true);
    expect(tomorrow.startsWith("Yesterday, ")).toBe(true);
    expect(tomorrow.slice("Yesterday, ".length)).toBe(today.slice("Today, ".length));
  });
});
