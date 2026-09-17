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
  // "logged late" tag: the set was recorded on a different calendar date than
  // its day — in the USER'S timezone. logged_at is a UTC ISO string, so it
  // must be converted to a local day before comparing; slicing the raw string
  // flagged every pre-morning log as late east of Greenwich (owner-reported:
  // an 8:50am AEST log has yesterday's UTC date).
  return set.logged_at ? toDayStr(new Date(set.logged_at)) !== set.day : false;
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

// Total-order comparator for strings and numbers alike. Never subtracts, so
// infinities and equal values yield a clean 0 instead of NaN.
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The moment a day's target was first reached: walk that day's sets
// oldest-first and accumulate. Negative sets (wind-back is a real feature) are
// added exactly as they come rather than clamped or skipped, so a wind-back
// genuinely un-does reps and can push the crossing later. The running total
// ends at dayTally, so a day that met its target always has a crossing.
// Ties on logged_at fall through to set id then reps — content only, never
// input order, so two devices sorting the same log agree.
function crossingTime(sets, profileId, day, target) {
  const rows = sets
    .filter((x) => x.profile_id === profileId && x.day === day)
    .map((x) => ({ t: stamp(x.logged_at), id: String(x.id ?? ""), reps: Number(x.reps) || 0 }))
    .sort((a, b) => cmp(a.t, b.t) || cmp(a.id, b.id) || cmp(a.reps, b.reps));
  let running = 0;
  for (const r of rows) {
    running += r.reps;
    if (running >= target) return r.t;
  }
  return null;
}

// A missing or unparseable logged_at reads as the epoch rather than NaN —
// an undated set is treated as the earliest thing that day, never as a
// poisoned comparison.
function stamp(loggedAt) {
  const t = Date.parse(loggedAt ?? "");
  return Number.isNaN(t) ? 0 : t;
}

// ---- celebrations ----
// Decision only, no DOM/side effects — app.js turns the result into a queue
// of things to show. Kept pure so the "both at once" collapse (see below) is
// a decision the tests can pin, not an accident of firing order.

export function decideCelebrations({ beforeTally, repsAdded, target, streakDays }) {
  // Missing/non-numeric inputs read as 0 rather than throwing or NaN-poisoning
  // the comparisons below.
  const before = Number(beforeTally) || 0;
  const added = Number(repsAdded) || 0;
  const days = Number(streakDays) || 0;
  // A target that isn't a positive finite number means signed-out or
  // pre-challenge state — never celebrate against a target that doesn't
  // really exist.
  if (!(Number.isFinite(target) && target > 0)) return [];
  const crossed = before < target && before + added >= target;
  // 0 % 7 === 0, so without the `days > 0` guard a member with NO streak at
  // all (streakDays 0) would fire a milestone celebration on day zero.
  const milestone = days > 0 && days % 7 === 0;
  // Both landing on the same commit collapses to ONE entry, not two: the
  // streak supersedes, and the affirmation bag must not be drawn from on a
  // day its line is never shown — see nextFromBag's admin-add note below for
  // why a burned line matters.
  if (crossed && milestone) return [{ kind: "streak", cut: "full", days, alsoTarget: true }];
  if (milestone) return [{ kind: "streak", cut: "full", days }];
  if (crossed) return [{ kind: "target", cut: "short" }];
  return [];
}

// ---- affirmation bag ----
// Shuffled-bag picker: every line in the bank is drawn once before any line
// repeats. Replaces a weaker "random, but not equal to last" picker that
// repeated noticeably when fired daily across 30 lines.
//
// Lines the admin ADDS only enter the bag at the next refill — the app
// resets the stored bag explicitly whenever the bank is saved, so this
// function does not need to detect additions itself.
export function nextFromBag(bank, bagState, rng = Math.random) {
  if (!Array.isArray(bank) || bank.length === 0) {
    return { line: null, state: { remaining: [], last: bagState?.last ?? null } };
  }
  const prevLast = bagState && typeof bagState === "object" ? (bagState.last ?? null) : null;
  // A line the admin has since deleted must never be drawn, even if it's
  // still sitting in a bag that was filled before the edit.
  let remaining = (Array.isArray(bagState?.remaining) ? bagState.remaining : []).filter((line) =>
    bank.includes(line)
  );

  if (remaining.length === 0) {
    remaining = shuffleBag(bank, rng);
    // A fresh bag boundary can otherwise deal the same line twice in a row
    // (last line of the old bag == first line of the new one) — swap it away
    // so a shuffle boundary is never visible as a repeat.
    if (remaining[0] === prevLast && remaining.length > 1) {
      const swapIdx = 1 + Math.floor(rng() * (remaining.length - 1));
      [remaining[0], remaining[swapIdx]] = [remaining[swapIdx], remaining[0]];
    }
  }

  remaining = remaining.slice();
  const line = remaining.shift();
  return { line, state: { remaining, last: line } };
}

// Fisher–Yates, driven by the injected rng so tests can pin the sequence.
function shuffleBag(bank, rng) {
  const a = bank.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- streak lines ----
// Five fixed, admin-editable milestone slots. The structure is fixed
// (STREAK_SLOTS, for the admin editor to iterate); only the wording is
// editable per crew.

export const STREAK_SLOTS = ["d7", "d14", "d21", "d28", "beyond"];

export const STREAK_DEFAULTS = {
  d7: "Seven days. Knot tied.",
  d14: "Two weeks straight. The rope holds.",
  d21: "Three weeks. That's a habit now.",
  d28: "Four weeks straight. Cast in stone.",
  beyond: "{n} days straight. Still climbing.",
};

// Which of the five slots a given day-count fires; every milestone past 28
// shares "beyond" rather than growing the slot list forever.
export function streakSlotFor(days) {
  if (days === 7) return "d7";
  if (days === 14) return "d14";
  if (days === 21) return "d21";
  if (days === 28) return "d28";
  return "beyond";
}

export function streakLine(days, lines) {
  const slot = streakSlotFor(days);
  const override = lines && typeof lines === "object" ? lines[slot] : undefined;
  // A blank/whitespace-only override must fall back rather than render an
  // empty celebration headline.
  const text = typeof override === "string" && override.trim() !== "" ? override : STREAK_DEFAULTS[slot];
  return text.replaceAll("{n}", String(days));
}

// ============================================================================
// ACHIEVEMENTS
// ============================================================================
// Spec: design/achievements-backlog.md (owner-reviewed 2026-08-14).
//
// NOTHING HERE IS STORED. Every unlock is DERIVED from the shared log, exactly
// like the wooden spoon above, and for the same reason: each device evaluates
// independently, so any answer that depended on local state, the local clock or
// the order the caller handed the arrays over would let two phones disagree.
// An unlock is therefore a pair {key, at} where `at` is the MOMENT IN THE LOG
// that earned it — a set's logged_at, a day boundary, or a week's close. That
// one derived number is what makes the whole wear mechanic fall out for free:
//
//   24-hour wear   now - at < 24h
//   supersession   the most recent still-open `at` wins (spec rule 5)
//   wardrobe       any `at` that has ever existed (spec rule 6)
//
// so none of those need storage either.

const DAY_MS = 86400000;
export const GOAT_WEEKS = 4;      // §6 open question 1 — an interpretation, see report
export const SUMMIT_WEEKS = 2;
export const KEPT_CLIMBING_DAYS = 28;
export const SPOONLESS_WEEKS = 4;
export const STORYTELLER_EXCUSES = 5;

// wear: "weekly" (the ranking pair) · "day" (24h) · "until-clean-week" (The
// Storyteller). `comparative` marks the rows that cannot exist in a crew of one
// (spec rule 8 — absent, not greyed out).
//
// `rank` only ever settles a tie. Several rules can fire on the SAME instant —
// one 1,200-rep set crosses 500, crosses 1,000 and beats the target by fifty,
// all on one timestamp — and which of them goes on the avatar should be the
// rarest of them, not whichever rule the evaluator happens to run last.
export const ACHIEVEMENTS = [
  { key: "eagleSoaring",   rank:  95, name: "Eagle Soaring",       tier: 1, wear: "weekly", comparative: true,
    blurb: "First all week — top of the ranking." },
  { key: "lastRung",       rank:   5, name: "Last Rung",           tier: 1, wear: "weekly", comparative: true,
    blurb: "Bottom of the ranking. Someone gets it every week." },
  { key: "firstRung",      rank:  10, name: "First Rung",          tier: 2, wear: "day", once: true,
    blurb: "Your first full day." },
  { key: "fullLedger",     rank:  50, name: "Full Ledger",         tier: 2, wear: "day", once: true,
    blurb: "500 banked." },
  { key: "earlyBird",      rank:  32, name: "Early Bird",          tier: 2, wear: "day",
    blurb: "Target done before 7am." },
  { key: "firstPin",       rank:  15, name: "First Pin",           tier: 2, wear: "day", once: true,
    blurb: "Your first excuse. Once, ever." },
  { key: "steadfastGrip",  rank:  55, name: "Steadfast Grip",      tier: 2, wear: "day",
    blurb: "A whole week met, no rest day taken." },
  { key: "lostWilderness", rank:  40, name: "Lost in the Wilderness", tier: 2, wear: "day",
    blurb: "More than three days in a row gone." },
  { key: "moneyBags",      rank:  25, name: "Money Bags",          tier: 2, wear: "day",
    blurb: "Beat the target by fifty or more." },
  { key: "discoFever",     rank:  31, name: "Disco Fever",         tier: 2, wear: "day",
    blurb: "Finished after 11:30pm. Just." },
  { key: "midnightNinja",  rank:  30, name: "Midnight Ninja",      tier: 2, wear: "day",
    blurb: "First set of the day inside ten minutes of midnight." },
  { key: "whiteKnuckle",   rank:  29, name: "White Knuckle",       tier: 2, wear: "day",
    blurb: "Nothing all day, then started at 10:45pm." },
  { key: "keptClimbing",   rank:  70, name: "Kept Climbing",       tier: 2, wear: "day",
    blurb: "Twenty-eight days, nothing missed." },
  { key: "itchyFingers",   rank:  20, name: "Itchy Fingers",       tier: 2, wear: "day",
    blurb: "Banked on a rest day. Nobody made you." },
  { key: "spoonless",      rank:  65, name: "Spoonless",           tier: 2, wear: "day", comparative: true,
    blurb: "Four weeks, never last." },
  { key: "summit",         rank:  90, name: "Summit",              tier: 2, wear: "day", comparative: true,
    blurb: "You can come down now, the view's not that good. Did you get frozen up there?" },
  { key: "goat",           rank: 100, name: "GOAT",                tier: 2, wear: "day", comparative: true,
    blurb: "Greatest of all time. The rarest in the app." },
  { key: "dynamite",       rank:  35, name: "Dynamite",            tier: 2, wear: "day",
    blurb: "Missed it, owned it, then came back fifty over." },
  { key: "fourFigures",    rank:  60, name: "Four Figures",        tier: 2, wear: "day", once: true,
    blurb: "1,000 banked." },
  { key: "gripStrength",   rank:  75, name: "Grip Strength",       tier: 2, wear: "day", once: true,
    blurb: "2,500 banked." },
  { key: "ironLung",       rank:  80, name: "Iron Lung",           tier: 2, wear: "day", once: true,
    blurb: "5,000 banked." },
  { key: "aboveClouds",    rank:  85, name: "Above the Clouds",   tier: 2, wear: "day", once: true,
    blurb: "10,000 banked." },  // owner cut "Legend of the Rung" 2026-08-31 and
  // settled the name 2026-09-18: "Blue Water" was a SAILING term (and drew a
  // boat on waves) in an app whose whole language is rope, rungs and a summit.
  // Above the Clouds is climbing's own, and it tops the banked ladder: Four
  // Figures 1,000 -> Grip Strength 2,500 -> Iron Lung 5,000 -> above the lot.
  { key: "storyteller",    rank:  45, name: "The Storyteller",     tier: 3, wear: "until-clean-week",
    blurb: "Tells all the stories but no action." },
  { key: "basecampTavern", rank:  38, name: "Basecamp Tavern",     tier: 3, wear: "day",
    blurb: "Two excuses in a week. Traded the climb for the tavern." },
];

export const ACHIEVEMENT_BY_KEY = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.key, a]));

// ---- time-of-day ----
// Minutes since LOCAL midnight for a UTC ISO stamp. Every time-of-day rule
// (Early Bird, Disco Fever, Midnight Ninja, White Knuckle) has to convert
// before comparing — isLate() above carries the scar tissue from the last time
// this was done by slicing the raw string, which flagged every pre-morning log
// as late east of Greenwich.
function localMinutes(loggedAt) {
  const t = Date.parse(loggedAt ?? "");
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

// Local midnight that STARTS the given day — the moment a day-boundary
// achievement becomes true. Derived from the date string, so it is the same
// number on every device in the crew's timezone and never reads the clock.
function dayStartMs(day) {
  return parseDay(day).getTime();
}

// A member's sets for one day, in the one canonical order. Same content-only
// tie-break chain as crossingTime() so two devices sorting the same log agree.
function daySets(sets, day) {
  return sets
    .filter((x) => x.day === day)
    .map((x) => ({ t: stamp(x.logged_at), id: String(x.id ?? ""), reps: Number(x.reps) || 0, raw: x }))
    .sort((a, b) => cmp(a.t, b.t) || cmp(a.id, b.id) || cmp(a.reps, b.reps));
}

// The FIRST set that took the day's running total to `threshold`.
//
// Deliberately different from crossingTime() above, which the spoon uses: there
// a wind-back is allowed to push the finish later, because the spoon is a
// ranking and a ranking should reflect the corrected truth. Here spec rule 9
// applies instead — "wind-backs are silent, your finish time is the FIRST
// crossing, a correction re-fires nothing" — so once this returns a row, a
// later negative set cannot take the badge back.
function firstCrossing(sets, day, threshold) {
  if (!(Number.isFinite(threshold) && threshold > 0)) return null;
  let running = 0;
  for (const r of daySets(sets, day)) {
    running += r.reps;
    if (running >= threshold) return r;
  }
  return null;
}

// ---- the weekly ranking ----
// The eagle and the spoon are the two ends of ONE ordering, so they are built
// from one set of rows. weekRows() is the extraction of what weeklySpoon() has
// always computed; the two selectors below keep their own explicit tie-breaks
// rather than sharing a reversed array, because the sensible tie-break at the
// top (lowest id) is not the mirror of the sensible one at the bottom.
function weekRows({ sets, statuses, profiles, weekStartDay, settings }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const crew = Array.isArray(profiles) ? profiles : [];
  if (crew.length < 2) return null; // no ranking in a crew of one — spec rule 8
  const log = Array.isArray(sets) ? sets : [];
  const marks = Array.isArray(statuses) ? statuses : [];

  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStartDay, i);
    if (day >= s.challenge_start) days.push(day);
  }
  if (days.length === 0) return null;
  const after = addDays(weekStartDay, 7);

  const rows = crew.map((p) => {
    const id = String(p.id);
    let shortfall = 0;
    let totalBanked = 0;
    let finish = -Infinity;
    for (const day of days) {
      const st = dayState({ sets: log, statuses: marks, profileId: id, day, today: after, settings: s }).state;
      const required = st === "rest" ? 0 : targetFor(day, s);
      const banked = dayTally(log, id, day);
      totalBanked += banked;
      if (required <= 0) continue;
      if (banked < required) shortfall += required - banked;
      else {
        const at = crossingTime(log, id, day, required);
        if (at !== null && at > finish) finish = at;
      }
    }
    return { id, shortfall, totalBanked, finish };
  });

  return { rows, anyShort: rows.some((r) => r.shortfall > 0) };
}

export function weeklySpoon({ sets, statuses, profiles, weekStartDay, settings = DEFAULT_SETTINGS }) {
  const table = weekRows({ sets, statuses, profiles, weekStartDay, settings });
  if (!table) return null;
  const { rows, anyShort } = table;
  // Anyone short of the week loses to everyone who wasn't; only if the whole
  // crew hit it does the tie-break fall through to who finished last.
  const pool = anyShort ? rows.filter((r) => r.shortfall > 0) : rows;
  // slice() so the caller's array is never reordered under them, and cmp()
  // rather than `a - b` so -Infinity vs -Infinity can't become NaN and
  // destabilise the sort.
  const worst = pool.slice().sort((a, b) =>
    anyShort
      ? cmp(b.shortfall, a.shortfall) || cmp(a.totalBanked, b.totalBanked) || cmp(a.id, b.id)
      : cmp(b.finish, a.finish) || cmp(a.id, b.id)
  )[0];
  return worst ? worst.id : null;
}

// Eagle Soaring — the top of the same ranking: "first all week".
//
// finish is -Infinity for a member the week never actually asked anything of
// (every judged day a counting rest). That sorts as the earliest possible
// finish, which is what the spoon wants — least deserving of last place — but
// it must NOT hand them the eagle, so a genuine finish is required to be in the
// finishers' pool at all.
export function weeklyEagle({ sets, statuses, profiles, weekStartDay, settings = DEFAULT_SETTINGS }) {
  const table = weekRows({ sets, statuses, profiles, weekStartDay, settings });
  if (!table) return null;
  const { rows } = table;
  const finished = rows.filter((r) => r.shortfall === 0 && Number.isFinite(r.finish));
  const pool = finished.length ? finished : rows;
  const best = pool.slice().sort((a, b) =>
    finished.length
      ? cmp(a.finish, b.finish) || cmp(b.totalBanked, a.totalBanked) || cmp(a.id, b.id)
      // Nobody finished the week: the least-short member tops it. The eagle
      // "always fires" (spec §2), so the ranking still has to have a head.
      : cmp(a.shortfall, b.shortfall) || cmp(b.totalBanked, a.totalBanked) || cmp(a.id, b.id)
  )[0];
  return best ? best.id : null;
}

// ---- the evaluator ----
// Walks one member's whole history and returns EVERY unlock that has ever
// fired, ascending. Repeatable achievements appear once per occurrence; the
// wardrobe only cares that a key appears at all, and the 24-hour wear only
// cares about the last one, so returning the full list serves both without
// either needing to store anything.
//
// Each entry is { key, at } and, for The Storyteller only, `until` — the
// moment a clean week cleared it, or null while it is still being worn.
export function achievementUnlocks({ sets, statuses, profiles, profileId, today, settings = DEFAULT_SETTINGS }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const id = String(profileId ?? "");
  if (!id || !today || today < s.challenge_start) return [];

  const log = Array.isArray(sets) ? sets : [];
  const marks = Array.isArray(statuses) ? statuses : [];
  const crew = Array.isArray(profiles) ? profiles : [];
  // Filter once. dayState re-filters by profile_id anyway, so this is purely to
  // keep the day walk below from rescanning the whole crew's log 365 times.
  const mySets = log.filter((x) => String(x.profile_id) === id);
  const myMarks = marks.filter((x) => String(x.profile_id) === id);

  const out = [];
  // `seq` is the push counter. Two things can unlock on the SAME instant — one
  // huge set crosses 500 and 1,000 together — and `at` alone cannot separate
  // them, so ties fall through to the order the rules below run in. That order
  // is fixed in the source, which makes it as reproducible across devices as
  // the timestamps are, and the volume tiers are pushed smallest-first so the
  // LAST one at a given instant is the biggest thing you just earned.
  let seq = 0;
  const push = (key, at, extra) => {
    if (Number.isFinite(at)) out.push(extra ? { key, at, seq: seq++, ...extra } : { key, at, seq: seq++ });
  };

  // --- the day walk ---
  // A member's history starts the day they first appear in the log, not the day
  // the challenge opened. Without this, someone who joins in week six has five
  // weeks of "missed" days behind them and is handed Lost in the Wilderness for
  // days that happened before they existed — and so is a member who has never
  // logged anything at all.
  let firstActivity = null;
  for (const x of mySets) if (firstActivity === null || x.day < firstActivity) firstActivity = x.day;
  for (const x of myMarks) if (firstActivity === null || x.day < firstActivity) firstActivity = x.day;
  const walkStart = firstActivity && firstActivity > s.challenge_start ? firstActivity : s.challenge_start;

  const days = [];
  if (firstActivity !== null) {
    for (let d = walkStart; d <= today; d = addDays(d, 1)) {
      days.push(d);
      if (days.length > 4000) break; // a corrupt challenge_start must not hang the app
    }
  }
  const info = days.map((day) => {
    const st = dayState({ sets: mySets, statuses: myMarks, profileId: id, day, today, settings: s });
    return { day, state: st.state, tally: st.tally, target: st.target };
  });

  // --- 1. First Rung — the first full DAY, not the first set ---
  const firstMet = info.find((x) => x.state === "met");
  if (firstMet) {
    const row = firstCrossing(mySets, firstMet.day, firstMet.target);
    push("firstRung", row ? row.t : dayStartMs(firstMet.day));
  }

  // --- 2, 17-20. The volume tiers ---
  // POSITIVE ENTRIES ONLY (hazard 1): reps is signed because winding back is a
  // real feature, so the all-time total is not monotonic. Banking 500, firing
  // the badge and then winding 450 back does not un-fire it — and must not let
  // the same 500 be re-banked to fire it twice either, which is why this
  // accumulates positives rather than reading allTimeTotal().
  const chronological = mySets
    .map((x) => ({ t: stamp(x.logged_at), id: String(x.id ?? ""), reps: Number(x.reps) || 0, raw: x }))
    .sort((a, b) => cmp(a.t, b.t) || cmp(a.id, b.id) || cmp(a.reps, b.reps));
  const TIERS = [["fullLedger", 500], ["fourFigures", 1000], ["gripStrength", 2500],
                 ["ironLung", 5000], ["aboveClouds", 10000]];
  let banked = 0;
  let tier = 0;
  for (const r of chronological) {
    if (r.reps <= 0) continue;
    banked += r.reps;
    while (tier < TIERS.length && banked >= TIERS[tier][1]) push(TIERS[tier++][0], r.t);
  }

  // --- 3, 7, 8, 9, 10. The clock rules ---
  // All four convert logged_at to LOCAL time before comparing (hazard 5), and
  // all four refuse a set that was logged on a different calendar day than the
  // one it counts toward. Without that guard an admin backfilling yesterday at
  // 3pm would collect Early Bird, Disco Fever and Midnight Ninja in one click.
  for (const d of info) {
    const opener = daySets(mySets, d.day)[0];
    // The moment the day's target was first reached, if it ever was.
    const cross = d.state === "met" ? firstCrossing(mySets, d.day, d.target) : null;

    if (opener && !isLate(opener.raw)) {
      const mins = localMinutes(opener.raw.logged_at);
      if (mins !== null) {
        // Midnight Ninja — the day's FIRST set lands in the ten minutes after
        // midnight. It counts toward the NEW date, and yesterday keeps only
        // whatever was on the ledger before midnight (owner-confirmed); no
        // condition on yesterday at all.
        if (mins >= 1 && mins <= 10) push("midnightNinja", opener.t);
        // White Knuckle (owner-confirmed 2026-08-31) — nothing logged all day,
        // the ledger opens after 10:45pm, and the whole target is finished
        // before the day ends. Both halves are load-bearing: without the finish
        // it rewards logging five reps at 10:45 and stopping, and requiring
        // only that the day ends "met" is not the same thing, because a set
        // backdated the next morning would quietly finish the day for you.
        // Insisting the CROSSING is on the same calendar day is what closes
        // that, and it also bounds the finish below midnight for free.
        if (mins >= 22 * 60 + 45 && cross && !isLate(cross.raw)) push("whiteKnuckle", opener.t);
      }
    }

    if (d.state !== "met") continue;

    if (cross && !isLate(cross.raw)) {
      const mins = localMinutes(cross.raw.logged_at);
      if (mins !== null) {
        // Early Bird — finished before 7am, and only once the target has real
        // weight behind it. Merges the old First Light; one achievement, not two.
        if (mins < 7 * 60 && d.target > 130) push("earlyBird", cross.t);
        // Disco Fever — finished after 11:30pm but before midnight. Distinct
        // from White Knuckle: this is about when you FINISH, that one when you
        // START. A set past midnight belongs to the next day, so the upper
        // bound is structural rather than a comparison.
        if (mins >= 23 * 60 + 30) push("discoFever", cross.t);
      }
    }

    // Money Bags — beat the day's target by fifty or more.
    const over = firstCrossing(mySets, d.day, d.target + 50);
    if (over) push("moneyBags", over.t);
  }

  // --- 4, 12. Excuses and rest days ---
  const myExcuses = myMarks
    .filter((x) => x.kind === "excuse")
    .map((x) => ({ day: x.day, t: Number.isNaN(Date.parse(x.created_at ?? "")) ? dayStartMs(x.day) : Date.parse(x.created_at) }))
    .sort((a, b) => cmp(a.t, b.t) || cmp(a.day, b.day));

  if (myExcuses.length) push("firstPin", myExcuses[0].t);

  // Basecamp Tavern — two excuses inside one Mon-Sun week. Fires on the second,
  // once per week, not again on a third.
  const excusesByWeek = new Map();
  for (const ex of myExcuses) {
    const wk = weekStart(ex.day);
    const list = excusesByWeek.get(wk) ?? [];
    list.push(ex);
    excusesByWeek.set(wk, list);
  }
  for (const list of excusesByWeek.values()) if (list.length >= 2) push("basecampTavern", list[1].t);

  // Itchy Fingers — banked on a rest day you had already claimed. Keyed off the
  // rest STATUS rather than the day's state, because banking enough to meet the
  // target turns the day "met" and would otherwise hide the very thing being
  // rewarded.
  const restDays = new Set(myMarks.filter((x) => x.kind === "rest").map((x) => x.day));
  for (const day of restDays) {
    const first = daySets(mySets, day).find((r) => r.reps > 0);
    if (first) push("itchyFingers", first.t);
  }

  // --- 16. Dynamite — missed it, owned it, came back fifty over ---
  for (let i = 0; i < info.length - 1; i++) {
    if (info[i].state !== "excused") continue;
    const next = info[i + 1];
    const over = firstCrossing(mySets, next.day, next.target + 50);
    if (over) push("dynamite", over.t);
  }

  // --- 6. Lost in the Wilderness — more than three days in a row gone ---
  // Fires the moment the fourth missed day closes, once per run: a five-day
  // hole is one wilderness, not two.
  let run = 0;
  for (const d of info) {
    if (d.state === "missed") {
      run++;
      if (run === 4) push("lostWilderness", dayStartMs(addDays(d.day, 1)));
    } else run = 0;
  }

  // --- 11. Kept Climbing — 28 days, nothing missed, at most one excuse ---
  // 28 days rather than a calendar month so it can never straddle a month
  // boundary; the whole app runs on Mon-Sun weeks. Fires when a window first
  // becomes valid, so a long clean stretch fires once, not every day for a month.
  const windowValid = (endIdx) => {
    const startIdx = endIdx - KEPT_CLIMBING_DAYS + 1;
    if (startIdx < 0) return false;
    let excuses = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      const st = info[i].state;
      if (st === "missed" || st === "pending") return false;
      if (st === "excused" && ++excuses > 1) return false;
    }
    return true;
  };
  for (let i = 0; i < info.length; i++) {
    if (windowValid(i) && !windowValid(i - 1)) push("keptClimbing", dayStartMs(addDays(info[i].day, 1)));
  }

  // --- 5. Steadfast Grip — a whole week met, no rest day taken ---
  // The owner tightened this on 2026-08-14: a rest day no longer counts. The
  // week has to be a full seven judged days, so the part-week the challenge
  // starts mid-way through cannot win it.
  const byDay = new Map(info.map((x) => [x.day, x]));
  const closedWeeks = [];
  for (let w = weekStart(s.challenge_start); addDays(w, 7) <= today; w = addDays(w, 7)) {
    const wdays = [];
    for (let i = 0; i < 7; i++) wdays.push(addDays(w, i));
    const judged = wdays.filter((day) => day >= s.challenge_start);
    closedWeeks.push({ start: w, closeMs: dayStartMs(addDays(w, 7)), wdays, judged });
  }
  for (const wk of closedWeeks) {
    if (wk.judged.length !== 7) continue;
    if (wk.wdays.some((day) => restDays.has(day))) continue;
    if (!wk.wdays.every((day) => byDay.get(day)?.state === "met")) continue;
    // The moment the week was completed: the latest of its seven crossings.
    let at = -Infinity;
    for (const day of wk.wdays) {
      const row = firstCrossing(mySets, day, byDay.get(day).target);
      const t = row ? row.t : dayStartMs(day);
      if (t > at) at = t;
    }
    push("steadfastGrip", Number.isFinite(at) ? at : wk.closeMs);
  }

  // --- The Storyteller — five excuses, worn until a clean week clears it ---
  // The only achievement with no fixed duration. Modelled as a two-state
  // machine over one merged timeline so it re-arms honestly: after a clean week
  // clears it, the very next excuse puts it straight back on.
  //
  // INTERPRETATION: "complete a full week's target" is read as a closed Mon-Sun
  // week with nothing missed and nothing excused. An entitled rest day still
  // counts as completing the week, because a rest reduces what you owed.
  const cleanCloses = closedWeeks
    .filter((wk) => wk.judged.length === 7 &&
      wk.wdays.every((day) => { const st = byDay.get(day)?.state; return st === "met" || st === "rest"; }))
    .map((wk) => wk.closeMs);
  const timeline = [
    ...myExcuses.map((e) => ({ t: e.t, kind: "excuse" })),
    ...cleanCloses.map((t) => ({ t, kind: "clean" })),
  ].sort((a, b) => cmp(a.t, b.t) || cmp(a.kind, b.kind)); // "clean" < "excuse": a week that
  // closes at the same instant an excuse is written clears the OLD run first.
  let seen = 0;
  let wearing = null;
  for (const ev of timeline) {
    if (ev.kind === "excuse") {
      seen++;
      if (wearing === null && seen >= STORYTELLER_EXCUSES) {
        wearing = { key: "storyteller", at: ev.t, seq: seq++, until: null };
        out.push(wearing);
      }
    } else if (wearing) {
      wearing.until = ev.t;
      wearing = null;
    }
  }

  // --- 13, 14, 15 + Eagle Soaring. The ranking-derived rows ---
  // Comparative by construction (spec rule 8): weeklySpoon/weeklyEagle both
  // return null in a crew of one, so in a solo crew none of these can fire at
  // all — they are absent rather than greyed out.
  const ranked = closedWeeks.map((wk) => {
    const arg = { sets: log, statuses: marks, profiles: crew, weekStartDay: wk.start, settings: s };
    // "Perfect" (owner, 2026-08-31): an entitled REST day is allowed, an excuse
    // is not. A rest reduces what the week owed you, so taking one you were
    // owed is not a blemish — writing an excuse is. Note this is deliberately
    // NOT the same bar as Steadfast Grip, which the owner tightened on
    // 2026-08-14 to refuse rest days outright; that one is "a whole week with
    // no free passes at all", this one is "nothing went wrong".
    const perfect = wk.judged.length === 7 && wk.wdays.every((day) => {
      const st = byDay.get(day)?.state;
      return st === "met" || st === "rest";
    });
    return { ...wk, spoon: weeklySpoon(arg), eagle: weeklyEagle(arg), perfect };
  });

  for (const wk of ranked) if (wk.eagle === id) push("eagleSoaring", wk.closeMs);
  for (const wk of ranked) if (wk.spoon === id) push("lastRung", wk.closeMs);

  // Summit and GOAT escalate on ONE axis — how long you stay first AND perfect.
  // 1 week (eagle, always fires) -> 2 -> 4. Each fires on the week its run
  // reaches the mark, so a five-week run is one GOAT, not two.
  let streakWeeks = 0;
  for (const wk of ranked) {
    streakWeeks = wk.eagle === id && wk.perfect ? streakWeeks + 1 : 0;
    if (streakWeeks === SUMMIT_WEEKS) push("summit", wk.closeMs);
    if (streakWeeks === GOAT_WEEKS) push("goat", wk.closeMs);
  }

  // Spoonless — four closed weeks and the spoon never landed on you. A week
  // that could not be ranked at all (solo crew) breaks the run rather than
  // counting as a week you survived.
  let clear = 0;
  for (const wk of ranked) {
    clear = wk.spoon !== null && wk.spoon !== id ? clear + 1 : 0;
    if (clear === SPOONLESS_WEEKS) { push("spoonless", wk.closeMs); clear = 0; }
  }

  return out.sort((a, b) => cmp(a.at, b.at) || cmp(a.seq, b.seq));
}

// ---- wear, supersession, wardrobe ----

// Every key ever unlocked, in the order it was FIRST earned. This is the
// permanent picker (spec rule 6) — once it is yours it is yours, and the weekly
// pair belong in it too: you keep the eagle in your wardrobe even in the weeks
// you are not wearing it by right.
export function wardrobe(unlocks) {
  const seen = new Set();
  const list = [];
  for (const u of Array.isArray(unlocks) ? unlocks : []) {
    if (seen.has(u.key)) continue;
    seen.add(u.key);
    list.push(u.key);
  }
  return list;
}

// The unlock currently being worn by right, or null.
//
// Supersession (spec rule 5) is just "latest still-open wins" — a newer unlock
// replaces the current one and restarts its own window, and neither is senior
// to the other. Because `at` is derived rather than stored, this is a pure
// function of the log and the clock and stays correct across a reload, a device
// swap, or an app that was closed the whole time the window was open.
//
// The weekly pair are excluded here: they are not 24-hour unlocks, they are a
// standing rank, and decideAvatar() puts them above this.
export function currentAward({ unlocks, now = Date.now() }) {
  let best = null;
  for (const u of Array.isArray(unlocks) ? unlocks : []) {
    const meta = ACHIEVEMENT_BY_KEY[u.key];
    if (!meta || meta.wear === "weekly") continue;
    // An unlock that has not happened yet is never worn. Day-boundary rules
    // (the wilderness, the week-close pair) are dated at a future midnight, and
    // the in-app date override can put `today` days ahead of the real clock —
    // without this guard `now - at` goes negative, which is also < 24h, and the
    // avatar would change before the thing was earned.
    if (u.at > now) continue;
    const open = meta.wear === "until-clean-week"
      ? u.until == null || now < u.until
      : now - u.at < DAY_MS;
    if (!open) continue;
    // Strictly later wins; on an exact tie the later-emitted one does, which is
    // how crossing 500 and 1,000 in a single set puts Four Figures on your
    // avatar rather than Full Ledger.
    if (!best || beats(u, meta, best)) best = u;
  }
  return best ? { key: best.key, at: best.at, until: best.until ?? null } : null;
}

// Later wins. On an exact tie the rarer one wins, and only if that ties too
// does it fall through to the order the rules were evaluated in.
function beats(u, meta, best) {
  return (
    cmp(u.at, best.at) ||
    cmp(meta.rank ?? 0, ACHIEVEMENT_BY_KEY[best.key]?.rank ?? 0) ||
    cmp(u.seq ?? 0, best.seq ?? 0)
  ) > 0;
}

// Spec rule 7 — weekly rank, then the 24-hour unlock, then whatever you chose.
// "You cannot unlock your way out of the spoon, nor out of the eagle."
export function decideAvatar({ unlocks, now = Date.now(), isSpoonHolder = false, isEagleHolder = false, chosen = null }) {
  if (isSpoonHolder) return { source: "spoon", key: "lastRung", chosen };
  if (isEagleHolder) return { source: "eagle", key: "eagleSoaring", chosen };
  const award = currentAward({ unlocks, now });
  if (award) return { source: "unlock", key: award.key, chosen };
  return { source: "chosen", key: null, chosen };
}

// What the notification panel has not shown yet (spec rule 3: nothing is
// labelled publicly, but the earner gets a private view of what they got and
// why). `since` is the app's own high-water mark — the only piece of this
// system that is stored anywhere, and it is per-device on purpose: it records
// what this phone has SHOWN you, not what you have earned.
export function unseenUnlocks(unlocks, since = 0, now = Date.now()) {
  const mark = Number(since) || 0;
  return (Array.isArray(unlocks) ? unlocks : [])
    .filter((u) => u.at > mark && u.at <= now && ACHIEVEMENT_BY_KEY[u.key])
    .sort((a, b) => cmp(a.at, b.at) || cmp(a.key, b.key));
}
