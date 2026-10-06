const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const relative = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });

/**
 * When a session was last seen, as the Devices page says it. Sessions note
 * their last use at most once an hour, so nothing finer is claimed.
 */
export function lastSeen(then: Date, now: Date): string {
  const ms = now.getTime() - then.getTime();
  if (ms < HOUR_MS) return "within the last hour";
  if (ms < DAY_MS) return relative.format(-Math.floor(ms / HOUR_MS), "hour");
  return relative.format(-Math.floor(ms / DAY_MS), "day");
}

/** A stopwatch reading, "1:05" or "1:02:05", in whole seconds. */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}
