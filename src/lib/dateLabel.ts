/**
 * Date labels for library rows ("Today, 14:05", "Yesterday, 09:12",
 * "12 Mar, 09:12", "12 Mar 2025").
 *
 * Every label in one render shares that render's `now`, so the today/yesterday
 * boundary and the same-year check are one snapshot instead of a fresh clock
 * read per row. The formatters are created on first use, so a render that shows
 * no labels creates none, and nothing is kept across renders: midnight, DST and
 * OS locale or timezone changes take effect on the next render.
 */
export function makeSavedWhen(now: Date): (millis: number) => string {
  const todayKey = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = yesterday.toDateString();
  const nowYear = now.getFullYear();

  let time: Intl.DateTimeFormat | null = null;
  let day: Intl.DateTimeFormat | null = null;
  let full: Intl.DateTimeFormat | null = null;

  return (millis) => {
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) return "Saved";
    time ??= new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    const clock = time.format(date);
    const key = date.toDateString();
    if (key === todayKey) return `Today, ${clock}`;
    if (key === yesterdayKey) return `Yesterday, ${clock}`;
    day ??= new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    });
    const shortDay = day.format(date);
    if (date.getFullYear() === nowYear) return `${shortDay}, ${clock}`;
    full ??= new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    return full.format(date);
  };
}
