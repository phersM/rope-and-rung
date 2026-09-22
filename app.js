// Rope & Rung — app shell. Pure rules live in logic.js; storage in data.js.

import {
  toDayStr, addDays, parseDay, daysBetween, targetFor, dayTally, allTimeTotal, isLate,
  canDeclareRest, restsUsedInWeek, dayState, streak, weekStart, weeklySpoon, DEFAULT_SETTINGS,
  weeklyEagle, achievementUnlocks, currentAward, decideAvatar, wardrobe, unseenUnlocks,
  ACHIEVEMENTS, ACHIEVEMENT_BY_KEY, decideCelebrations,
} from "./logic.js";
import { makeAdapter, CODE_LENGTH, looksLikeCode } from "./data.js";

const $ = (id) => document.getElementById(id);
const REPS_PER_REV = 20;            // one full revolution of the dial = 20 pushups
const DEG_PER_REP = 360 / REPS_PER_REV;
const MAX_SET = 500;

const state = {
  adapter: null, crew: null, me: null,
  profiles: [], sets: [], statuses: [],
  settings: { ...DEFAULT_SETTINGS },
  compose: 0, rotation: 0,
  histMonth: null, histPerson: null, histSelected: null,
  excuseDay: null, screen: "crew",
};
// loadCrew() can re-run (onboarding -> new crew, or a future re-join flow);
// without tearing down the previous subscription first, each re-entry would
// leave its poller/channel running and stack a second one on top, doubling
// refetch() calls forever.
let unsubscribeCrew = null;
const SCREEN_ORDER = ["crew", "today", "history", "settings"];

const today = () => {
  const override = localStorage.getItem("pushpact-date-override");
  return override ? override : toDayStr(new Date());
};
const session = {
  load: () => JSON.parse(localStorage.getItem("pushpact-session") || "null"),
  save: (s) => localStorage.setItem("pushpact-session", JSON.stringify(s)),
  clear: () => localStorage.removeItem("pushpact-session"),
};

// keeps the header date + the "simulated date" tag in sync with today();
// called on boot and on every render so the override is never stale.
function updateHeadDate() {
  $("head-date").textContent = parseDay(today()).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  const override = localStorage.getItem("pushpact-date-override");
  $("date-override-tag").classList.toggle("hidden", !override);
  if (override) $("date-override-tag").textContent = `Simulated: ${override}`;
}

// ---------- boot ----------

async function boot() {
  state.adapter = await makeAdapter();
  $("local-banner").classList.toggle("hidden", state.adapter.shared || !!localStorage.getItem("pushpact-solo-dismissed"));
  $("lb-close").addEventListener("click", () => {
    $("local-banner").classList.add("hidden");
    localStorage.setItem("pushpact-solo-dismissed", "1");
  });
  updateHeadDate();

  const sess = session.load();
  // An invite link must beat a stale session. boot() used to restore whatever
  // crew this device last used BEFORE looking at ?code=, so tapping a friend's
  // invite on a phone that had ever joined anything dropped you straight into
  // your OWN profile and silently ignored the code — which is exactly what it
  // looked like: "the link took them to their profile, not the login screen".
  // A code that matches the session you already have is not a conflict, so
  // only a DIFFERENT crew forces the join flow.
  const invite = inviteCode();
  applyMode(invite);
  const inviteIsElsewhere = invite && sess?.crewCode &&
    invite.trim().toUpperCase() !== String(sess.crewCode).toUpperCase();
  if (sess?.crewId && sess?.profileId && !inviteIsElsewhere) {
    try {
      // shared mode authenticates every call with the crew code, and a restored
      // session never went through the join step that captures it
      state.adapter.resume(sess.crewCode, sess.crewId);
      await loadCrew(sess.crewId, sess.profileId);
      showApp();
      return;
    } catch (e) {
      console.warn("session restore failed", e);
      // No signal is not a sign-out. Clearing the session on a network error
      // logged you out every time you opened the app on bad reception, and the
      // join screen then offered to fork you into a new empty crew.
      if (state.adapter.shared && isUnreachable(e)) { showBootOffline(); return; }
      if (state.adapter.shared && await bringSoloHistory(sess)) { showApp(); return; }
      session.clear();
    }
  }
  $("onboarding").classList.remove("hidden");
}

// fetch throws a TypeError when it never reached the server; a 5xx reached it
// but it failed. Either way the crew may be perfectly fine — try again later.
function isUnreachable(e) {
  return e instanceof TypeError || (e?.status ?? 0) >= 500;
}

function showBootOffline() {
  $("boot-offline").classList.remove("hidden");
  $("boot-offline-retry").onclick = () => location.reload();
}

// A phone that banked in solo mode (LocalAdapter) while there was no crew
// database has a session pointing at a crew that only exists in its own
// localStorage. The onboarding promised "your pushups save on this phone, and
// they'll come with you when crews come back" — so they do: the whole solo
// crew is imported as a new shared crew, ids and timestamps intact, and the
// session keeps working with the new code. The local copy is left untouched.
async function bringSoloHistory(sess) {
  let local;
  try { local = JSON.parse(localStorage.getItem("pushpact-local") || "null"); } catch { return false; }
  const crew = local?.crews?.find((c) => c.id === sess.crewId);
  const profiles = (local?.profiles ?? []).filter((p) => p.crew_id === sess.crewId);
  if (!crew || !profiles.some((p) => p.id === sess.profileId)) return false;
  const pids = new Set(profiles.map((p) => p.id));
  try {
    const moved = await state.adapter.importCrew({
      crew, profiles,
      sets: (local.sets ?? []).filter((r) => pids.has(r.profile_id)),
      statuses: (local.statuses ?? []).filter((r) => pids.has(r.profile_id)),
    });
    session.save({ ...sess, crewCode: moved.crew_code, crewId: moved.id });
    await loadCrew(moved.id, sess.profileId);
    return true;
  } catch (e) {
    console.warn("bringing solo history across failed", e);
    return false;
  }
}

async function loadCrew(crewId, profileId) {
  const all = await state.adapter.fetchAll(crewId);
  if (!all.crew) throw new Error("crew not found");
  state.crew = all.crew;
  state.profiles = all.profiles;
  state.sets = all.sets;
  state.statuses = all.statuses;
  state.settings = { ...DEFAULT_SETTINGS, ...(all.crew.settings || {}) };
  state.me = state.profiles.find((p) => p.id === profileId) ?? null;
  if (!state.me) throw new Error("profile not found");
  if (unsubscribeCrew) { unsubscribeCrew(); unsubscribeCrew = null; }
  unsubscribeCrew = state.adapter.subscribe(crewId, () => refetch());
}

// subscribe()'s poll/channel callback, visibilitychange, and every mutation
// path all call refetch() independently; without a guard a slow network
// could have two or three fetchAll() calls in flight at once and race on
// which one renders last. `inFlight` makes every overlapping caller share
// the SAME network round trip instead of starting a new one; `queuedAgain`
// guarantees that shared promise doesn't resolve until at least one pass
// that *started after* the latest caller's request has landed and rendered
// — so `await refetch()` right after a mutation still sees that mutation
// once it resolves, it just isn't necessarily its own dedicated round trip.
let inFlight = null;
let queuedAgain = false;
async function refetch() {
  if (!state.crew) return;
  if (inFlight) { queuedAgain = true; return inFlight; }
  inFlight = (async () => {
    do {
      queuedAgain = false;
      try {
        const all = await state.adapter.fetchAll(state.crew.id);
        state.crew = all.crew; state.profiles = all.profiles;
        state.sets = all.sets; state.statuses = all.statuses;
        state.settings = { ...DEFAULT_SETTINGS, ...(all.crew.settings || {}) };
        // re-point state.me at the fresh copy (not just the stale reference
        // from loadCrew) so a profile edit — or any other change to your own
        // row — shows up immediately instead of only after a full reload.
        state.me = state.profiles.find((p) => p.id === state.me.id) ?? state.me;
        renderAll();
      } catch (e) {
        console.warn("refetch failed", e); // background refresh failure shouldn't crash the app — next trigger retries
      }
    } while (queuedAgain);
    inFlight = null;
  })();
  return inFlight;
}

function showApp() {
  $("onboarding").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderAll();
}

// ---------- avatars: animated line-art profile marks (emoji kept as legacy fallback) ----------

const AVATAR_ART = {
  pumper: '<svg viewBox="0 0 48 48"><path d="M8 37 H40" opacity=".5"/><g class="aa-pump"><path d="M9 33 L26 27 L33 24.5"/><circle cx="37.5" cy="21.5" r="3.8" fill="currentColor" stroke="none"/><path d="M32 25 L30.5 29"/></g><path d="M30.5 29 L30 33"/><path d="M9 33 L8 37"/></svg>',
  flex: '<svg viewBox="0 0 48 48"><circle cx="14" cy="9" r="4.5"/><path d="M14 15 V33"/><path d="M14 33 L9 43 M14 33 L20 43"/><path d="M14 20 L26 24"/><g class="aa-flex"><path d="M26 24 L36 16"/><circle cx="38" cy="14" r="4.5"/></g></svg>',
  grit: '<svg viewBox="0 0 48 48"><g class="aa-gritShake"><circle cx="24" cy="25" r="15"/><g class="aa-brow"><path d="M16 19 L22 22 M32 19 L26 22"/></g><circle cx="20" cy="27" r="1.7" fill="currentColor" stroke="none"/><circle cx="28" cy="27" r="1.7" fill="currentColor" stroke="none"/><path d="M18 34 H30 M20.5 34 V37 M24 34 V37.5 M27.5 34 V37"/></g><circle class="aa-sweat" cx="41" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>',
  beast: '<svg viewBox="0 0 48 48"><g class="aa-beastShake"><circle cx="24" cy="27" r="13"/><path class="aa-brow" d="M15 21 H33"/><circle cx="19.5" cy="26" r="1.7" fill="currentColor" stroke="none"/><circle cx="28.5" cy="26" r="1.7" fill="currentColor" stroke="none"/><path class="aa-roar" d="M20 34 Q24 31 28 34"/></g><path class="aa-hornL" d="M11 16 L17 11"/><path class="aa-hornR" d="M37 16 L31 11"/></svg>',
  bolt: '<svg viewBox="0 0 48 48"><path class="aa-bolt" d="M27 5 L13 27 H22 L19 43 L35 20 H25 Z"/></svg>',
  spring: '<svg viewBox="0 0 48 48"><g class="aa-sprBody"><circle cx="24" cy="9" r="4.5"/><path d="M24 14 V27"/><path class="aa-sprArmL" d="M24 18 L13 9"/><path class="aa-sprArmR" d="M24 18 L35 9"/><path class="aa-sprLegL" d="M24 27 L14 40"/><path class="aa-sprLegR" d="M24 27 L34 40"/></g></svg>',
  zen: '<svg viewBox="0 0 48 48"><ellipse class="aa-zenShadow" cx="24" cy="38" rx="13" ry="2.6" fill="currentColor" stroke="none" opacity=".35"/><g class="aa-zenBody"><path d="M10 33 Q24 26 38 33"/><circle cx="24" cy="9.5" r="4.6"/><path d="M24 14.5 V25"/><path d="M24 17.5 Q13 20.5 10.5 29 M24 17.5 Q35 20.5 37.5 29"/></g></svg>',
  bell: '<svg viewBox="0 0 48 48"><path class="aa-ringL" d="M10 9 L5 4 M6 14 L1 12"/><path class="aa-ringR" d="M38 9 L43 4 M42 14 L47 12"/><g class="aa-rock"><rect x="8" y="15" width="6.5" height="18" rx="2.5"/><rect x="33.5" y="15" width="6.5" height="18" rx="2.5"/><path d="M15 24 H33"/><circle class="aa-clapper" cx="24" cy="25" r="2.3" fill="currentColor" stroke="none"/></g></svg>',
  flame: '<svg viewBox="0 0 48 48"><path class="aa-tongueL" d="M16 29 C14 26 15 22 18 18 C17 22 18 25 20 27 Z"/><path class="aa-tongueR" d="M32 29 C34 26 33 22 30 18 C31 22 30 25 28 27 Z"/><path class="aa-flick" d="M24 6 C28 14 34 17 34 27 A10 10 0 0 1 14 27 C14 20 20 16 24 6 Z"/><path class="aa-core" d="M24 17 C26.5 21 29 24.5 29 29 A5 5 0 0 1 19 29 C19 24.5 21.5 21 24 17 Z" fill="currentColor" stroke="none"/></svg>',
  star: '<svg viewBox="0 0 48 48"><path class="aa-glintA" d="M8 10 L8 4 M5 7 L11 7"/><path class="aa-glintB" d="M42 34 L42 40 M39 37 L45 37"/><path class="aa-twinkle" d="M24 6 L28.5 18 L41 19 L31 27 L34.5 40 L24 32.5 L13.5 40 L17 27 L7 19 L19.5 18 Z"/></svg>',
  peak: '<svg viewBox="0 0 48 48"><path d="M6 38 L20 14 L27 26 L33 18 L42 38 Z" fill="currentColor" stroke="none"/><g class="aa-pole"><path d="M20 14 V6"/><path class="aa-flagA" d="M20 6 L29 9 L20 12 Z" fill="currentColor" stroke="none"/><path class="aa-flagB" d="M20 6.5 L27 8.7 L20 11.5 Z" fill="currentColor" stroke="none" opacity=".55"/></g></svg>',
  runner: '<svg viewBox="0 0 48 48"><circle cx="30" cy="10" r="4.5"/><path d="M28 15 L22 26"/><path d="M22 26 L14 30 M26 20 L36 24"/><path class="aa-runLegF" d="M22 26 L28 34 L24 42"/><path class="aa-runLegB" d="M22 26 L12 40"/></svg>',
  crown: '<svg viewBox="0 0 48 48"><path class="aa-seesaw" d="M10 34 L8 15 L18 24 L24 10 L30 24 L40 15 L38 34 Z"/><path d="M10 38 H38"/></svg>',
  wave: '<svg viewBox="0 0 48 48"><path class="aa-slide" d="M-8 30 Q-1 22 6 30 T20 30 T34 30 T48 30 T62 30" fill="none"/><path class="aa-slide2" d="M-12 38 Q-5 31 2 38 T16 38 T30 38 T44 38 T58 38 T72 38" fill="none" opacity=".5"/></svg>',
  // ---- Wave 7: 6 new non-fitness avatars (additive; existing 14 ids/order untouched) ----
  rocket: '<svg viewBox="0 0 48 48"><g class="aa-rocketBody"><path d="M24 4 C30 10 32 20 32 29 L16 29 C16 20 18 10 24 4 Z"/><circle cx="24" cy="17" r="3"/><path d="M16 27 L9 36 L16 32 Z M32 27 L39 36 L32 32 Z"/></g><path class="aa-flameMain" d="M19.5 29 L24 40 L28.5 29 Z"/><circle class="aa-puffL" cx="15" cy="34" r="2.2" fill="currentColor" stroke="none"/><circle class="aa-puffR" cx="33" cy="34" r="2.2" fill="currentColor" stroke="none"/></svg>',
  paw: '<svg viewBox="0 0 48 48"><g class="aa-pawStamp"><ellipse cx="24" cy="32" rx="9" ry="7" fill="currentColor" stroke="none"/><ellipse cx="12.5" cy="19" rx="4" ry="5" fill="currentColor" stroke="none"/><ellipse cx="21" cy="12.5" rx="4" ry="5.2" fill="currentColor" stroke="none"/><ellipse cx="29" cy="12.5" rx="4" ry="5.2" fill="currentColor" stroke="none"/><ellipse cx="37.5" cy="19" rx="4" ry="5" fill="currentColor" stroke="none"/></g></svg>',
  robot: '<svg viewBox="0 0 48 48"><g class="aa-antenna"><path d="M24 14 V7"/><circle cx="24" cy="5" r="2.4" fill="currentColor" stroke="none"/></g><rect x="12" y="14" width="24" height="19" rx="4"/><rect x="18" y="33" width="12" height="7" rx="1.5"/><g class="aa-blink"><rect x="16.5" y="21" width="4" height="4" rx="1"/><rect x="27.5" y="21" width="4" height="4" rx="1"/></g><path d="M17 29 H31"/></svg>',
  coffee: '<svg viewBox="0 0 48 48"><path class="aa-steamA" d="M18 20 Q15 16 18 12 Q21 8 18 4"/><path class="aa-steamB" d="M28 20 Q25 16 28 12 Q31 8 28 4"/><path d="M12 22 H32 L30 38 Q30 41 27 41 H17 Q14 41 14 38 Z"/><path d="M32 25 Q40 25 40 31 Q40 37 32 36"/></svg>',
  controller: '<svg viewBox="0 0 48 48"><rect x="7" y="15" width="34" height="19" rx="9.5"/><rect x="14.5" y="18.5" width="3" height="9" rx="1"/><rect x="11.5" y="21.5" width="9" height="3" rx="1"/><circle class="aa-ctrlBtn" cx="30" cy="19" r="2" fill="currentColor" stroke="none"/><circle cx="34" cy="23" r="2" fill="currentColor" stroke="none"/><circle cx="30" cy="27" r="2" fill="currentColor" stroke="none"/><circle cx="26" cy="23" r="2" fill="currentColor" stroke="none"/></svg>',
  headphones: '<svg viewBox="0 0 48 48"><path d="M10 26 A14 14 0 0 1 38 26"/><rect x="6" y="24" width="8" height="14" rx="3"/><rect x="34" y="24" width="8" height="14" rx="3"/><path class="aa-eqA" d="M20 34 V26"/><path class="aa-eqB" d="M24 36 V22"/><path class="aa-eqC" d="M28 34 V28"/></svg>',
  // ---- the last rung: worn, never chosen ----
  // Deliberately absent from AVATARS below: art lives here, the selectable
  // list lives there, and keeping them separate is what makes the spoon
  // impossible to pick on purpose. It stands on its handle and wobbles.
  spoon: '<svg viewBox="0 0 48 48"><path d="M12 45.5 H36" opacity=".45"/><g class="aa-spoonRock"><g transform="rotate(-8 24 43)"><path fill-rule="evenodd" fill="currentColor" stroke="none" d="M21.6 4.2 C21.6 2.9 22.6 2 24 2 C25.4 2 26.4 2.9 26.4 4.2 L25.8 22.5 C30.4 24 32.6 28.4 32.6 34 C32.6 40.5 28.8 45 24 45 C19.2 45 15.4 40.5 15.4 34 C15.4 28.4 17.6 24 22.2 22.5 Z M19 31.5 C20.6 35.4 27.4 35.4 29 31.5 C27.4 33.8 20.6 33.8 19 31.5 Z"/></g></g></svg>',

  // ---- achievement marks (owner-approved 2026-08-31) ----
  // Drawn in design/achievement-icons/v3-icons.js and judged on the REAL
  // substrate: cream --on-accent on the --grad disc, at 88px AND 44px, with
  // the animation off. Both earlier labs judged teal-on-paper at source size,
  // which is why marks that could not survive a chip kept passing review.
  //
  // Like `spoon` these are absent from AVATARS below: they are WORN, not
  // chosen, until an unlock puts one in the wardrobe.
  //
  // `eagleSoaring` is deliberately NOT here. Five passes at its beak have all
  // been rejected; at ~10 of 48 units the head has no room for one. It stays
  // in the lab until that is resolved.
  earlyBird: '<svg viewBox="0 0 48 48"><g class="aa-birdPeck"><path d="M13.5 12.5 C17 8.5 21 9.5 22.5 12" opacity=".8"/><circle cx="20" cy="23" r="12"/><circle cx="16.5" cy="19.5" r="2.4" fill="currentColor" stroke="none"/><path fill="currentColor" stroke="none" d="M31 18.5 L45 22.5 L31 26.5 Z"/><g class="aa-wormWiggle"><path d="M44 25 C46 29 42 31 44 35 C45.5 38 42.5 40 43 43"/></g></g></svg>',
  fourFigures: '<svg viewBox="0 0 48 48"><g class="aa-rosetteSwing"><path d="M18.5 29 L15.5 45 L24 40.5 L32.5 45 L29.5 29 Z" fill="currentColor" stroke="none" opacity=".55"/><path fill="currentColor" stroke="none" d="M24.00 5.30 L26.48 9.23 L30.60 7.07 L30.79 11.71 L35.43 11.90 L33.27 16.02 L37.20 18.50 L33.27 20.98 L35.43 25.10 L30.79 25.29 L30.60 29.93 L26.48 27.77 L24.00 31.70 L21.52 27.77 L17.40 29.93 L17.21 25.29 L12.57 25.10 L14.73 20.98 L10.80 18.50 L14.73 16.02 L12.57 11.90 L17.21 11.71 L17.40 7.07 L21.52 9.23 Z"/><circle cx="24" cy="18.5" r="5.4" fill="none" stroke="currentColor" opacity=".55"/></g></svg>',
  gripStrength: '<svg viewBox="0 0 48 48"><path d="M3 9 H45" opacity=".55"/><path d="M2 4 H46 V9 H2 Z" fill="currentColor" stroke="none" opacity=".28"/><g class="aa-hangSwing"><path d="M18.5 10.5 L21 21.5 M29.5 10.5 L27 21.5"/><path d="M21 21.5 H27"/><circle cx="24" cy="17.5" r="4.1" fill="currentColor" stroke="none"/><path d="M24 21.5 V31"/><path d="M24 31 L21.5 38 L22.5 44 M24 31 L26.5 38 L25.5 44"/></g></svg>',
  ironLung: '<svg viewBox="0 0 48 48"><path fill-rule="evenodd" fill="currentColor" stroke="none" d="M20.6 4.2 C20.6 2.8 22.1 2.2 24 2.2 C25.9 2.2 27.4 2.8 27.4 4.2 L27.4 16.5 L20.6 16.5 Z M21.5 6.4 L26.5 6.4 L26.5 7.9 L21.5 7.9 Z M21.5 10.1 L26.5 10.1 L26.5 11.6 L21.5 11.6 Z M21.5 13.8 L26.5 13.8 L26.5 15.3 L21.5 15.3 Z"/><g class="aa-lungBreath"><path fill="currentColor" stroke="none" d="M21.6 14 C18.6 13.6 15 15.4 12 19.2 C8.2 24 5.8 30.4 5.8 35.4 C5.8 39 6.8 41.8 9.4 41.8 L18.8 41.8 C20.4 41.8 21.6 40.6 21.6 39 Z"/><path fill="currentColor" stroke="none" d="M26.4 14 C29.4 13.6 33 15.4 36 19.2 C39.8 24 42.2 30.4 42.2 35.4 C42.2 39 41.2 41.8 38.6 41.8 L29.2 41.8 C27.6 41.8 26.4 40.6 26.4 39 Z"/></g></svg>',
  // Above the Clouds — 10,000 banked (was "Blue Water", a sloop on the sea:
  // the only nautical thing in a climbing app). One silhouette, not a scene:
  // the cloud bank crosses in FRONT of the mountain in the same fill, so the
  // weather is the peak. Two shapes with SKY BETWEEN THEM, not one silhouette:
  // drawn touching (twice) the cloud merged into the mountain's base in the
  // same fill and the whole thing read as a mountain on a plinth — "there is no
  // cloud in the icon" (owner, 2026-09-18). The gap is the mark. Bank drifts;
  // the mountain never moves.
  aboveClouds: '<svg viewBox="0 0 48 48"><path fill="currentColor" stroke="none" d="M10 26 L20.5 6 L26 17 L30 11.5 L38 26 Z"/><g class="aa-cloudBank" fill="currentColor" stroke="none"><rect x="4" y="33" width="40" height="7.5" rx="3.75"/><circle cx="11" cy="33.5" r="5.6"/><circle cx="20" cy="32" r="6.2"/><circle cx="29.5" cy="33" r="5.6"/><circle cx="37.5" cy="34" r="4.6"/></g></svg>',
  basecampTavern: '<svg viewBox="0 0 48 48"><path fill-rule="evenodd" fill="currentColor" stroke="none" d="M14.5 8 H33.5 C36.5 8 38.5 15 38.5 24 C38.5 33 36.5 40 33.5 40 H14.5 C11.5 40 9.5 33 9.5 24 C9.5 15 11.5 8 14.5 8 Z M10.6 15.5 L37.4 15.5 L37.4 17.6 L10.6 17.6 Z M9.8 22.9 L38.2 22.9 L38.2 25 L9.8 25 Z M10.6 30.3 L37.4 30.3 L37.4 32.4 L10.6 32.4 Z"/><path d="M38.5 24 H44 V27" /><g class="aa-kegDrip"><circle cx="44" cy="30" r="2.1" fill="currentColor" stroke="none"/></g><g class="aa-kegDripB"><circle cx="44" cy="30" r="1.7" fill="currentColor" stroke="none"/></g></svg>',
  // Eagle Soaring. Fourteen rounds; the failures are worth keeping because they
  // were all the same failure. A tall rounded body standing upright IS a penguin —
  // that is a silhouette problem, and no beak, tail or shoulder tweak beats it.
  // What finally worked: a bald-eagle beak built to actual anatomy (deep at the
  // base, culmen fairly STRAIGHT, hook curling hard at the tip — curve the top edge
  // and it becomes a duck bill), a domed skull with the eye set well back off the
  // beak, and a CLENCHED talon. The perch bar is gone at the owner's call, which is
  // why the talon has to grip nothing and still read as a foot.
  eagleSoaring: '<svg viewBox="0 0 48 48"><g class="aa-eagleSettle"><path d="M13.5 36.5 C9.5 28 7.5 15 15 9 C17.8 5.8 22.4 5.2 26.2 7.4 L35.5 12.2 Q39 15.4 35.5 20.6 Q32.6 16.6 28 15.6 C29.6 22 28.6 30 25.4 35 L23 38.5"/><circle cx="20.2" cy="12.8" r="2" fill="currentColor" stroke="none"/><path d="M12.6 24 C15.7 27 17.2 31 17 35" opacity=".55"/><path d="M23 38.5 C27 39.2 28.5 41.4 26.9 43.4 C26.1 42.2 25.1 41.6 23.9 41.6 M23 38.5 C19 39.2 17.5 41.4 19.1 43.4 C19.9 42.2 20.9 41.6 22.1 41.6"/></g></svg>',

  // ---- the remaining achievement marks (2026-09-08) ----
  // Drawn by a four-worker crew to design/achievement-icons/marks-crew/BRIEF.md,
  // then reviewed on the real substrate. Three were redrawn by LEAD after that
  // review and the reasons are in e-lead-redraws.js: `summit` collided with the
  // shipped `star` avatar, which would have made an EARNED mark identical to one
  // anybody can simply pick; `midnightNinja` rendered as a pinwheel and was a read
  // of the achievement's NAME rather than its rule; `firstRung` read as a bench.
  // Like every other achievement mark these are absent from AVATARS: worn, not chosen.
  discoFever: '<svg viewBox="0 0 48 48"><g class="aa-moonDrift"><path fill-rule="evenodd" fill="currentColor" stroke="none" d="M42 25.6 A18 18 0 1 1 22.4 6 A14 14 0 0 0 42 25.6 Z M25.5 19.2 A2 2 0 1 0 25.5 23.2 A2 2 0 1 0 25.5 19.2 Z M32 19.5 Q34.6 19.5 34.6 21.5 Q32 21.5 32 19.5 Z M25 27.5 Q29 30.5 33.5 27.7 Q29.5 33 25 27.5 Z"/></g><path d="M10 10 L11 12.5 L13.5 13.5 L11 14.5 L10 17 L9 14.5 L6.5 13.5 L9 12.5 Z" fill="currentColor" stroke="none" opacity=".5"/><circle cx="8" cy="34" r="1.5" fill="currentColor" stroke="none" opacity=".45"/></svg>',
  midnightNinja: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="17"/><path d="M24 5.5 V9 M42.5 24 H39 M24 42.5 V39 M5.5 24 H9" opacity=".55"/><g class="aa-midnightHands"><path d="M24 24 V11.5"/><path d="M24 24 V13.5"/></g><circle cx="24" cy="24" r="2" fill="currentColor" stroke="none"/></svg>',
  whiteKnuckle: '<svg viewBox="0 0 48 48"><rect x="14" y="6" width="20" height="4" rx="2" fill="currentColor" stroke="none"/><rect x="14" y="38" width="20" height="4" rx="2" fill="currentColor" stroke="none"/><path d="M16 10 Q16 20 24 24 Q16 28 16 38 M32 10 Q32 20 24 24 Q32 28 32 38" opacity=".5"/><path d="M18 36 Q18 28 24 26 Q30 28 30 36 Z" fill="currentColor" stroke="none"/><path d="M21.5 20 L26.5 20 L24 23 Z" fill="currentColor" stroke="none"/><g class="aa-grainDrop"><circle cx="24" cy="25" r="1.6" fill="currentColor" stroke="none"/></g></svg>',
  firstRung: '<svg viewBox="0 0 48 48"><path d="M15 2 V38 M33 2 V38" opacity=".45"/><g class="aa-rungSet"><rect x="13" y="27.5" width="22" height="5" rx="2.5" fill="currentColor" stroke="none"/></g><path d="M10 42 H38" opacity=".5"/><circle cx="15" cy="38" r="2.2" fill="currentColor" stroke="none"/><circle cx="33" cy="38" r="2.2" fill="currentColor" stroke="none"/></svg>',
  fullLedger: '<svg viewBox="0 0 48 48"><rect x="11" y="6" width="26" height="36" rx="2"/><path d="M14 6 V42" opacity=".5"/><path d="M18 33 V22 M22 33 V22 M26 33 V22 M30 33 V22"/><path d="M16 32 L32 21"/><g class="aa-ledgerFlutter"><path d="M29 6 L34 6 L34 15 L31.5 12.3 L29 15 Z" fill="currentColor" stroke="none"/></g></svg>',
  // Steadfast Grip — a whole week met, no rest day taken. Was two chain links,
  // which "does not convey fitness or grip in any way" (owner, 2026-09-18) and
  // the house rules had already called generic. A fist closed on the rope is
  // this app's own words for holding on all week: knuckles over a solid hand,
  // thumb wrapped across, the rope running past above and below so it reads as
  // a grip rather than a punch. Distinct from Grip Strength, which is the whole
  // body hanging off a bar.
  steadfastGrip: '<svg viewBox="0 0 48 48"><rect x="19" y="1" width="10" height="46" rx="5" fill="currentColor" stroke="none" opacity=".4"/><g class="aa-fistClench" fill="currentColor" stroke="none"><circle cx="15" cy="18" r="3.8"/><circle cx="22" cy="16.6" r="4"/><circle cx="29" cy="16.8" r="3.9"/><circle cx="35" cy="18.6" r="3.4"/><rect x="11" y="17.5" width="28" height="20" rx="5.5"/><ellipse cx="11.5" cy="31" rx="6.6" ry="4.4" transform="rotate(-30 11.5 31)"/></g></svg>',
  keptClimbing: '<svg viewBox="0 0 48 48"><path d="M10 42 L16 6"/><path d="M38 42 L32 6"/><path d="M11.3 34 H36.7"/><path d="M12.7 26 H35.3"/><path d="M14 18 H34"/><g class="aa-stepPulse"><path d="M15.3 10 H32.7"/></g></svg>',
  firstPin: '<svg viewBox="0 0 48 48"><circle cx="24" cy="9" r="2.8" fill="currentColor" stroke="none"/><g class="aa-noteSwing"><g transform="rotate(-6 24 25)"><path d="M12 14 Q12 12 14 12 H30 L36 18 V37 Q36 39 34 39 H14 Q12 39 12 37 Z"/><path d="M30 12.5 L34.5 17"/><path d="M16 20 H30"/><path d="M16 26 H24"/><path d="M16 32 H31"/><path d="M13 38 Q10 41.5 14 42.5" opacity=".5"/></g></g></svg>',
  storyteller: '<svg viewBox="0 0 48 48"><path d="M8 14 Q8 6 16 6 H26" opacity=".5"/><path d="M10 45 H34" opacity=".45"/><g class="aa-bubbleNod"><path fill-rule="evenodd" fill="currentColor" stroke="none" d="M14 8 H34 Q38 8 38 12 V26 Q38 30 34 30 H20 L15 39 L17 30 H14 Q10 30 10 26 V12 Q10 8 14 8 Z M13.3 19 a1.7 1.7 0 1 0 3.4 0 a1.7 1.7 0 1 0 -3.4 0 Z M17.8 19 a1.7 1.7 0 1 0 3.4 0 a1.7 1.7 0 1 0 -3.4 0 Z M22.3 19 a1.7 1.7 0 1 0 3.4 0 a1.7 1.7 0 1 0 -3.4 0 Z M26.8 19 a1.7 1.7 0 1 0 3.4 0 a1.7 1.7 0 1 0 -3.4 0 Z M31.3 19 a1.7 1.7 0 1 0 3.4 0 a1.7 1.7 0 1 0 -3.4 0 Z"/><circle cx="11" cy="44" r="1.3" fill="currentColor" stroke="none" opacity=".4"/><path d="M36 5 L39 2" opacity=".5"/><path d="M40 8 L44 6" opacity=".5"/></g></svg>',
  lostWilderness: '<svg viewBox="0 0 48 48"><path d="M26 44 L22 24 L17 5"/><path d="M16 45 H21 M31 45 H36" opacity=".5"/><path d="M20 33 L24 35" opacity=".5"/><circle cx="20" cy="16" r="1.6" fill="currentColor" stroke="none"/><g class="aa-signSwing"><g transform="rotate(-10 20 16)"><path d="M20 11 H38 L44 16 L38 21 H20 Z" fill="currentColor" stroke="none"/></g></g></svg>',
  itchyFingers: '<svg viewBox="0 0 48 48"><ellipse cx="24" cy="36" rx="7" ry="5.5" fill="currentColor" stroke="none"/><ellipse cx="15" cy="20" rx="2.6" ry="9" fill="currentColor" stroke="none"/><ellipse cx="21" cy="13" rx="2.8" ry="11" fill="currentColor" stroke="none"/><ellipse cx="27.5" cy="14" rx="2.8" ry="10.5" fill="currentColor" stroke="none"/><ellipse cx="10" cy="33" rx="4.5" ry="3" fill="currentColor" stroke="none" transform="rotate(-40 10 33)"/><g class="aa-fingerTwitch"><ellipse cx="33.5" cy="21" rx="2.4" ry="8" fill="currentColor" stroke="none"/><path d="M31 6 Q33 3 35 6 Q37 9 39 6"/></g></svg>',
  moneyBags: '<svg viewBox="0 0 48 48"><ellipse cx="24" cy="45.5" rx="13" ry="2" opacity=".5"/><path fill-rule="evenodd" fill="currentColor" stroke="none" d="M24 12 C20 12 17.5 14.3 17.5 17.3 C13 19.6 9 26.6 9 33.6 C9 39.8 15 44 24 44 C33 44 39 39.8 39 33.6 C39 26.6 35 19.6 30.5 17.3 C30.5 14.3 28 12 24 12 Z M20 17.4 H28 V19 H20 Z"/><g class="aa-coinPop"><ellipse cx="19" cy="12.8" rx="3.8" ry="3.1" fill="currentColor" stroke="none" transform="rotate(-18 19 12.8)"/><ellipse cx="40" cy="37" rx="4.3" ry="3.5" fill="currentColor" stroke="none"/><ellipse cx="42" cy="32.5" rx="4.3" ry="3.5" fill="currentColor" stroke="none"/><ellipse cx="40.3" cy="28" rx="4.3" ry="3.5" fill="currentColor" stroke="none"/></g></svg>',
  dynamite: '<svg viewBox="0 0 48 48"><path opacity=".45" d="M15 43 H33"/><path fill-rule="evenodd" fill="currentColor" stroke="none" d="M22 15 H26 A3 3 0 0 1 29 18 V37 A3 3 0 0 1 26 40 H22 A3 3 0 0 1 19 37 V18 A3 3 0 0 1 22 15 Z M20.5 22 H27.5 V23.6 H20.5 Z M20.5 30 H27.5 V31.6 H20.5 Z"/><path d="M24 15 Q18 11 22 9"/><g class="aa-fuseSpark"><path fill="currentColor" stroke="none" d="M26 1 L27.3 4.7 L31 6 L27.3 7.3 L26 11 L24.7 7.3 L21 6 L24.7 4.7 Z"/></g><circle cx="36" cy="13" r="1.3" fill="currentColor" stroke="none"/><path d="M33.3 10.3 L35.2 12.2"/></svg>',
  summit: '<svg viewBox="0 0 48 48"><path d="M7 43 H41" opacity=".5"/><path fill="currentColor" stroke="none" d="M9 42.5 C9 39 13.5 36.5 24 36.5 C34.5 36.5 39 39 39 42.5 Z"/><path fill="currentColor" stroke="none" d="M12.5 36 L34 35 L32.5 29.5 L14.5 30.5 Z"/><path fill="currentColor" stroke="none" d="M16 29.5 L31 28.5 L29 23.5 L17.5 24.5 Z"/><path fill="currentColor" stroke="none" d="M18.5 24 L28.5 23 L27 18 L20 18.5 Z"/><g class="aa-cairnTop"><path fill="currentColor" stroke="none" d="M20.5 17.5 L26.5 17 L25 12.5 L21.5 13 Z"/></g></svg>',
  spoonless: '<svg viewBox="0 0 48 48"><path opacity=".45" d="M14 44 H34"/><path fill-rule="evenodd" fill="currentColor" stroke="none" d="M22.7 6.5 C22.7 5.5 23.3 5 24 5 C24.7 5 25.3 5.5 25.3 6.5 L25 17.5 C28.2 18.6 29.8 21.6 29.8 25.2 C29.8 29.5 27.3 32.5 24 32.5 C20.7 32.5 18.2 29.5 18.2 25.2 C18.2 21.6 19.8 18.6 23 17.5 Z M20.6 23.8 C21.7 26.3 26.3 26.3 27.4 23.8 C26.3 25.4 21.7 25.4 20.6 23.8 Z"/><circle cx="24" cy="20" r="17"/><path d="M12 8 L36 32"/><g class="aa-motesDrift"><circle cx="16" cy="41.3" r="1.3" fill="currentColor" stroke="none"/><circle cx="32.5" cy="42" r="1.1" fill="currentColor" stroke="none"/></g></svg>',
  // GOAT. The v2 head-only drawing. Head vs full body was open from 2026-08-31
  // (the owner's note said head; their reference links were side-on bodies,
  // which v2-house-rules refuses). Settled 2026-09-14 — owner: "the goat head
  // is the better, i like it". Do not swap in a body.
  goat: '<svg viewBox="0 0 48 48"><ellipse cx="10.5" cy="23.5" rx="5.6" ry="2.9" transform="rotate(22 10.5 23.5)" fill="currentColor" stroke="none"/><ellipse cx="37.5" cy="23.5" rx="5.6" ry="2.9" transform="rotate(-22 37.5 23.5)" fill="currentColor" stroke="none"/><path d="M18 11.5 C12 5 5 6.5 3 13.5"/><path d="M30 11.5 C36 5 43 6.5 45 13.5"/><path d="M13.5 22 C13.5 13.5 18 9.5 24 9.5 C30 9.5 34.5 13.5 34.5 22 L30.5 32 C30 35.5 26.5 37.5 24 37.5 C21.5 37.5 18 35.5 17.5 32 Z"/><circle cx="19" cy="21.5" r="2.1" fill="currentColor" stroke="none"/><circle cx="29" cy="21.5" r="2.1" fill="currentColor" stroke="none"/><path d="M21.8 30.5 H26.2" opacity=".55"/><g class="aa-goatBeard"><path d="M20.5 36 C19.5 40.5 21.5 42.5 24 45.5 C26.5 42.5 28.5 40.5 27.5 36"/></g></svg>',
};
// avatar value format: "art" or "art.colour" (per-person icon colour).
// Keys are stable (stored profiles reference them by name) — only the hex
// values changed 2026-07-23: blue/mustard/brick used to be byte-identical to
// the --rest/--excused/--missed day-state colours (people vs. state palette
// collision, council finding). New hues (slate/violet/rose) match nothing in
// style.css :root.
// Owner revision 2026-07-24 (round 2): palette aligned to the original
// first-iteration feel — green, blue, yellow, reddish — keeping the teal and
// the deep "background" pine the owner likes, black removed for a
// complementary violet. All hues deliberately distinct from every day-state
// colour in BOTH themes (light --missed #B23A2E / dark --missed #E8695C,
// light --excused #C98A2B / dark #E8AC52, etc.) and from volt. No orange.
const AVATAR_COLORS = { teal: "#0F7A6D", pine: "#0B3B34", blue: "#2E7CF6", mustard: "#F2C51D", brick: "#D9385E", ink: "#7B5CF0" };
function avatarParts(a) {
  const [art, col] = String(a || "").split(".");
  return { art, color: AVATAR_COLORS[col] || null };
}
function avatarHTML(a) {
  const { art } = avatarParts(a);
  return AVATAR_ART[art]
    ? `<span class="av">${AVATAR_ART[art]}</span>`
    : `<span class="av av-emoji">${esc(a)}</span>`;
}
// full circle chip incl. per-person background colour. `extraClass` (optional)
// lets a call site size/decorate the chip for its own context (e.g. Crew's
// corkboard-scale avatar + state ring) without a second avatar-rendering path.
function avatarChip(a, extraClass = "") {
  const { color } = avatarParts(a);
  return `<span class="avatar${extraClass ? ` ${extraClass}` : ""}"${color ? ` style="background:${color}"` : ""}>${avatarHTML(a)}</span>`;
}

// ---------- the last rung ----------
// Whoever came last in the week that just closed wears the wooden spoon for
// the whole of the week that follows, and it reverts on its own at the next
// reset. Nothing is stored — the holder is derived from the shared log every
// render, so all devices agree without anything having to be written down.
let spoonHolderId = null;
// Recomputed ONCE per render (from renderAll), never per avatar: the ranking
// walks every member's whole week, so calling it inside a map would redo that
// work for each card.
function refreshSpoonHolder() {
  spoonHolderId = weeklySpoon({
    sets: state.sets,
    statuses: state.statuses,
    profiles: state.profiles,
    weekStartDay: addDays(weekStart(today()), -7), // the week just closed
    settings: state.settings,
  });
}

// ---------- achievements ----------
// The other end of the same weekly ranking, plus every member's standing
// 24-hour unlock. Like the spoon, none of it is stored: `achievementUnlocks`
// derives the lot from the shared log, so two phones reach the same answer
// without anything being written down and there is no state to migrate when a
// rule changes.
let eagleHolderId = null;
let awardByProfile = new Map();   // profileId -> {key, at} currently worn by right
let myUnlocks = [];               // the signed-in member's unlocks, ascending

function refreshAwards() {
  const base = { sets: state.sets, statuses: state.statuses, profiles: state.profiles,
                 settings: state.settings };
  eagleHolderId = weeklyEagle({ ...base, weekStartDay: addDays(weekStart(today()), -7) });
  // Recomputed once per render for the whole crew, never per avatar: each call
  // walks that member's entire history, so doing it inside a map would redo
  // every walk for every card drawn.
  awardByProfile = new Map();
  const now = simNow();
  for (const p of state.profiles) {
    const unlocks = achievementUnlocks({ ...base, profileId: p.id, today: today() });
    if (state.me && p.id === state.me.id) myUnlocks = unlocks;
    const award = currentAward({ unlocks, now });
    if (award) awardByProfile.set(String(p.id), award);
  }
}

// The wear windows are measured against the clock, but the app has a date
// override for testing. Anchoring `now` to the simulated day keeps a simulated
// "today" from showing yesterday's unlock as expired (or tomorrow's as live).
function simNow() {
  const override = localStorage.getItem("pushpact-date-override");
  if (!override) return Date.now();
  const real = new Date();
  const d = parseDay(override);
  d.setHours(real.getHours(), real.getMinutes(), real.getSeconds(), 0);
  return d.getTime();
}
// The one place that decides which ART a member renders with. Their own colour
// is preserved — only the art swaps — so the chip still reads as them. Not
// used by the Settings/onboarding pickers on purpose: those show what a member
// CHOSE, and the spoon is not a choice.
// ---- achievement key -> avatar art ----
// The two namespaces are NOT the same and must not be assumed to be. The
// engine's key is `lastRung`; the mark that has always been drawn for it is
// `spoon`. And only 8 of the 22 achievements have art at all — the rest are
// specced and unlocked but undrawn.
//
// That gap is load-bearing. avatarHTML() falls back to rendering the raw string
// for an unknown key, so without this guard a member who unlocked, say, First
// Pin would wear the literal word "firstPin" on their avatar. An achievement
// with no mark is still EARNED — it shows in the panel and the log — it just
// cannot be worn until someone draws it.
const ACHIEVEMENT_ART = { lastRung: "spoon" };
function achievementArt(key) {
  const art = ACHIEVEMENT_ART[key] ?? key;
  return AVATAR_ART[art] ? art : null;
}

// Is this member's avatar currently something they EARNED rather than chose?
// Drives the badge frame. The weekly pair are excluded deliberately: the spoon
// is not an achievement to frame, and the eagle already announces itself by
// being the eagle.
function isWearingAward(p) {
  if (!p) return false;
  if (p.id === spoonHolderId || p.id === eagleHolderId) return false;
  const a = awardByProfile.get(String(p.id));
  return !!a && ACHIEVEMENT_BY_KEY[a.key]?.wear !== "weekly" && !!achievementArt(a.key);
}

function wornAvatar(p) {
  if (!p) return undefined;
  const colorKey = String(p.avatar || "").split(".")[1];
  const paint = (art) => (colorKey ? `${art}.${colorKey}` : art);
  // Spec rule 7: weekly rank, then the 24-hour unlock, then whatever you chose.
  // "You cannot unlock your way out of the spoon, nor out of the eagle."
  const d = decideAvatar({
    unlocks: String(p.id) === String(state.me?.id) ? myUnlocks : [],
    now: simNow(),
    isSpoonHolder: p.id === spoonHolderId,
    isEagleHolder: p.id === eagleHolderId,
    chosen: p.avatar,
  });
  if (d.source === "spoon") return paint(achievementArt("lastRung") ?? "spoon");
  if (d.source === "eagle" && achievementArt("eagleSoaring")) return paint("eagleSoaring");
  // Other members' unlocks come from the crew-wide pass, not from decideAvatar,
  // which only ever sees the signed-in member's list.
  const award = awardByProfile.get(String(p.id));
  if (award && ACHIEVEMENT_BY_KEY[award.key]?.wear !== "weekly") {
    const art = achievementArt(award.key);
    if (art) return paint(art);       // undrawn -> fall through to their own avatar
  }
  return p.avatar;
}

// haptics: navigator.vibrate is Android-only; iOS ≥17.4 gets the hidden
// switch-checkbox tick (same pattern as the fitness app). User-gesture-only.
let _hapticEl = null;
function hapticTick(ms = 10) {
  if (navigator.vibrate) { navigator.vibrate(ms); return; }
  try {
    if (!_hapticEl) {
      const label = document.createElement("label");
      label.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
      label.setAttribute("aria-hidden", "true");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      label.appendChild(input);
      document.body.appendChild(label);
      _hapticEl = label;
    }
    _hapticEl.click();
  } catch { /* no haptics available */ }
}

// ---------- serialized commit queue (Wave 4 fix) ----------
// homeQuickAdd and the bank-btn handler each snapshot `before = myTallyToday()`
// then await state.adapter.addSet(...) — a rapid double-tap, or plain
// Supabase latency, could let two overlapping calls read the same stale
// `before`, silently skipping a deserved celebration. Funnelling every commit
// through one promise chain guarantees each call's `before` is only read once
// the previous commit (and its refetch) has fully landed — no overlap is
// possible even if several taps queue up back to back.
let commitChain = Promise.resolve();
function serializeCommit(fn) {
  const run = commitChain.then(fn, fn);
  commitChain = run.catch(() => {});
  return run;
}

// ---------- confirm sheet (branded window.confirm replacement) ----------
// Fridge-ledger styled stand-in for the three destructive-ish window.confirm()
// prompts (undo a crank, tear a set out of the ledger, rewrite the crew's
// challenge, wipe all local data). Backdrop tap and Escape both cancel;
// focus defaults to Cancel so an impatient double-tap never confirms by
// accident; danger:true swaps the confirm button to the missed/red hue for
// the one genuinely irreversible action (data wipe).
function confirmSheet(message, { confirmLabel = "Do it", cancelLabel = "Cancel", danger = false } = {}) {
  const modal = $("confirm-modal");
  const okBtn = $("confirm-ok");
  const cancelBtn = $("confirm-cancel");
  return new Promise((resolve) => {
    $("confirm-message").textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle("btn-danger", danger);
    okBtn.classList.toggle("btn-primary", !danger);
    modal.classList.remove("hidden");

    function done(result) {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onOk() { done(true); }
    function onCancel() { done(false); }
    function onBackdrop(e) { if (e.target === modal) done(false); }
    function onKey(e) { if (e.key === "Escape") done(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    cancelBtn.focus();
  });
}

// ---------- celebration overlay (Wave 3: the lantern-glow wordmark's real stage) ----------
// One-shot, full-screen moment for the two events worth stopping the user for:
// the daily target getting smashed, and streak milestones (every 7 days).
// Reuses the header's own <symbol id="rr-wordmark"> via <use> — same asset,
// onboarding-scale (300px) — never a redrawn/duplicated SVG. Persisted
// per-day (target) / per-milestone (streak) in localStorage so re-renders,
// refocuses, or extra reps after the moment never replay it.
// The bank of target-met lines. Admin-editable (Settings, behind the gate) and
// stored in the crew settings jsonb, so a crew shares one bank. This constant is
// only the fallback for a crew that has never edited it.
const AFFIRM_MAX = 30;          // characters — beyond this it wraps and stops
                                // reading as a headline at the celebration size
const AFFIRM_MAX_LINES = 40;
const DEFAULT_AFFIRMATIONS = [
  "You did it", "Summit reached", "Target met", "Rung claimed", "Held the line",
  "Nothing owed", "Clean sheet", "Banked in full", "Full count", "Above the line",
  "Ledger closed", "Signed off", "Day secured", "Every rep counted", "Peak taken",
  "No excuse today", "Straight to the top", "That is the day", "You made the number",
  "One more rung", "Topped out", "Roped in, topped out", "Earned outright",
  "Nothing left owing", "Target cleared", "The climb continues", "Owed nothing",
  "Stood it up", "Counted, all of it", "Made the summit",
];
function affirmations() {
  const raw = state.settings && state.settings.affirmations;
  const list = Array.isArray(raw) ? raw.filter((s) => typeof s === "string" && s.trim()) : [];
  return list.length ? list : DEFAULT_AFFIRMATIONS;
}
let lastAffirm = null;
function pickAffirmation() {
  const list = affirmations();
  if (list.length === 1) return list[0];
  let v;
  do { v = list[Math.floor(Math.random() * list.length)]; } while (v === lastAffirm);
  lastAffirm = v;   // never the same line two celebrations running
  return v;
}
const STREAK_CELEBRATE_LINES = {
  7: "Seven days. Knot tied.",
  14: "Two weeks straight. The rope holds.",
  21: "Three weeks. That's a habit now.",
  28: "Four weeks straight. Cast in stone.",
};
function streakCelebrateLine(n) {
  return STREAK_CELEBRATE_LINES[n] || `${n} days straight. Still climbing.`;
}

function celebrationSeenKey(kind, id) {
  return `pushpact-celebrate-${kind}-${state.me.id}-${id}`;
}
// queued rather than fired straight in, so a celebration arriving while one is
// already on screen waits its turn — never two overlays stacked. (Target and
// streak on the SAME commit never queue two: see maybeCelebrate.)
const celebrateQueue = [];
let celebrateShowing = false;
let celebrateTimers = [];

// Unguarded — for moments that should replay every time they happen.
function queueCelebration(entry) {
  celebrateQueue.push(entry);
  if (!celebrateShowing) showNextCelebration();
  return true;
}

// Guarded — for milestones that must fire once and only once (a 7-day streak is
// not something you can cross twice). Returns whether it queued anything.
function queueCelebrationOnce(kind, id, entry) {
  const key = celebrationSeenKey(kind, id);
  if (localStorage.getItem(key) === "1") return false; // already played — one-shot
  localStorage.setItem(key, "1");
  return queueCelebration(entry);
}

// The take, in ms, from design/celebration/index.html as compressed to ~10s.
// These mirror the .playing timeline in style.css — change one, change both.
const CEL_BURST_MS = 4680;   // the camera kick: the moment it goes off
const CEL_LEAVE_MS = 9900;   // ember landed at 9600, lantern relit; fade home
const CEL_FADE_MS = 600;     // matches #celebrate-overlay.leaving
const CEL_REDUCED_MS = 2400; // the static take: read the line, done
const CEL_STAGE_W = 390, CEL_STAGE_H = 800;  // the prototype's frame

// 24 spokes are fixed; the 46 confetti flecks are re-thrown every time so no
// two celebrations scatter the same way.
function buildCelebrationDebris() {
  const burst = $("cel-burst");
  if (!burst.querySelector(".cel-spark")) {
    for (let i = 0; i < 24; i++) {
      const sp = document.createElement("i");
      sp.className = "cel-spark";
      sp.style.setProperty("--a", `${i * 15 + (i % 2 ? 7 : 0)}deg`);
      burst.appendChild(sp);
    }
  }
  const flecks = $("cel-flecks");
  flecks.textContent = "";
  for (let f = 0; f < 46; f++) {
    const el = document.createElement("i");
    el.className = "cel-fleck";
    const ang = Math.random() * Math.PI * 2, dist = 95 + Math.random() * 245;
    el.style.setProperty("--fx", `${(Math.cos(ang) * dist).toFixed(0)}px`);
    el.style.setProperty("--fy", `${(Math.sin(ang) * dist * 0.75 + 90).toFixed(0)}px`); // gravity
    el.style.setProperty("--fr", `${(Math.random() * 900 - 450).toFixed(0)}deg`);
    el.style.setProperty("--fd", `${(1500 + Math.random() * 1400).toFixed(0)}ms`);
    el.style.setProperty("--fdel", `${(4700 + Math.random() * 420).toFixed(0)}ms`);
    el.style.setProperty("--fc", Math.random() < 0.55 ? "var(--flare)" : "var(--peak)");
    flecks.appendChild(el);
  }
}

// The flare is the member's own profile colour. Pine on the dark paper is the
// one pairing that vanishes (#0B3B34 on #081F1B), so in dark it lifts to teal.
function celebrationFlare() {
  const col = state.me ? avatarParts(state.me.avatar).color : null;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (!col) return null;
  return dark && col === AVATAR_COLORS.pine ? AVATAR_COLORS.teal : col;
}

function showNextCelebration() {
  const entry = celebrateQueue.shift();
  if (entry === undefined) { celebrateShowing = false; return; }
  celebrateShowing = true;
  const overlay = $("celebrate-overlay");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("celebrate-line").textContent = entry.line;
  $("celebrate-sub").textContent = entry.sub || "";
  overlay.querySelector(".cel-title").classList.toggle("long", entry.line.length > 20);
  const flare = celebrationFlare();
  if (flare) overlay.style.setProperty("--flare", flare);
  else overlay.style.removeProperty("--flare");
  // fit the prototype's frame to the screen, bottom-anchored
  overlay.style.setProperty("--cel-s",
    Math.min(window.innerWidth / CEL_STAGE_W, window.innerHeight / CEL_STAGE_H).toFixed(3));
  if (!reduced) buildCelebrationDebris();
  overlay.classList.remove("playing", "reduced", "leaving", "hidden");
  void overlay.offsetWidth;   // restart every animation from frame zero
  overlay.classList.add(reduced ? "reduced" : "playing");
  hapticTick(reduced ? 12 : 16);
  clearCelebrationTimers();
  if (reduced) {
    celebrateTimers.push(setTimeout(dismissCelebration, CEL_REDUCED_MS));
  } else {
    celebrateTimers.push(
      setTimeout(() => hapticTick(28), CEL_BURST_MS),
      setTimeout(() => overlay.classList.add("leaving"), CEL_LEAVE_MS),
      setTimeout(dismissCelebration, CEL_LEAVE_MS + CEL_FADE_MS),
    );
  }
  // a tap still ends it early — ten seconds must never trap anyone
  overlay.addEventListener("click", dismissCelebration, { once: true });
}

function clearCelebrationTimers() {
  celebrateTimers.forEach(clearTimeout);
  celebrateTimers = [];
}

// Confetti removed 2026-08-11 (owner: the old celebration is not right for
// this app any more). It threw lime #C7F464 and gold #F2C51D cut-paper — two
// colours that are not in the title-screen palette at all. The flecks in the
// take above are the member's colour and paper only.

function dismissCelebration() {
  clearCelebrationTimers();
  const overlay = $("celebrate-overlay");
  overlay.removeEventListener("click", dismissCelebration);
  overlay.classList.add("hidden");
  overlay.classList.remove("playing", "reduced", "leaving");
  // small gap before the next one so back-to-back moments don't feel like a glitch
  setTimeout(showNextCelebration, 250);
}

// Called with the tally BEFORE the mutation that just landed, from both commit
// paths. One commit, one celebration: decideCelebrations (logic.js) collapses a
// target crossing and a streak milestone on the same commit into the streak,
// so nobody sits through the ten-second take twice back to back.
//
// The target fires ALWAYS, not once a day (owner, 2026-09-11) — safe because it
// fires on the CROSSING, not on being met: once you are over the line, adding
// more reps does not cross it again. Winding a set back below and finishing
// again is a genuine second finish, and it gets its moment.
function maybeCelebrate(beforeTally, repsAdded) {
  const target = targetFor(today(), state.settings);
  const streakDays = streak({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, today: today(), settings: state.settings });
  const targetEntry = () => ({ kind: "target", line: pickAffirmation(), sub: `Target met \u00b7 ${target}` });
  for (const c of decideCelebrations({ beforeTally, repsAdded, target, streakDays })) {
    if (c.kind === "streak") {
      const played = queueCelebrationOnce("streak", String(c.days),
        { kind: "streak", line: streakCelebrateLine(c.days), sub: `${c.days}-day streak` });
      // the milestone is one-shot; if it already played, a real target
      // crossing on the same commit still deserves its own moment
      if (!played && c.alsoTarget) queueCelebration(targetEntry());
    } else {
      queueCelebration(targetEntry());
    }
  }
}

// ---------- what counts as one ----------
// A crew on the honour system needs ONE definition of a rep, or two people are
// counting different things and the ranking is fiction. Reference material, so
// it sits quietly under the log actions and opens over the top.
const formSheet = () => $("form-sheet");
function openFormSheet() {
  formSheet().classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeFormSheet() {
  formSheet().classList.add("hidden");
  document.body.style.overflow = "";
}
$("form-link").addEventListener("click", openFormSheet);
$("form-close").addEventListener("click", closeFormSheet);

// The storyboard is a wide strip on a tall phone, so "full screen" means
// turning it: the CSS rotates it in portrait. Tap anywhere to come back.
function openFormZoom() {
  const zoom = $("form-zoom");
  zoom.classList.remove("hidden");
  // On a phone, fitting the whole board on screen leaves it small and banded by
  // empty board top and bottom, so it opens FILLED — scaled to the screen's
  // height, panned sideways — and a tap steps back to the whole thing. A screen
  // wide enough to fit it properly opens fitted, where nothing is gained by
  // filling.
  const portrait = window.innerWidth / window.innerHeight < 0.9;
  setFormZoomFill(portrait);
  if (portrait) zoom.scrollLeft = (zoom.scrollWidth - zoom.clientWidth) / 2;
}
function setFormZoomFill(fill) {
  $("form-zoom").classList.toggle("filled", fill);
  $("form-zoom-hint").textContent = fill ? "Tap to fit · ✕ to close" : "Tap to fill · ✕ to close";
}
function closeFormZoom() { $("form-zoom").classList.add("hidden"); }
$("form-photo").addEventListener("click", openFormZoom);
// tapping the board toggles fit/fill; the ✕ is the way out, so a stray tap
// while reading never throws you back to the rules
$("form-zoom").addEventListener("click", (e) => {
  if (e.target.id === "form-zoom-close") return closeFormZoom();
  setFormZoomFill(!$("form-zoom").classList.contains("filled"));
});

// Escape closes the top layer first — the zoom, then the sheet.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("form-zoom").classList.contains("hidden")) return closeFormZoom();
  if (!formSheet().classList.contains("hidden")) closeFormSheet();
});

// ---------- onboarding ----------

let obCrew = null, obAvatar = "pumper", obColor = "teal";
const AVATARS = ["pumper", "flex", "grit", "beast", "bolt", "spring", "zen", "bell", "flame", "star", "peak", "runner", "crown", "wave", "rocket", "paw", "robot", "coffee", "controller", "headphones"];

// invite deep-link: ?code=XYZ prefills the crew code for the invited friend
const inviteCode = () => new URLSearchParams(location.search).get("code");

// Solo mode isn't a degraded shared mode — it's a different product, and the
// onboarding has to say so. When makeAdapter() falls back to LocalAdapter
// (no config.js, or Supabase unreachable) every crew code entered can only
// ever miss, and the miss panel's only forward path is "New crew" — which is
// how an invited friend ends up alone in an empty crew thinking they joined.
// So in solo mode the code field is not shown at all, and any ?code= link is
// answered honestly instead of being silently swallowed.
function applyMode(code) {
  const shared = !!state.adapter.shared;
  $("ob-code-entry").classList.toggle("hidden", !shared);
  $("ob-solo").classList.toggle("hidden", shared);
  // sharing an invite that nobody can act on is the same failure from the
  // other end — don't offer it until there's a database behind the code.
  $("share-btn").classList.toggle("hidden", !shared);
  // a code nobody can act on is worse than no code at all — same reasoning as
  // the share button above
  $("crew-invite-code").classList.toggle("hidden", !shared);
  if (!shared) {
    $("crew-invite-title").textContent = "Crews are offline";
    $("crew-invite-body").textContent =
      "Invites are switched off until the crew database is back — a code shared now couldn't be opened by anyone. Keep banking; your history is safe on this phone.";
  }
  if (!shared && code) {
    $("ob-solo").querySelector(".ob-notfound-msg").textContent =
      "That invite can't be opened yet.";
  }
  if (shared && code) $("crew-code").value = code.toUpperCase();
}

$("ob-solo-btn").addEventListener("click", async () => {
  try {
    const crew = await state.adapter.createCrew({ ...DEFAULT_SETTINGS, challenge_start: nextMonday() });
    await enterCrew(crew);
  } catch (e) { obErr("Couldn't start. Try again."); console.error(e); }
});

// Every "start a crew" path funnels through here so the founder is shown the
// generated code and offered a crew name exactly once. Shared by the openly
// offered "No code?" button and the not-found panel's "New crew", which
// previously both dropped straight into naming yourself with the code never
// shown at all.
async function startNewCrew() {
  const crew = await state.adapter.createCrew({ ...DEFAULT_SETTINGS, challenge_start: nextMonday() });
  hideCodeNotFound();
  obErr("");
  obCrew = crew;
  $("ob-newcrew-code").textContent = crew.crew_code;
  $("ob-crewname").value = "";
  $("ob-step-code").classList.add("hidden");
  $("ob-step-newcrew").classList.remove("hidden");
}

$("ob-newcrew-go").addEventListener("click", async () => {
  const name = $("ob-crewname").value.trim();
  try {
    // Empty is a legitimate answer: the placeholder shows the schema default,
    // so skipping the field leaves the crew called The Climb rather than "".
    if (name && name !== obCrew.name) {
      await state.adapter.saveSettings(obCrew.id, obCrew.settings, name);
      obCrew = { ...obCrew, name };
    }
  } catch (e) { console.error(e); }   // a name is not worth blocking entry over
  $("ob-step-newcrew").classList.add("hidden");
  await enterCrew(obCrew);
});

// "No code? Start a crew" — the openly-offered version of what the not-found
// panel's "New crew" does, for someone who never had a code to type. A new
// crew still gets a freshly GENERATED code either way; this adds a way in,
// not a way to choose your own string.
$("ob-no-code").addEventListener("click", async () => {
  try { await startNewCrew(); }
  catch (e) { obErr("Couldn't reach the crew database. Try again."); console.error(e); }
});

// crew-code entry: a failed lookup must NEVER be reachable by tapping the same
// button twice — that's how a typo silently forked someone into an empty crew
// (council finding, 2026-07-23). A miss shows a distinct "not found" panel with
// two deliberate, equally-weighted paths: fix the typo (input stays focused/
// editable) or explicitly start a new crew under that code. Enter never
// relabels itself into a create action.
// What people actually paste is the whole invite — "…/rope-and-rung/?code=ABCD2345"
// or the entire message it arrived in. The field is maxlength=8, so a paste
// like that used to be truncated to "HTTPS://" before anything could read it:
// the friend then saw "crew codes are given out, not made up" while holding a
// perfectly good invite. Pull the code out of whatever landed.
function codeFromPaste(raw) {
  const text = String(raw || "").trim();
  const inLink = text.match(/[?&]code=([^&\s]+)/i);
  if (inLink) {
    const c = decodeURIComponent(inLink[1]).toUpperCase();
    if (looksLikeCode(c)) return c;
  }
  // a code read off a screenshot often arrives spaced or hyphenated
  const bare = text.toUpperCase().replace(/[\s-]/g, "");
  if (looksLikeCode(bare)) return bare;
  return null;
}

$("crew-code").addEventListener("paste", (e) => {
  const pasted = e.clipboardData?.getData("text");
  const code = codeFromPaste(pasted);
  if (!code) return;                 // nothing we recognise — let the browser paste it
  e.preventDefault();
  $("crew-code").value = code;
  hideCodeNotFound();
  obErr("");
});

$("ob-code-btn").addEventListener("click", async () => {
  const code = $("crew-code").value.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return obErr(`A crew code is exactly ${CODE_LENGTH} characters. Entering someone's? Check you've got all of it. No code of your own? Start a crew below.`);
  // I, O, 0 and 1 are deliberately absent from every real code, so one turning
  // up is a misread off a screenshot, not a crew that doesn't exist — say so
  // rather than sending them down the "no crew found" path for a typo.
  //
  // Both messages LEAD with where a code comes from. The old pair opened on
  // the I/J/O/Q substitution table, which only makes sense if you already know
  // you're copying an issued code — and the person most likely to be reading
  // it is the one who just invented a code, for whom a spelling hint explains
  // nothing (owner, having typed "monday26": "the instruction is a little
  // confusing"). The transcription hint is still there, demoted to the end
  // where it serves the case it was written for.
  if (!looksLikeCode(code)) return obErr("Crew codes are given out, not made up — get yours from whoever started the crew, or start your own below. (Copying one down? A code never contains I, O, 0 or 1.)");
  hideCodeNotFound();
  try {
    const crew = await state.adapter.findCrew(code);
    if (!crew) return showCodeNotFound(code);
    obErr("");
    await enterCrew(crew);
  } catch (e) { obErr("Couldn't reach the crew database. Try again."); console.error(e); }
});

function showCodeNotFound(code) {
  $("ob-notfound-code").textContent = code;
  $("ob-code-notfound").classList.remove("hidden");
  obErr("");
  $("crew-code").focus();
}
function hideCodeNotFound() {
  $("ob-code-notfound").classList.add("hidden");
}
// editing the code implicitly means "let me fix it" — clear the confirmation panel
$("crew-code").addEventListener("input", hideCodeNotFound);

$("ob-notfound-fix").addEventListener("click", () => {
  hideCodeNotFound();
  $("crew-code").focus();
  $("crew-code").select();
});

// deliberately does NOT reuse the code that just missed — a new crew gets a
// freshly generated one. Reusing it is how a mistyped code turned into a
// stranger's crew the moment two people ever picked the same string.
$("ob-notfound-create").addEventListener("click", async () => {
  try { await startNewCrew(); }
  catch (e) { obErr("Couldn't reach the crew database. Try again."); console.error(e); }
});

async function enterCrew(crew) {
  obCrew = crew;
  $("ob-step-code").classList.add("hidden");
  $("ob-step-profile").classList.remove("hidden");
  $("ob-step-profile").classList.add("ob-step-in");
  const existing = await state.adapter.listProfiles(crew.id);
  $("ob-existing").innerHTML = existing.map((p) =>
    `<button data-id="${p.id}">${avatarChip(p.avatar)}${esc(p.name)}</button>`).join("");
  // One mis-tap here files pushups into someone else's account for good — the
  // only unrecoverable data error in the app — so confirm identity before
  // adopting an existing profile instead of switching on first tap.
  $("ob-existing").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", async () => {
      const p = existing.find((p) => p.id === b.dataset.id);
      if (!p) return;
      if (!(await confirmSheet(`Continue as ${p.name}? You'll be logging pushups to their tally, not starting a new profile.`, { confirmLabel: "Continue as them", cancelLabel: "Cancel" }))) return;
      finishOnboarding(p);
    }));
  $("ob-avatars").innerHTML = AVATARS.map((a) => `<button data-a="${a}" ${a === obAvatar ? 'class="sel"' : ""} aria-label="${a}">${avatarHTML(a)}</button>`).join("");
  $("ob-avatars").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      obAvatar = b.dataset.a;
      $("ob-avatars").querySelectorAll("button").forEach((x) => {
        x.classList.toggle("sel", x === b);
        x.style.background = x === b ? AVATAR_COLORS[obColor] : "";
      });
    }));
  $("ob-colors").innerHTML = Object.entries(AVATAR_COLORS).map(([k, v]) =>
    `<button data-c="${k}" ${k === obColor ? 'class="sel"' : ""} style="background:${v}" aria-label="${k}"></button>`).join("");
  $("ob-colors").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      obColor = b.dataset.c;
      $("ob-colors").querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === b));
      const sel = $("ob-avatars").querySelector("button.sel");
      if (sel) sel.style.background = AVATAR_COLORS[obColor];
    }));
}

$("ob-create-btn").addEventListener("click", async () => {
  const name = $("ob-name").value.trim();
  if (!name) return obErr("Give us a name.");
  const p = await state.adapter.createProfile(obCrew.id, name, `${obAvatar}.${obColor}`);
  finishOnboarding(p);
});

async function finishOnboarding(profile) {
  session.save({ crewId: obCrew.id, profileId: profile.id, crewCode: obCrew.crew_code });
  await loadCrew(obCrew.id, profile.id);
  showApp();
}

function obErr(msg) {
  $("ob-code-err").textContent = msg;
  $("ob-code-err").classList.toggle("hidden", !msg);
}
function nextMonday() {
  let d = today();
  while (parseDay(d).getDay() !== 1) d = addDays(d, 1);
  return d;
}

// ---------- dial ----------

const dial = $("dial");
let dragging = false, lastAngle = 0;

// first-run dial hint: shown until the first successful crank (or a manual
// dismiss), then never again — flag persists in localStorage.
const DIAL_HINT_SEEN_KEY = "pushpact-dial-hint-seen";
const dialHintSeen = () => !!localStorage.getItem(DIAL_HINT_SEEN_KEY);
function markDialHintSeen() {
  localStorage.setItem(DIAL_HINT_SEEN_KEY, "1");
  $("dial-hint").classList.add("hidden");
  $("dial-hint-note").classList.add("hidden");
}
function maybeShowDialHint() {
  if (dialHintSeen()) return;
  $("dial-hint").classList.remove("hidden");
  $("dial-hint-note").classList.remove("hidden");
}
$("dial-hint-dismiss").addEventListener("click", (e) => { e.stopPropagation(); markDialHintSeen(); });

function angleOf(e) {
  const r = dial.getBoundingClientRect();
  const x = e.clientX - (r.left + r.width / 2);
  const y = e.clientY - (r.top + r.height / 2);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

dial.addEventListener("pointerdown", (e) => {
  dragging = true; lastAngle = angleOf(e);
  dial.classList.add("dragging");
  dial.setPointerCapture(e.pointerId);
});
// Safari can ignore touch-action:none mid-fast-crank and scroll the page;
// a non-passive preventDefault is the only reliable stop.
dial.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

// fast cranks fire pointermove faster than paint — coalesce renders to one per frame
let dialRaf = 0;
function scheduleDialRender() {
  if (dialRaf) return;
  dialRaf = requestAnimationFrame(() => { dialRaf = 0; renderDial(); });
}

dial.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const a = angleOf(e);
  let d = a - lastAngle;
  if (d > 180) d -= 360; if (d < -180) d += 360;
  lastAngle = a;
  const before = state.compose;
  const tally = myTallyToday();
  state.rotation = Math.max((-tally) * DEG_PER_REP, Math.min(MAX_SET * DEG_PER_REP, state.rotation + d));
  state.compose = Math.round(state.rotation / DEG_PER_REP);
  if (state.compose !== before) {
    // tiered haptics: tick per rep, firmer at fives, a thunk on each completed lap
    const c = Math.abs(state.compose);
    hapticTick(c && c % REPS_PER_REV === 0 ? 26 : c % 5 === 0 ? 9 : 3);
    if (crossedRev(before, state.compose)) lapDischarge();
    if (!dialHintSeen()) markDialHintSeen(); // first successful crank teaches itself
    scheduleDialRender();
  }
});

// council (Expansionist): the wind-up deserves a release — volt discharge on each full revolution
function crossedRev(before, after) {
  return after > 0 && Math.floor(after / REPS_PER_REV) > Math.floor(Math.max(0, before) / REPS_PER_REV);
}
function lapDischarge() {
  dial.classList.add("discharge");
  setTimeout(() => dial.classList.remove("discharge"), 600);
}
["pointerup", "pointercancel"].forEach((ev) =>
  dial.addEventListener(ev, () => { dragging = false; dial.classList.remove("dragging"); }));

// quick-add chips: accessible, obvious alternative to cranking (council fix).
// Unified contract (2026-07-23): chips commit INSTANTLY everywhere, same as
// Home's — homeQuickAdd (below) already does exactly this for state.me/today(),
// so Today's chips just call it directly. The dial keeps the only staged,
// crank-then-Bank flow left in the app.
document.querySelectorAll(".qchip").forEach((b) =>
  b.addEventListener("click", () => homeQuickAdd(parseInt(b.dataset.add, 10), b)));

$("bank-btn").addEventListener("click", async () => {
  const btn = $("bank-btn");
  if (btn.disabled) return; // a commit is already in flight — ignore the re-tap
  const reps = state.compose;
  if (!reps) return;
  if (reps < 0 && !(await confirmSheet(`Wind ${-reps} back off today's tally?`, { confirmLabel: "Wind it back", cancelLabel: "Leave it" }))) return;
  // lock immediately (synchronously, before the await below) so a fast
  // double-tap can't slip a second commit in with a stale `before`;
  // renderDial() re-derives the "real" disabled state (compose === 0) once
  // the commit lands, so there's no separate re-enable step needed here.
  btn.disabled = true;
  try {
    await serializeCommit(async () => {
      const before = myTallyToday();
      await state.adapter.addSet(state.me.id, today(), reps);
      state.compose = 0; state.rotation = 0;
      hapticTick(20);
      localStorage.setItem("pushpact-banks", String((parseInt(localStorage.getItem("pushpact-banks"), 10) || 0) + 1));
      await refetch();
      const target = targetFor(today(), state.settings);
      if (before < target && before + reps >= target) {
        dial.classList.add("smashed");
        setTimeout(() => dial.classList.remove("smashed"), 700);
      }
      maybeCelebrate(before, reps);
    });
  } finally {
    // if the commit threw (network/storage), compose is untouched and the
    // button would otherwise stay dead until the next render — re-derive.
    renderDial();
  }
});

function myTallyToday() { return dayTally(state.sets, state.me.id, today()); }

// ledger "thump" tracking (Wave 4): a stamp snaps in with a little scale/
// rotate settle only the moment its set is FIRST rendered on the ledger —
// never on every re-render (that would replay the animation on every tab
// switch/refetch). seenLedgerSetIds is seeded with whatever's already there
// the first time a given day is rendered, so opening Today never animates
// the whole ledger; only a genuinely new bank does.
let seenLedgerSetIds = new Set();
let seenLedgerDay = null;

// odometer-style count-up when the banked tally changes
let shownTally = null;
function animateTally(el, value) {
  // council (Expansionist): the odometer roll is reserved for big banks (≥10) —
  // a 5-rep top-up snapping in keeps the roll meaning something
  if (shownTally === null || shownTally === value || Math.abs(value - shownTally) < 10 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = value; shownTally = value; return;
  }
  const from = shownTally, delta = value - from;
  shownTally = value;
  const dur = Math.min(700, 220 + Math.abs(delta) * 14);
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min((t - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + delta * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderDial() {
  const tally = myTallyToday();
  const target = targetFor(today(), state.settings);
  const done = tally >= target;

  // MAIN RING = the set you're composing. One revolution = REPS_PER_REV (20);
  // keep circling for more (the ring simply stays full past one revolution).
  let ring, knobDeg;
  if (state.compose >= 0) {
    const rem = state.compose % REPS_PER_REV;
    const deg = (rem / REPS_PER_REV) * 360;
    knobDeg = deg;
    ring = (state.compose >= REPS_PER_REV)
      ? `conic-gradient(var(--accent) 0deg 360deg)`
      : `conic-gradient(var(--accent) 0deg ${deg}deg, var(--dial-ring) ${deg}deg 360deg)`;
  } else {
    const rem = Math.min(-state.compose, REPS_PER_REV);
    const deg = (rem / REPS_PER_REV) * 360;
    knobDeg = 360 - deg;
    ring = `conic-gradient(var(--dial-ring) 0deg ${360 - deg}deg, rgba(178,58,46,.5) ${360 - deg}deg 360deg)`;
  }
  $("dial-ring").style.background = ring;
  $("knob-arm").style.transform = `rotate(${knobDeg}deg)`;

  // THIN INNER RING = today's progress toward the full daily target.
  // Living gradient (council): the arc tip warms toward volt as the target nears.
  const progFrac = Math.min(tally / target, 1);
  const progDeg = progFrac * 360;
  let progFill;
  if (done) progFill = `var(--volt) 0deg ${progDeg}deg`;
  else if (progFrac >= 0.6)
    progFill = `var(--accent) 0deg ${progDeg * 0.55}deg, #5EA86B ${progDeg * 0.8}deg, var(--volt) ${progDeg}deg`;
  else progFill = `var(--accent) 0deg ${progDeg}deg`;
  $("progress-ring").style.background =
    `conic-gradient(${progFill}, rgba(var(--texture-rgb),.08) ${progDeg}deg 360deg)`;
  const c = $("compose");
  c.textContent = state.compose
    ? `${state.compose > 0 ? "+" : ""}${state.compose}`
    : " ";
  c.classList.toggle("neg", state.compose < 0);
  const t = $("tally");
  animateTally(t, tally);
  t.classList.toggle("met", done);
  $("target-text").textContent = `target ${target}`;
  $("togo-text").textContent = done ? "smashed" : `${target - tally} to go`;
  const bank = $("bank-btn");
  bank.disabled = !state.compose;
  bank.classList.toggle("reverse", state.compose < 0);
  // one string, two consumers: the visible caption and the accessible name are
  // the same words, so they cannot drift apart as the copy changes
  const bankLabel = state.compose
    ? (state.compose > 0 ? `Bank ${state.compose} pushups` : `Remove ${-state.compose} pushups`)
    : "Crank the dial to bank";
  $("bank-cap").textContent = bankLabel;
}

// ---------- today ----------

function renderToday() {
  renderDial();
  maybeShowDialHint();
  renderRope();
  const rows = state.sets
    .filter((s) => s.profile_id === state.me.id && s.day === today())
    .sort((a, b) => (a.logged_at < b.logged_at ? -1 : 1));
  if (seenLedgerDay !== today()) {
    // first render of a new day: mark whatever's already banked as "seen" so
    // it never thumps in on load — only a genuinely fresh bank animates
    seenLedgerDay = today();
    seenLedgerSetIds = new Set(rows.map((r) => r.id));
  }
  $("ledger-rows").innerHTML = rows.length
    ? rows.map((s) => {
        const isNew = !seenLedgerSetIds.has(s.id);
        seenLedgerSetIds.add(s.id);
        return `
      <div class="l-row" data-sid="${s.id}" title="Tap to remove this set">
        <div class="l-row-head">
          <span class="reps ${s.reps < 0 ? "neg" : ""}">${s.reps}</span>
          ${isLate(s) && !localStorage.getItem("pushpact-date-override") ? '<span class="late">late</span>' : ""}
          <span class="t">${fmtTime(s.logged_at)}</span>
        </div>
        <div class="stamps">${stamps(s.reps, isNew)}</div>
      </div>`;
      }).join("")
    : '<div class="l-empty">Nothing banked yet. The dial awaits.</div>';
  $("ledger-rows").querySelectorAll(".l-row[data-sid]").forEach((row) =>
    row.addEventListener("click", async () => {
      const s = rows.find((x) => x.id === row.dataset.sid);
      if (!s) return;
      if (!(await confirmSheet(`Tear this set of ${s.reps} out of today's ledger? Gone for good.`, { confirmLabel: "Tear it out", cancelLabel: "Leave it" }))) return;
      await state.adapter.removeSet(s.id);
      refetch();
    }));

  // mate's most recent excuse (today or yesterday) as a post-it
  const zone = $("mate-postit-zone");
  const mates = state.profiles.filter((p) => p.id !== state.me.id);
  let note = "";
  for (const m of mates) {
    const ex = state.statuses.find((st) => st.profile_id === m.id && st.kind === "excuse" &&
      (st.day === today() || st.day === addDays(today(), -1)));
    if (ex?.excuse_text) {
      note = `<div class="postit${postitAgeClass(ex.day)}"><small>${esc(m.name)} · ${ex.day === today() ? "today" : "yesterday"}</small>${esc(ex.excuse_text)}</div>`;
      break;
    }
  }
  zone.innerHTML = note;

  // rest button
  const restBtn = $("rest-btn");
  const restedToday = state.statuses.some((s) => s.profile_id === state.me.id && s.day === today() && s.kind === "rest");
  const check = canDeclareRest(state.statuses, state.me.id, today(), state.settings);
  if (restedToday) restBtn.textContent = "Resting today ✓ (tap to undo)";
  else if (check.ok) restBtn.textContent = `Rest day · ${check.remaining} left`;
  else restBtn.textContent = "No rest left this week — pushups or an excuse";
  restBtn.disabled = !restedToday && !check.ok;

  // excuse button
  const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, day: today(), today: today(), settings: state.settings });
  const excusedToday = state.statuses.find((s) => s.profile_id === state.me.id && s.day === today() && s.kind === "excuse");
  const eb = $("excuse-btn");
  eb.classList.toggle("hidden", st.state === "met" || restedToday);
  eb.textContent = excusedToday ? "Excused ✓ (tap to edit)" : "Write an excuse";
}

// Ink tally marks — groups of 4 verticals + a diagonal strike for the 5th,
// every 10th landing heavier (.ten). Full-width now (Wave 4 rebuild), wraps
// across lines rather than overflowing on a big day; glyph count is capped
// well below any real rep count so a 100+ rep single set still renders a
// legible tally, not a wall of ticks. `animate` (true only for a set that
// just landed, per the seen-set guard in renderToday) adds the "thump"
// snap-in class with a per-tick stagger so a multi-stamp bank cascades in.
function stamps(n, animate) {
  const count = Math.min(Math.abs(n), 50);
  let out = "";
  for (let i = 1; i <= count; i++) {
    const five = i % 5 === 0, ten = i % 10 === 0;
    const cls = ["stamp", five ? "five" : "", ten ? "ten" : "", animate ? "thump" : ""].filter(Boolean).join(" ");
    const delay = animate ? ` style="animation-delay:${Math.min(i, 20) * 18}ms"` : "";
    out += `<i class="${cls}"${delay}></i>`;
  }
  return out;
}
function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).toLowerCase() : "";
}

// Wave 4 (council reversal): an unaddressed excuse gets LOUDER with age, not
// quieter — replaces the old "curls a little more" decay. True read-tracking
// needs the shared DB; until then, age since posting stands in as the proxy.
function postitAgeClass(day) {
  const age = Math.min(3, Math.max(0, Math.round((parseDay(today()) - parseDay(day)) / 86400000)));
  return age ? ` aged-${age}` : "";
}

// best single day, computed from the sets already in memory — pure display
function personalBest(sets, pid) {
  const per = {};
  for (const s of sets) if (s.profile_id === pid) per[s.day] = (per[s.day] || 0) + s.reps;
  return Object.values(per).reduce((a, b) => Math.max(a, b), 0);
}

// Wave 4: the rope now scales with real streak length instead of flatlining
// at 6 — a 60-day streak used to render identically to a 7-day one. Inside
// the first week it's still one knot per day (unchanged, most-common case).
// Past that, one knot per COMPLETE week; every 4th week (28/56/84 days,
// matching the celebration milestones) lands heavier; a week still in
// progress is a light dashed "forming" knot; past WEEK_CAP complete weeks the
// rest condense into one "+N" chip so the rope stays compact and legible even
// at 100+ days. streak() itself always comes from logic.js — this only
// changes how many days it represents get drawn as knots.
const ROPE_WEEK_CAP = 8;
function renderRope() {
  const n = streak({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, today: today(), settings: state.settings });
  // council (loss aversion): the next knot visibly frays when today is still unmet
  // and a streak is on the line — more urgently in the evening.
  const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, day: today(), today: today(), settings: state.settings });
  const atRisk = n > 0 && st.state === "pending";
  const urgent = atRisk && new Date().getHours() >= 17;
  // council (Expansionist): the rope tells both stories — fraying when in danger,
  // hanging slack and easy once today is banked
  const safe = st.state === "met" || st.state === "rest";
  let knots = "";
  if (n <= 7) {
    for (let i = 0; i < n; i++) knots += `<span class="knot${i === n - 1 ? " volt" : ""}"></span>`;
  } else {
    const fullWeeks = Math.floor(n / 7);
    const intoWeek = n % 7;
    if (fullWeeks <= ROPE_WEEK_CAP) {
      for (let w = 1; w <= fullWeeks; w++) {
        const milestone = w % 4 === 0;
        const isLast = w === fullWeeks && intoWeek === 0;
        knots += `<span class="knot week${milestone ? " milestone" : ""}${isLast ? " volt" : ""}"></span>`;
      }
    } else {
      for (let w = 1; w < ROPE_WEEK_CAP; w++) {
        const milestone = w % 4 === 0;
        knots += `<span class="knot week${milestone ? " milestone" : ""}"></span>`;
      }
      const rem = fullWeeks - (ROPE_WEEK_CAP - 1);
      knots += `<span class="knot week overflow" title="${rem} more week${rem === 1 ? "" : "s"} banked">+${rem}</span>`;
    }
    if (intoWeek > 0) knots += `<span class="knot week partial volt"></span>`;
  }
  knots += safe
    ? '<span class="knot fray slack"></span>'
    : `<span class="knot fray${atRisk ? " at-risk" : ""}${urgent ? " urgent" : ""}"></span>`;
  $("rope-knots").innerHTML = knots;
  $("rope-count").textContent = `${n} day${n === 1 ? "" : "s"}`;
}

// ---------- rest / excuse ----------

$("rest-btn").addEventListener("click", async () => {
  const restedToday = state.statuses.some((s) => s.profile_id === state.me.id && s.day === today() && s.kind === "rest");
  if (restedToday) {
    await state.adapter.removeStatus(state.me.id, today(), "rest");
  } else {
    const check = canDeclareRest(state.statuses, state.me.id, today(), state.settings);
    if (!check.ok) return;
    await state.adapter.addStatus({ profile_id: state.me.id, day: today(), kind: "rest", excuse_text: null });
  }
  refetch();
});

$("excuse-btn").addEventListener("click", () => openExcuse(today()));
$("excuse-cancel").addEventListener("click", () => $("excuse-modal").classList.add("hidden"));

$("excuse-save").addEventListener("click", async () => {
  const text = $("excuse-text").value.trim();
  if (!text) return;
  hapticTick(12);
  await state.adapter.removeStatus(state.me.id, state.excuseDay, "excuse");
  await state.adapter.addStatus({ profile_id: state.me.id, day: state.excuseDay, kind: "excuse", excuse_text: text });
  $("excuse-text").value = "";
  $("excuse-modal").classList.add("hidden");
  refetch();
});

function openExcuse(day) {
  state.excuseDay = day;
  const existing = state.statuses.find((s) => s.profile_id === state.me.id && s.day === day && s.kind === "excuse");
  $("excuse-text").value = existing?.excuse_text ?? "";
  $("excuse-delete").classList.toggle("hidden", !existing);
  $("excuse-modal").classList.remove("hidden");
  $("excuse-text").focus();
}
$("excuse-delete").addEventListener("click", async () => {
  await state.adapter.removeStatus(state.me.id, state.excuseDay, "excuse");
  $("excuse-modal").classList.add("hidden");
  refetch();
});

// ---------- crew ----------

// Wave 4 rebuild: Crew as a corkboard/fridge-door — avatars 2-3x the old
// 38px are now the dominant visual per card, the day-state colour rings the
// avatar (plus the existing text chip, so it's never colour-only), and any
// excuse renders as a real pinned post-it at legible Caveat scale instead of
// a 150px box tucked in the corner. Everything the old flat list showed is
// still here: name/you-tag, streak+all-time+PB, today's tally, the 7-day
// strip, data-pid — just laid out for the avatar to lead.
function renderCrew() {
  // The crew's name, read-only. Hidden entirely in solo mode, where there is
  // no shared crew for a name to belong to. textContent, never innerHTML —
  // this string is typed by a person and comes back off the wire.
  const plate = $("crew-name-plate");
  const crewName = state.adapter.shared && state.crew ? (state.crew.name || "").trim() : "";
  plate.textContent = crewName;
  plate.classList.toggle("hidden", !crewName);

  // Crew/Home merge: the corkboard shows everyone EXCEPT you. #home-mycard
  // sits directly above it and already shows your own day in more detail, so
  // leaving you in the map put the same person on one screen twice. Same
  // `mates` filter renderLedger() already uses for the mate post-it zone.
  const mates = state.profiles.filter((p) => p.id !== state.me.id);
  const cards = mates.map((p) => {
    const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: p.id, day: today(), today: today(), settings: state.settings });
    const days = [...Array(7)].map((_, i) => addDays(today(), i - 6));
    const strip = days.map((d) => {
      const s = dayState({ sets: state.sets, statuses: state.statuses, profileId: p.id, day: d, today: today(), settings: state.settings });
      return `<span class="cell bg-${s.state}" title="${d}"></span>`;
    }).join("");
    const total = allTimeTotal(state.sets, p.id);
    const stk = streak({ sets: state.sets, statuses: state.statuses, profileId: p.id, today: today(), settings: state.settings });
    const pb = personalBest(state.sets, p.id);
    const ex = state.statuses.find((s) => s.profile_id === p.id && s.kind === "excuse" &&
      (s.day === today() || s.day === addDays(today(), -1)));
    return `
      <div class="crew-card" data-pid="${p.id}">
        <div class="cc-top">
          ${avatarChip(wornAvatar(p), `cc-avatar st-${st.state}${isWearingAward(p) ? " is-ach" : ""}`)}
          <div class="cc-info">
            <div class="cc-name-row">
              <span class="nm">${esc(p.name)}${p.id === state.me.id ? " (you)" : ""}</span>
              <span class="state-chip bg-${st.state}">${stateLabel(st)}</span>
            </div>
            <div class="big"><span class="n">${st.tally}</span><span class="of">of ${st.target} today</span></div>
            <div class="sub">${stk} day streak · ${total.toLocaleString()} all-time${pb > 0 ? ` <span class="pb-badge">PB ${pb}</span>` : ""}</div>
          </div>
        </div>
        <div class="strip">${strip}</div>
        ${ex?.excuse_text ? `<div class="cc-postit"><div class="postit${postitAgeClass(ex.day)}"><small>${ex.day === today() ? "today" : "yesterday"}</small>${esc(ex.excuse_text)}</div></div>` : ""}
      </div>`;
  }).join("");
  // Filtering yourself out means solo mode has nobody left to draw, and a
  // corkboard rendering empty under its own title reads as broken rather than
  // as solo. Adapted from the retired Home-screen line — "from the Crew tab"
  // is dropped because this IS the crew tab now, and the invite card it points
  // at is the next block down.
  if (state.crew && state.adapter.shared) {
    $("crew-invite-code-text").textContent = state.crew.crew_code;
    setInstallHintCode(state.crew.crew_code);
  }
  $("crew-cards").innerHTML = cards ||
    '<div class="l-empty">Flying solo for now — that counts too. Invite a friend below.</div>';
}

function inviteLink() {
  return `${location.origin}${location.pathname}?code=${encodeURIComponent(state.crew.crew_code)}`;
}

// `url` as its own field, not a link buried in `text`. Messages, WhatsApp and
// Mail all build a tappable preview from `url` and most of them will not hunt
// for a link inside a sentence — the old single-string version arrived as grey
// text you had to copy out by hand.
$("share-btn").addEventListener("click", async () => {
  const link = inviteLink();
  const payload = {
    title: "Rope & Rung",
    text: `Daily pushups, no hiding. Crew code ${state.crew.crew_code} — the link fills it in for you.`,
    url: link,
  };
  if (navigator.share) {
    try { await navigator.share(payload); return; } catch (e) { if (e?.name === "AbortError") return; }
  }
  await copyToClipboard(`${payload.text} ${link}`);
  flash($("share-btn"), "Copied!", "Share invite");
});

// The code on its own, for saying out loud or pasting into a group chat.
$("crew-invite-code").addEventListener("click", async () => {
  if (!state.crew) return;
  await copyToClipboard(state.crew.crew_code);
  const chip = $("crew-invite-code-text");
  flash(chip, "Copied!", state.crew.crew_code);
});

function flash(el, msg, back) {
  const was = el.textContent;
  el.textContent = msg;
  setTimeout(() => { el.textContent = back ?? was; }, 1500);
}

// navigator.clipboard is undefined outside a secure context — which is exactly
// how a phone on the LAN reaches the dev server — and it rejects when the page
// is not focused. Fall back to the old execCommand path so "Copied!" is never
// a lie.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// ---------- history ----------

let lastHistView = null; // guards the calendar/ladder swap-in animation so it
                          // only plays when the view actually changed, not on
                          // every refetch/re-render of the same view.

function renderHistory() {
  if (!state.histMonth) state.histMonth = today().slice(0, 7);
  if (!state.histPerson) state.histPerson = state.me.id;
  $("hist-person").innerHTML = state.profiles.map((p) =>
    `<option value="${p.id}" ${p.id === state.histPerson ? "selected" : ""}>${AVATAR_ART[avatarParts(p.avatar).art] ? "" : esc(p.avatar) + " "}${esc(p.name)}</option>`).join("");
  const [y, m] = state.histMonth.split("-").map(Number);
  $("hist-month").textContent = new Date(y, m - 1, 1).toLocaleDateString("en-AU", { month: "long", year: "numeric" });
  const first = `${state.histMonth}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (parseDay(first).getDay() + 6) % 7;
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const day = `${state.histMonth}-${String(d).padStart(2, "0")}`;
    if (day > today()) { days.push({ d, day, future: true }); continue; }
    days.push({ d, day, st: dayState({ sets: state.sets, statuses: state.statuses, profileId: state.histPerson, day, today: today(), settings: state.settings }) });
  }
  // council (Expansionist): on a perfect month the dots join into a thin ink line.
  // Perfect = every elapsed day met or rested (today, still pending, doesn't count against).
  const judged = days.filter((x) => !x.future && !(x.day === today() && x.st.state === "pending"));
  const perfect = judged.length >= 7 && judged.every((x) => x.st.state === "met" || x.st.state === "rest");
  const lineEnd = judged.length ? judged[judged.length - 1].d : 0;
  let cells = ["M", "T", "W", "T", "F", "S", "S"].map((d) => `<span class="dow">${d}</span>`).join("");
  for (let i = 0; i < lead; i++) cells += '<span class="hist-cell blank"></span>';
  let cellIdx = 0; // stagger index for the tile-fall swap-in animation; must
                    // increment for both branches below so it never jumps.
  for (const x of days) {
    if (x.future) { cells += `<span class="hist-cell future" style="--i:${cellIdx++}"><span class="d">${x.d}</span></span>`; continue; }
    const rowEnd = (lead + x.d) % 7 === 0;
    const ink = x.d < lineEnd && !rowEnd ? " ink" : "";
    cells += `<span class="hist-cell${ink}" data-day="${x.day}" style="--i:${cellIdx++}"><span class="d">${x.d}</span><span class="st bg-${x.st.state}"></span></span>`;
  }
  $("hist-grid").classList.toggle("perfect", perfect);
  $("hist-grid").innerHTML = cells;
  $("hist-grid").querySelectorAll(".hist-cell[data-day]").forEach((c) =>
    c.addEventListener("click", () => { state.histSelected = c.dataset.day; renderHistDetail(); }));
  renderHistDetail();

  // Wave 5: calendar <-> ladder toggle. Appended at the tail of the existing
  // function rather than woven through it — the calendar's own rendering
  // above is untouched, this only decides which container is visible (and
  // builds the ladder when it's the active one).
  const hv = histView();
  $("hist-view-toggle").querySelectorAll(".hv-btn").forEach((b) => b.classList.toggle("on", b.dataset.view === hv));
  $("hist-view-toggle").classList.toggle("v-ladder", hv === "ladder");
  $("hist-nav").classList.toggle("hidden", hv !== "calendar");
  $("hist-calendar-view").classList.toggle("hidden", hv !== "calendar");
  $("hist-ladder-view").classList.toggle("hidden", hv !== "ladder");
  // Swap-in animation (tiles fall / rungs build) only plays when the view
  // actually changed — not on every refetch/re-render of the same view.
  // The class goes on the ancestor container before the content that needs
  // to animate is (re)built, so freshly-inserted children pick it up via
  // the `.hist-anim .hist-cell` / `.hist-anim .rung-row` descendant rules.
  const viewChanged = hv !== lastHistView;
  lastHistView = hv;
  $("hist-calendar-view").classList.toggle("hist-anim", viewChanged && hv === "calendar");
  $("hist-ladder-view").classList.toggle("hist-anim", viewChanged && hv === "ladder");
  if (hv === "ladder") renderLadder();
}

function renderHistDetail() {
  const el = $("hist-detail");
  if (!state.histSelected) { el.classList.add("hidden"); return; }
  const day = state.histSelected;
  const pid = state.histPerson;
  const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: pid, day, today: today(), settings: state.settings });
  const rows = state.sets.filter((s) => s.profile_id === pid && s.day === day)
    .map((s) => `${s.reps > 0 ? "+" : ""}${s.reps} at ${fmtTime(s.logged_at)}${isLate(s) && !localStorage.getItem("pushpact-date-override") ? " (late)" : ""}`).join("<br>") || "No sets logged.";
  const mine = pid === state.me.id;
  el.innerHTML = `
    <div class="dd">${parseDay(day).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })} — ${st.tally} of ${st.target} · ${st.state}</div>
    <div class="rows">${rows}</div>
    ${st.excuse ? `<div class="excuse-quote">“${esc(st.excuse)}”</div>` : ""}
    ${mine ? `<div class="hist-add">
        <input id="hist-reps" type="number" placeholder="+reps">
        <button id="hist-add-btn" class="btn btn-ghost">Log to this day</button>
        ${st.state === "missed" ? '<button id="hist-excuse-btn" class="btn btn-ghost">Excuse it</button>' : ""}
      </div>` : ""}`;
  el.classList.remove("hidden");
  if (mine) {
    $("hist-add-btn").addEventListener("click", async () => {
      const v = parseInt($("hist-reps").value, 10);
      if (!v) return;
      const tally = dayTally(state.sets, pid, day);
      if (tally + v < 0) return;
      await state.adapter.addSet(pid, day, v);
      await refetch();
    });
    $("hist-excuse-btn")?.addEventListener("click", () => openExcuse(day));
  }
}

$("hist-person").addEventListener("change", (e) => { state.histPerson = e.target.value; renderHistory(); });
$("hist-prev").addEventListener("click", () => { shiftMonth(-1); });
$("hist-next").addEventListener("click", () => { shiftMonth(1); });
function shiftMonth(n) {
  const [y, m] = state.histMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  state.histMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  state.histSelected = null;
  renderHistory();
}

// ---------- ladder view (Wave 5) ----------
// The "Rung" half of the brand made literal: one horizontal rung per week of
// the challenge, week 1 at the bottom, climbing up through the current
// (volt) week to a few pending rungs ahead. Toggled alongside the existing
// calendar; choice persists in localStorage. All math (targets, day states)
// comes from logic.js — this only decides how to draw it.
const HIST_VIEW_KEY = "pushpact-hist-view";
function histView() {
  return localStorage.getItem(HIST_VIEW_KEY) === "ladder" ? "ladder" : "calendar";
}
$("hist-view-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".hv-btn");
  if (!btn) return;
  localStorage.setItem(HIST_VIEW_KEY, btn.dataset.view);
  renderHistory();
});

const LADDER_UPCOMING = 3;   // small number of pending rungs shown above "now"
const LADDER_MIN_WEEKS = 4;  // floor so a brand-new/pre-start crew still sees a ladder

function weekStartOfWeekNum(n) {
  return addDays(state.settings.challenge_start, 7 * (n - 1));
}
// deterministic pseudo-random hand-made wobble (no Math.random — must not
// reshuffle on every re-render), same trick used to jitter noisy textures elsewhere
function rungJitter(n) {
  const h = Math.sin(n * 12.9898) * 43758.5453;
  return ((h - Math.floor(h)) - 0.5) * 1.4; // ~ -0.7deg .. 0.7deg
}

let ladderScrolledFor = null; // guards the one-time auto-scroll-to-current below
function renderLadder() {
  const settings = state.settings;
  const start = settings.challenge_start;
  const t = today();
  const daysSince = daysBetween(start, t);
  // pre-start (challenge hasn't begun): no "current" week yet, but the ladder
  // ahead still renders — every week below falls into the "future" branch.
  const currentWeekNum = daysSince < 0 ? 0 : Math.floor(daysSince / 7) + 1;
  const totalWeeks = Math.max(currentWeekNum + LADDER_UPCOMING, LADDER_MIN_WEEKS);
  const pid = state.histPerson;
  const lo = settings.target_start, hi = Math.max(settings.target_cap, lo + 1);

  let rowsHTML = "";
  for (let w = totalWeeks; w >= 1; w--) {
    const wkStart = weekStartOfWeekNum(w);
    const wkEnd = addDays(wkStart, 6);
    const target = targetFor(wkStart, settings);
    const atCap = settings.target_step > 0 && target >= settings.target_cap;
    const capStart = atCap && (w === 1 || targetFor(weekStartOfWeekNum(w - 1), settings) < settings.target_cap);

    let cls = "future";
    if (wkEnd < t) cls = "past";
    else if (wkStart <= t && t <= wkEnd) cls = "current";

    const frac = Math.min(1, Math.max(0, (target - lo) / (hi - lo)));
    const thickness = Math.round(4 + frac * 10);     // "heavier target, heavier rung"
    const fontSize = Math.round(13 + frac * 6);

    // 7 small notches, one per day of the week — same day-state read the
    // calendar uses (met/rest/excused/missed/pending); future days inside the
    // current week, and every day of a future week, come back "pending" from
    // dayState itself, so no separate future-day branch is needed here.
    let ticks = "";
    for (let i = 0; i < 7; i++) {
      const day = addDays(wkStart, i);
      const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: pid, day, today: t, settings });
      ticks += `<i class="rt bg-${st.state}" title="${day}: ${st.state}"></i>`;
    }

    // Stagger index is reversed relative to emission order: rows are built
    // highest week first (top of the DOM, idx 0) down to week 1 last (bottom,
    // idx totalWeeks-1). Reversed = (totalWeeks-1) - idx = w-1, so the
    // bottom-most (week 1) row gets --i:0 and animates first, climbing up.
    const rungAnimIdx = w - 1;
    rowsHTML += `
      <div class="rung-row ${cls}${capStart ? " cap-start" : ""}" data-week="${w}" style="--i:${rungAnimIdx}">
        <span class="rung-wk">Wk ${w}</span>
        <span class="rung-zone">
          <span class="rung-ticks">${ticks}</span>
          <span class="rung-bar" style="height:${thickness}px;transform:rotate(${rungJitter(w).toFixed(2)}deg)"></span>
          ${capStart ? '<span class="rung-cap-tag">cap</span>' : ""}
        </span>
        <span class="rung-target" style="font-size:${fontSize}px">${target}</span>
      </div>`;
  }
  $("ladder-rungs").innerHTML = rowsHTML;

  // Scroll the current (or, pre-start, the nearest) rung into view — but only
  // the first time this person's ladder renders, never fighting a user who's
  // mid-scroll on a later background refetch.
  const scroller = $("ladder-scroll");
  if (ladderScrolledFor !== pid) {
    ladderScrolledFor = pid;
    const focus = $("ladder-rungs").querySelector(".rung-row.current") || $("ladder-rungs").querySelector(".rung-row");
    if (focus && scroller) {
      scroller.scrollTop = Math.max(0, focus.offsetTop - scroller.clientHeight / 2 + focus.clientHeight / 2);
    }
  }
}

// ---------- settings ----------

// profile-picker state — reset from state.me's actual saved values every
// time Settings renders, so reopening the screen never shows a stale pick
// left over from a previous unsaved edit
let setAvatar = "pumper", setColor = "teal";

function renderSettings() {
  $("set-start").value = state.settings.target_start;
  $("set-step").value = state.settings.target_step;
  $("set-cap").value = state.settings.target_cap;
  $("set-rest").value = state.settings.rest_days_per_week;
  $("set-startdate").value = state.settings.challenge_start;
  // Both are filled every time: the hidden input keeps the name alive across a
  // member's settings save (see the markup note), the text line is what a
  // non-admin actually reads.
  $("set-crewname").value = state.crew.name ?? "";
  $("set-crewname-text").textContent = state.crew.name || "The Climb";
  // in solo mode the code is a local placeholder nobody can join with — showing
  // it invites exactly the failed hand-off this guard exists to prevent.
  $("set-crewcode-row").classList.toggle("hidden", !state.adapter.shared);
  $("set-crewcode").textContent = state.crew.crew_code;
  $("set-sim-date").value = localStorage.getItem("pushpact-date-override") || "";

  $("set-name").value = state.me.name;
  const [curArt, curColor] = String(state.me.avatar || "pumper.teal").split(".");
  // guard against pre-SVG-era plain-emoji avatars (no ".colour" suffix) —
  // fall back to a valid pick rather than saving a malformed avatar string
  setAvatar = AVATARS.includes(curArt) ? curArt : "pumper";
  setColor = AVATAR_COLORS[curColor] ? curColor : "teal";
  renderProfilePicker();
}

function renderProfilePicker() {
  // Spec rule 6 — once unlocked, a mark joins your picker for good. Earned marks
  // are appended AFTER the standard set and flagged, so the picker doubles as
  // the only place you can see what you have collected: they are absent from
  // AVATARS by design, being worn rather than chosen.
  //
  // Mapped through achievementArt() because wardrobe() speaks in ENGINE keys and
  // the picker speaks in ART keys — `lastRung` has no entry in AVATAR_ART, its
  // mark is `spoon`. Marks with no art yet are simply not offered.
  //
  // THE SPOON IS EXCLUDED, deliberately. Rule 6 says an unlocked avatar can be
  // worn at will, but the wooden spoon is a consequence, not a trophy: the
  // shipped code already keeps it out of AVATARS so it "is impossible to pick on
  // purpose", and letting someone put it on by choice would defuse the one
  // achievement that is supposed to sting. The eagle stays pickable — that one
  // IS a trophy.
  const earned = [...new Set(wardrobe(myUnlocks)
    .filter((k) => k !== "lastRung")
    .map(achievementArt)
    .filter(Boolean))].filter((a) => !AVATARS.includes(a));
  $("set-avatars").innerHTML = AVATARS.concat(earned).map((a) => {
    const isEarned = earned.includes(a);
    const cls = [a === setAvatar ? "sel" : "", isEarned ? "is-earned" : ""].filter(Boolean).join(" ");
    const name = ACHIEVEMENT_BY_KEY[a]?.name ?? a;
    return `<button data-a="${a}" class="${cls}" aria-label="${esc(isEarned ? name + " — earned" : a)}"
       title="${isEarned ? esc(name) : ""}"
       style="${a === setAvatar ? `background:${AVATAR_COLORS[setColor]}` : ""}">${avatarHTML(a)}</button>`;
  }).join("");
  $("set-avatars").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { setAvatar = b.dataset.a; renderProfilePicker(); }));
  $("set-colors").innerHTML = Object.entries(AVATAR_COLORS).map(([k, v]) =>
    `<button data-c="${k}" ${k === setColor ? 'class="sel"' : ""} style="background:${v}" aria-label="${k}"></button>`).join("");
  $("set-colors").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { setColor = b.dataset.c; renderProfilePicker(); }));
}

$("set-profile-save").addEventListener("click", async () => {
  const name = $("set-name").value.trim();
  if (!name) { $("set-profile-msg").textContent = "Give us a name."; return; }
  await state.adapter.updateProfile(state.me.id, name, `${setAvatar}.${setColor}`);
  await refetch();
  $("set-profile-msg").textContent = "Saved.";
  setTimeout(() => ($("set-profile-msg").textContent = ""), 2000);
});

// "Challenge start (Monday)" has to actually BE a Monday — the escalation
// math (targetFor) counts whole weeks from this date, while the rest-day
// cap (weekStart) is anchored to real calendar Mondays; a non-Monday start
// would let those two silently drift out of sync. <input type=date> lets
// you pick any day, so snap it the moment it changes rather than relying
// on the user to notice.
$("set-startdate").addEventListener("change", (e) => {
  if (e.target.value) e.target.value = weekStartOf(e.target.value);
});

$("set-save").addEventListener("click", async () => {
  const s = {
    ...state.settings,
    target_start: num("set-start", 1), target_step: num("set-step", 0),
    target_cap: num("set-cap", 1), rest_days_per_week: num("set-rest", 0),
    challenge_start: $("set-startdate").value ? weekStartOf($("set-startdate").value) : state.settings.challenge_start,
  };
  const rulesChanged = ["target_start", "target_step", "target_cap", "rest_days_per_week", "challenge_start"]
    .some((k) => String(s[k]) !== String(state.settings[k]));
  if (rulesChanged && !(await confirmSheet("This rewrites the challenge for the whole crew, effective immediately — everyone's target moves. Apply it?", { confirmLabel: "Apply for everyone", cancelLabel: "Not yet" }))) return;
  await state.adapter.saveSettings(state.crew.id, s, $("set-crewname").value.trim());
  $("set-msg").textContent = "Saved. Applies to everyone immediately.";
  setTimeout(() => ($("set-msg").textContent = ""), 2500);
  refetch();
});
function num(id, min) { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? Math.max(v, min) : min; }

$("set-switch").addEventListener("click", () => { session.clear(); location.reload(); });

// admin gate: hamburger menu -> "Admin" -> code prompt -> reveals the
// admin cards in Settings (kept out of the way for everyday users; the
// tiles stay hidden until unlocked). Same code as before, new entry point.
$("menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("menu-dropdown").classList.toggle("hidden");
});
document.addEventListener("click", () => $("menu-dropdown").classList.add("hidden"));

$("menu-admin").addEventListener("click", () => {
  $("menu-dropdown").classList.add("hidden");
  $("admin-modal-code").value = "";
  $("admin-modal-err").classList.add("hidden");
  $("admin-modal").classList.remove("hidden");
});
$("admin-modal-cancel").addEventListener("click", () => $("admin-modal").classList.add("hidden"));
function tryAdminCode() {
  if ($("admin-modal-code").value.trim().toLowerCase() === "knot") {
    $("admin-modal").classList.add("hidden");
    $("danger-zone").classList.remove("hidden");
    $("sim-date-card").classList.remove("hidden");
    $("state-dump-card").classList.remove("hidden");
    $("affirm-card").classList.remove("hidden");
    $("icon-gallery-card").classList.remove("hidden");
    renderAffirmEditor();
    renderIconGallery();
    // renaming the crew joins the admin surface: text swaps to a live field
    $("set-crewname-row").classList.remove("hidden");
    $("set-crewname-read").classList.add("hidden");
    switchScreen("settings");
  } else {
    $("admin-modal-err").classList.remove("hidden");
  }
}
// ---------- the unlock panel ----------
// Spec rule 3. The crew only ever sees your avatar change; this is the earner's
// own account of what it was and why. Without it the rules are invisible, which
// is what "never named anywhere" got wrong in the first draft.
//
// The high-water mark is the ONLY thing about achievements that is stored, and
// it is per-device on purpose: it records what this phone has SHOWN you, not
// what you have earned. Earning stays derived, so a new phone re-derives every
// unlock and simply catches you up on the notifications.
const UNLOCK_SEEN_KEY = () => `pushpact-unlocks-seen-${state.me?.id ?? "none"}`;

function renderUnlockPanel() {
  if (!state.me) return;
  const seen = Number(localStorage.getItem(UNLOCK_SEEN_KEY())) || 0;
  const fresh = unseenUnlocks(myUnlocks, seen, simNow());
  if (!fresh.length) return;
  // A member who joins with history behind them (or opens a new phone) would
  // otherwise get every unlock they ever earned in one wall of cards. Show the
  // most recent few and let the mark swallow the rest.
  const show = fresh.slice(-3);
  $("unlock-list").innerHTML = show.map((u) => {
    const meta = ACHIEVEMENT_BY_KEY[u.key];
    const worn = meta.wear === "weekly" ? "Worn for the week"
      : meta.wear === "until-clean-week" ? "Worn until a clean week clears it"
      : "Worn for 24 hours";
    return `<div class="unlock-row">
      <span class="unlock-mark${achievementArt(u.key) ? "" : " no-art"}">${
        achievementArt(u.key) ? avatarHTML(achievementArt(u.key)) : ""}</span>
      <span class="unlock-copy">
        <span class="unlock-name">${esc(meta.name)}</span>
        <span class="unlock-why">${esc(meta.blurb)}</span>
        <span class="unlock-worn">${worn}</span>
      </span>
    </div>`;
  }).join("");
  $("unlock-panel").classList.remove("hidden");
  hapticTick(24);
  // Mark everything seen, not just what was shown, so the skipped ones do not
  // queue up and reappear on the next render.
  localStorage.setItem(UNLOCK_SEEN_KEY(), String(fresh[fresh.length - 1].at));
}
$("unlock-dismiss").addEventListener("click", () => $("unlock-panel").classList.add("hidden"));

// ---------- admin: icon gallery ----------
// Every mark in AVATAR_ART on the app's own disc, at 88px and 44px, animations
// live. Built from AVATAR_ART itself rather than a hand-kept list, so a mark
// added to the set cannot be missing here.
//
// The keys the achievements engine can award are called out, because they are
// the ones absent from AVATARS: they are WORN, never chosen, so the ordinary
// avatar picker is not a place you can ever see them.
// DERIVED, not listed. A hardcoded set went stale the moment the crew drew
// fifteen more marks — the gallery claimed eight achievements when the app had
// twenty-four. Reading it off ACHIEVEMENTS means it cannot drift again.
const ACHIEVEMENT_ART_KEYS = new Set(
  ACHIEVEMENTS.map((a) => achievementArt(a.key)).filter(Boolean)
);

function renderIconGallery() {
  const achOnly = $("ig-achievements").checked;
  const keys = Object.keys(AVATAR_ART).filter((k) => !achOnly || ACHIEVEMENT_ART_KEYS.has(k));
  $("icon-gallery").innerHTML = keys.map((k) => {
    const ach = ACHIEVEMENT_ART_KEYS.has(k);
    return `<figure class="ig-cell${ach ? " is-ach" : ""}">
      <div class="ig-discs">
        <span class="ig-disc">${avatarHTML(k)}</span>
        <span class="ig-disc ig-sm">${avatarHTML(k)}</span>
      </div>
      <figcaption>${esc(k)}</figcaption>
    </figure>`;
  }).join("");
  $("icon-gallery").classList.toggle("is-frozen", $("ig-freeze").checked);
}
$("ig-freeze").addEventListener("change", () =>
  $("icon-gallery").classList.toggle("is-frozen", $("ig-freeze").checked));
$("ig-achievements").addEventListener("change", renderIconGallery);

// ---------- admin: celebration lines ----------
function renderAffirmEditor() {
  $("affirm-list").value = affirmations().join("\n");
  affirmCount();
}
// Validation is live rather than only on save: a line that is too long has to
// be visible as too long WHILE it is being typed, otherwise the first the admin
// hears of it is a rejection after they have written twenty of them.
function affirmParse() {
  const raw = $("affirm-list").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const kept = [];
  const over = [];
  for (const line of raw) {
    if (line.length > AFFIRM_MAX) over.push(line);
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }
  return { kept, over };
}
function affirmCount() {
  const { kept, over } = affirmParse();
  const el = $("affirm-count");
  el.textContent = over.length
    ? `${kept.length} lines — ${over.length} over ${AFFIRM_MAX} characters`
    : `${kept.length} lines, longest ${Math.max(0, ...kept.map((s) => s.length))} of ${AFFIRM_MAX} characters`;
  el.classList.toggle("over", over.length > 0);
}
$("affirm-list").addEventListener("input", affirmCount);
$("affirm-reset").addEventListener("click", () => {
  $("affirm-list").value = DEFAULT_AFFIRMATIONS.join("\n");
  affirmCount();
});
$("affirm-save").addEventListener("click", async () => {
  const err = $("affirm-err");
  const { kept, over } = affirmParse();
  if (over.length) {
    err.textContent = `${over.length} line${over.length > 1 ? "s are" : " is"} over ${AFFIRM_MAX} characters. Shorten ${over.length > 1 ? "them" : "it"} — anything longer wraps and stops reading as a headline.`;
    err.classList.remove("hidden"); return;
  }
  if (!kept.length) {
    err.textContent = "Leave at least one line, or restore the defaults.";
    err.classList.remove("hidden"); return;
  }
  if (kept.length > AFFIRM_MAX_LINES) {
    err.textContent = `That is ${kept.length} lines. Keep it under ${AFFIRM_MAX_LINES}.`;
    err.classList.remove("hidden"); return;
  }
  err.classList.add("hidden");
  // crew-wide copy, so it rides in the crew settings alongside the escalation
  state.settings = { ...state.settings, affirmations: kept };
  try {
    await state.adapter.saveSettings(state.crew.id, state.settings, $("set-crewname").value.trim());
    await refetch();
    renderAffirmEditor();
  } catch (e) { err.textContent = "Could not save. Try again."; err.classList.remove("hidden"); console.warn(e); }
});

$("admin-modal-submit").addEventListener("click", tryAdminCode);
$("admin-modal-code").addEventListener("keydown", (e) => { if (e.key === "Enter") tryAdminCode(); });

$("set-erase").addEventListener("click", async () => {
  const ok = await confirmSheet(
    "Erase every crew, profile, and logged set stored on this phone? Every rep you've ever banked, gone — no undo, no backup.",
    { confirmLabel: "Erase everything", cancelLabel: "Keep my data", danger: true }
  );
  if (!ok) return;
  Object.keys(localStorage).filter((k) => k.startsWith("pushpact-")).forEach((k) => localStorage.removeItem(k));
  location.reload();
});

// simulate date: overrides today() everywhere so the owner can walk the
// challenge through fake days (Monday +10 escalation, weekly rest cap)
// without waiting a real week or hand-editing localStorage.
$("set-sim-date").addEventListener("change", (e) => {
  if (e.target.value) localStorage.setItem("pushpact-date-override", e.target.value);
  else localStorage.removeItem("pushpact-date-override");
  refetch();
});
$("set-sim-clear").addEventListener("click", () => {
  localStorage.removeItem("pushpact-date-override");
  $("set-sim-date").value = "";
  refetch();
});

// raw state dump: read-only inspection of the stored crew/profile/sets blob,
// manual refresh only — no live diffing, no editing.
$("state-dump-refresh").addEventListener("click", () => {
  const raw = localStorage.getItem("pushpact-local");
  let out;
  try { out = JSON.stringify(JSON.parse(raw), null, 2); }
  catch { out = raw ? `(unparseable value) ${raw}` : "(empty — no pushpact-local key stored yet)"; }
  $("state-dump-pre").textContent = out;
});

// ---------- shell ----------

function switchScreen(name) {
  const from = SCREEN_ORDER.indexOf(state.screen);
  const to = SCREEN_ORDER.indexOf(name);
  state.screen = name;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.dataset.screen === name));
  SCREEN_ORDER.forEach((s) => {
    const el = $(`screen-${s}`);
    el.classList.toggle("hidden", s !== name);
    if (s === name && from !== to) {
      el.classList.remove("slide-l", "slide-r");
      void el.offsetWidth; // restart animation
      el.classList.add(to > from ? "slide-l" : "slide-r");
    }
  });
  renderAll();
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchScreen(t.dataset.screen)));

// The .app-peak watermark's fill: same dayTally/targetFor pair renderHome
// uses for the home dial, pushed as a CSS custom property so the mountain
// itself climbs with today's tally instead of just the numbers on the card.
// Runs ahead of the `!state.me` guard below (and guards itself) so a
// signed-out/no-target state always resolves to an explicit 0, never NaN.
function updatePeakFill() {
  const peak = document.querySelector(".app-peak");
  const lantern = document.querySelector(".app-lantern");
  if (!peak) return;
  const target = state.me ? targetFor(today(), state.settings) : 0;
  const tally = state.me ? dayTally(state.sets, state.me.id, today()) : 0;
  // target>0 guard: dividing by a 0/undefined target is how "%NaN" happens
  const pct = target > 0 ? Math.min(100, Math.max(0, (tally / target) * 100)) : 0;
  peak.style.setProperty("--peak-fill", `${pct}%`);
  // the route track and the walker live on .app-lantern, so both custom
  // properties are set on it too — --peak-pct is the same number, typed as
  // <number> for stroke-dashoffset (a % there means something else entirely)
  if (lantern) {
    // your climb, in your colour — the avatar colour the member picked
    const mine = state.me ? avatarParts(state.me.avatar).color : null;
    if (mine) lantern.style.setProperty("--trail-me", mine);
    else lantern.style.removeProperty("--trail-me");
    // Put the walker on the path by MEASURING the path, not by asking CSS to
    // do it. getPointAtLength works in the SVG's own user units — the same
    // space the route is drawn in — so the marker cannot drift away from the
    // line when the page is zoomed or the text scaled, which is exactly what
    // CSS offset-path was doing at 3x.
    const track = lantern.querySelector(".al-track");
    const walker = lantern.querySelector(".al-walker");
    if (track && walker && typeof track.getTotalLength === "function") {
      const len = track.getTotalLength();
      if (len > 0) {
        const p = track.getPointAtLength((pct / 100) * len);
        // SVG transform ATTRIBUTE with unitless values. A CSS transform of
        // translate(536px,7px) on an SVG child is not reliably read as user
        // units — that is why the dot sat out to the right of the line and
        // moved when the text was scaled. Unitless attribute values are user
        // units by definition, so this cannot be misread at any zoom.
        walker.setAttribute("transform", `translate(${p.x} ${p.y})`);
        // first placement must not animate in from the origin, which is what
        // made it slide in from the left edge at peak height on load
        if (!walker.dataset.placed) {
          walker.dataset.placed = "1";
          const prev = walker.style.transition;
          walker.style.transition = "none";
          void walker.getBoundingClientRect();
          walker.style.transition = prev;
        }
      }
    }
    lantern.style.setProperty("--peak-fill", `${pct}%`);
    lantern.style.setProperty("--peak-pct", `${pct}`);
    lantern.classList.toggle("walking", pct > 0);
    peak.classList.toggle("is-lit", target > 0 && tally >= target);
  }
  // .app-lantern is an unmasked sibling of .app-peak, not a masked child of
  // it (a CSS mask would flatten it into the masked group and clip it), so
  // its lit state toggles on its own element here instead of on .app-peak.
  lantern?.classList.toggle("is-lit", target > 0 && tally >= target);
}

function renderAll() {
  updatePeakFill();
  if (!state.me) return;
  updateHeadDate();
  // one ranking pass for the whole render, before anything draws an avatar
  refreshSpoonHolder();
  refreshAwards();
  // the header badge is the signed-in member, so it has to follow profile edits
  // and profile switches rather than being written once at boot. It is also the
  // only place the holder can see their OWN spoon — the corkboard filters them
  // out — so it goes through wornAvatar() too.
  $("head-avatar").innerHTML = avatarChip(wornAvatar(state.me));
  // admin entry point only makes sense where the admin cards actually live
  $("menu-wrap").classList.toggle("hidden", state.screen !== "settings");
  if (state.screen === "today") renderToday();
  if (state.screen === "crew") { renderHome(); renderCrew(); }
  if (state.screen === "history") renderHistory();
  if (state.screen === "settings") renderSettings();
  // last, so the panel opens over a screen that has finished drawing — and
  // after refreshAwards(), which is what fills myUnlocks
  renderUnlockPanel();
}

// ---------- home dashboard ----------

function stateLabel(st) {
  if (st.state === "pending") return st.tally > 0 ? "in progress" : "not started";
  return st.state;
}

// Quick-add: instant, no ceremony — same "just log it" pattern as History's
// "Log to this day" input, not the dial's stage-then-bank flow. Shared by
// Home's chips AND Today's +5/+10/+20 chips (unified contract, 2026-07-23) —
// only the dial still stages a compose value that needs a separate Bank tap.
// `btn` (the tapped chip, optional) is disabled for the duration of its own
// commit — belt-and-braces alongside serializeCommit's queuing, so a
// fat-finger double-tap on the SAME chip can't fire twice before the first
// commit's refetch has even landed.
async function homeQuickAdd(n, btn) {
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try {
    await serializeCommit(async () => {
      const before = myTallyToday();
      await state.adapter.addSet(state.me.id, today(), n);
      hapticTick(10);
      localStorage.setItem("pushpact-banks", String((parseInt(localStorage.getItem("pushpact-banks"), 10) || 0) + 1));
      await refetch();
      chipBankFeedback(n);
      maybeCelebrate(before, n);
    });
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Owner feedback 2026-07-24: a chip tap banked silently — the ledger grew
// but the dial itself didn't visibly react, which read as "nothing
// happened." A banked chip now floats its "+N" up off the dial face and
// pulses the ring, so the instant-commit contract has instant feedback too.
function chipBankFeedback(n) {
  if (state.screen !== "today") return;
  const dial = $("dial");
  if (!dial) return;
  const f = document.createElement("span");
  f.className = "dial-float";
  f.textContent = `+${n}`;
  dial.appendChild(f);
  setTimeout(() => f.remove(), 1000);
  dial.classList.add("chip-pulse");
  setTimeout(() => dial.classList.remove("chip-pulse"), 650);
}

function renderHome() {
  const h = new Date().getHours();
  const part = h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
  $("hh-greet").textContent = `${part}, ${state.me.name}.`;
  const start = state.settings.challenge_start;
  const wk = Math.floor(Math.max(0, (parseDay(today()) - parseDay(start)) / 86400000) / 7) + 1;
  $("hh-sub").textContent = today() < start
    ? `Warm-up — the climb begins ${parseDay(start).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}`
    : `Week ${wk} of the climb · target ${targetFor(today(), state.settings)}/day`;

  const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, day: today(), today: today(), settings: state.settings });
  const stk = streak({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, today: today(), settings: state.settings });
  const ws = weekStartOf(today());
  const weekTotal = state.sets
    .filter((s) => s.profile_id === state.me.id && s.day >= ws && s.day <= today())
    .reduce((a, s) => a + s.reps, 0);
  // council: leading with "0 day streak" demotivates — show day-of-climb instead
  const dayN = Math.max(1, Math.floor((parseDay(today()) - parseDay(start)) / 86400000) + 1);
  const weekPart = weekTotal > 0 ? ` · ${weekTotal} banked this week` : "";
  const streakLine = stk > 0 ? `${stk} day streak` : (today() < start ? "warm-up" : `day ${dayN} of the climb`);
  // council: warn the night before the target rises, never spring it
  const nudge = targetFor(addDays(today(), 1), state.settings) > st.target
    ? ` · target rises to ${targetFor(addDays(today(), 1), state.settings)} tomorrow` : "";
  $("home-mycard").innerHTML = `
    <div class="hc-top"><span class="hc-label">You, today</span><span class="state-chip bg-${st.state}">${stateLabel(st)}</span></div>
    <div class="hc-main">
      <div class="hc-nums"><span class="hc-tally">${st.tally}</span><span class="hc-of">/ ${st.target}</span></div>
      <!-- design council: static dial glyph removed here — aria-hidden, non-interactive,
           but drawn with a knob sitting at the exact progress angle right above chips
           that DO log. Read as a broken control, not decoration. -->
    </div>
    <div class="hc-meta">${streakLine}${weekPart}${nudge}</div>
    <button class="btn hc-cta" id="hc-cta">Log pushups ›</button>`;
  $("hc-cta").addEventListener("click", () => switchScreen("today"));

  renderWeekStrip();
}

// council-shape vocabulary reused from History (met=circle, rest=square, excused=diamond,
// missed=dash, pending=hollow) so the week-at-a-glance strip reads the same way colourblind.
function renderWeekStrip() {
  const ws = weekStartOf(today());
  const dowLabels = ["M", "T", "W", "T", "F", "S", "S"];
  let met = 0, judged = 0;
  const days = dowLabels.map((lbl, i) => {
    const day = addDays(ws, i);
    const isToday = day === today();
    if (day > today()) return { lbl, day, future: true, isToday };
    const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, day, today: today(), settings: state.settings });
    if (st.state !== "pending") { judged++; if (st.state === "met" || st.state === "rest") met++; }
    return { lbl, day, state: st.state, isToday };
  });
  $("ws-days").innerHTML = days.map((d) => `
    <div class="ws-day${d.isToday ? " today" : ""}${d.future ? " future" : ""}" ${d.future ? "" : `data-day="${d.day}"`}>
      <span class="ws-dow">${d.lbl}</span>
      <span class="ws-dot${d.future ? "" : ` bg-${d.state}`}"></span>
    </div>`).join("");
  $("ws-summary").textContent = judged ? `${met}/${judged} this week` : "";
  $("ws-days").querySelectorAll(".ws-day[data-day]").forEach((c) =>
    c.addEventListener("click", () => { state.histMonth = c.dataset.day.slice(0, 7); state.histPerson = state.me.id; state.histSelected = c.dataset.day; switchScreen("history"); }));
}
function weekStartOf(d) {
  const shift = (parseDay(d).getDay() + 6) % 7;
  return addDays(d, -shift);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) refetch(); });

// swipe between screens (pattern ported from the fitness app's bindTabSwipe:
// 55px min horizontal, 1.5x horizontal dominance, <700ms, ignores the dial and inputs)
(function bindScreenSwipe() {
  const app = $("app");
  let sx = 0, sy = 0, st = 0, tracking = false;
  app.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    if (e.target.closest(".dial, input, textarea, select, .overlay, .postit")) { tracking = false; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    tracking = true;
  }, { passive: true });
  app.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy, dt = Date.now() - st;
    if (dt > 700 || Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const idx = SCREEN_ORDER.indexOf(state.screen);
    const next = dx < 0 ? idx + 1 : idx - 1; // swipe left -> next screen
    if (next < 0 || next >= SCREEN_ORDER.length) return;
    hapticTick(6);
    switchScreen(SCREEN_ORDER[next]);
  }, { passive: true });
})();

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- phone-app install (PWA) ----------

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// iOS gives a home-screen web app its own storage, so a member who joined in
// Safari arrives at the installed app signed out — and the invite link that
// would fix it opens Safari, not the app. One line with the code closes that.
function setInstallHintCode(code) {
  const el = $("ih-code");
  if (!el || !code) return;
  el.textContent = `Your crew code is ${code} — enter it once when the app opens.`;
  el.classList.remove("hidden");
}

(function installHint() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const dismissed = localStorage.getItem("pushpact-install-dismissed");
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isMobile = isIOS || /android/i.test(navigator.userAgent);
  const hint = $("install-hint");
  $("ih-close").addEventListener("click", () => {
    hint.classList.add("hidden");
    document.body.classList.remove("ih-open");
    localStorage.setItem("pushpact-install-dismissed", "1");
  });
  if (standalone || dismissed) return;
  // council: don't pitch the install before the user has banked a single set
  const banked = (parseInt(localStorage.getItem("pushpact-banks"), 10) || 0) >= 1;
  if (isIOS) {
    if (!banked) return;
    hint.classList.remove("hidden");
    document.body.classList.add("ih-open");
  } else if (isMobile) {
    // Android: use the native install prompt when the browser offers it
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      if (!banked) return;
      $("ih-steps").innerHTML = "<b><u id='ih-install'>Tap here to install</u></b> — full screen, own icon, no browser.";
      hint.classList.remove("hidden");
    document.body.classList.add("ih-open");
      $("ih-install").addEventListener("click", () => { e.prompt(); hint.classList.add("hidden"); });
    });
  } else {
    $("ih-steps").innerHTML = "You're on a desktop — this app is built for your phone. Open <b>" +
      location.host + location.pathname + "</b> on your iPhone and Add to Home Screen.";
    hint.classList.remove("hidden");
    document.body.classList.add("ih-open");
  }
})();

boot();
