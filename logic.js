// Rope & Rung — pure logic core. No DOM, no network. Imported by app.js and tests.

// ---- dates (all date-only strings "YYYY-MM-DD", local time) ----

export function toDayStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function parseDay(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return toDayStr(d);
}

export function daysBetween(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / 86400000);
}

// Monday of the week containing day s (rest-day windows are Mon–Sun)
export function weekStart(s) {
  const d = parseDay(s);
  const shift = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(s, -shift);
}

// ---- settings ----

export const DEFAULT_SETTINGS = {
  target_start: 70,
  target_step: 10,
  step_every: "week",
  target_cap: 200,
  rest_days_per_week: 1,
  challenge_start: "2026-07-20", // Monday of launch week; editable in-app
};

// target(date) = min(start + step * whole weeks since challenge_start, cap)
export function targetFor(day, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const days = daysBetween(s.challenge_start, day);
  if (days < 0) return s.target_start;
  const weeks = Math.floor(days / 7);
  return Math.min(s.target_start + s.target_step * weeks, s.target_cap);
}

// ---- tallies ----

export function dayTally(sets, profileId, day) {
  return sets
    .filter((x) => x.profile_id === profileId && x.day === day)
    .reduce((sum, x) => sum + x.reps, 0);
}

export function allTimeTotal(sets, profileId) {
  return sets.filter((x) => x.profile_id === profileId).reduce((s, x) => s + x.reps, 0);
}

export function isLate(set) {
  // "logged late" tag: the set was recorded on a different calendar date than its day
  return set.logged_at ? set.logged_at.slice(0, 10) !== set.day : false;
}

// ---- rest days ----

export function restsUsedInWeek(statuses, profileId, day) {
  const start = weekStart(day);
  const end = addDays(start, 6);
  return statuses.filter(
    (st) => st.profile_id === profileId && st.kind === "rest" && st.day >= start && st.day <= end
  ).length;
}

export function canDeclareRest(statuses, profileId, day, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const already = statuses.some((st) => st.profile_id === profileId && st.kind === "rest" && st.day === day);
  if (already) return { ok: false, reason: "already-rest" };
  if (restsUsedInWeek(statuses, profileId, day) >= s.rest_days_per_week)
    return { ok: false, reason: "cap-reached" };
  return { ok: true, remaining: s.rest_days_per_week - restsUsedInWeek(statuses, profileId, day) };
}

// ---- day state ----
// met | rest | excused | missed | pending

export function dayState({ sets, statuses, profileId, day, today, settings = DEFAULT_SETTINGS }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const tally = dayTally(sets, profileId, day);
  const target = targetFor(day, settings);
  const rest = statuses.find((x) => x.profile_id === profileId && x.day === day && x.kind === "rest");
  const excuse = statuses.find((x) => x.profile_id === profileId && x.day === day && x.kind === "excuse");
  if (tally >= target) return { state: "met", tally, target, excuse: excuse?.excuse_text ?? null };
  // warm-up days before the challenge starts are never judged
  if (day < s.challenge_start) return { state: "pending", tally, target, excuse: excuse?.excuse_text ?? null };
  if (rest && restWithinCap(statuses, profileId, day, settings, rest))
    return { state: "rest", tally, target, excuse: null };
  if (excuse) return { state: "excused", tally, target, excuse: excuse.excuse_text ?? "" };
  if (day >= today) return { state: "pending", tally, target, excuse: null };
  return { state: "missed", tally, target, excuse: null };
}

// A declared rest only counts if it is within the first N rests of its Mon–Sun week
function restWithinCap(statuses, profileId, day, settings, restRow) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const start = weekStart(day);
  const end = addDays(start, 6);
  const weekRests = statuses
    .filter((st) => st.profile_id === profileId && st.kind === "rest" && st.day >= start && st.day <= end)
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  return weekRests.indexOf(restRow) < s.rest_days_per_week;
}

// ---- streak ----
// Consecutive days ending yesterday (or today if already met/rest) where state is met or rest.

export function streak({ sets, statuses, profileId, today, settings = DEFAULT_SETTINGS, challengeStart }) {
  const start = challengeStart ?? { ...DEFAULT_SETTINGS, ...settings }.challenge_start;
  let count = 0;
  let day = today;
  const todayState = dayState({ sets, statuses, profileId, day, today, settings }).state;
  if (todayState === "met" || todayState === "rest") count++;
  day = addDays(day, -1);
  while (day >= start) {
    const st = dayState({ sets, statuses, profileId, day, today, settings }).state;
    if (st === "met" || st === "rest") count++;
    else break;
    day = addDays(day, -1);
  }
  return count;
}
