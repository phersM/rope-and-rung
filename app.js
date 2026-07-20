// Push Pact — app shell. Pure rules live in logic.js; storage in data.js.

import {
  toDayStr, addDays, parseDay, targetFor, dayTally, allTimeTotal, isLate,
  canDeclareRest, restsUsedInWeek, dayState, streak, DEFAULT_SETTINGS,
} from "./logic.js";
import { makeAdapter } from "./data.js";

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
  excuseDay: null, screen: "home",
};
const SCREEN_ORDER = ["home", "today", "crew", "history", "settings"];

const today = () => toDayStr(new Date());
const session = {
  load: () => JSON.parse(localStorage.getItem("pushpact-session") || "null"),
  save: (s) => localStorage.setItem("pushpact-session", JSON.stringify(s)),
  clear: () => localStorage.removeItem("pushpact-session"),
};

// ---------- boot ----------

async function boot() {
  state.adapter = await makeAdapter();
  $("local-banner").classList.toggle("hidden", state.adapter.shared || !!localStorage.getItem("pushpact-solo-dismissed"));
  $("lb-close").addEventListener("click", () => {
    $("local-banner").classList.add("hidden");
    localStorage.setItem("pushpact-solo-dismissed", "1");
  });
  $("head-date").textContent = parseDay(today()).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });

  // invite deep-link: ?code=XYZ prefills the crew code for the invited mate
  const inviteCode = new URLSearchParams(location.search).get("code");
  if (inviteCode) $("crew-code").value = inviteCode.toUpperCase();

  const sess = session.load();
  if (sess?.crewId && sess?.profileId) {
    try {
      await loadCrew(sess.crewId, sess.profileId);
      showApp();
      return;
    } catch (e) { console.warn("session restore failed", e); session.clear(); }
  }
  $("onboarding").classList.remove("hidden");
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
  state.adapter.subscribe(crewId, () => refetch());
}

async function refetch() {
  if (!state.crew) return;
  const all = await state.adapter.fetchAll(state.crew.id);
  state.crew = all.crew; state.profiles = all.profiles;
  state.sets = all.sets; state.statuses = all.statuses;
  state.settings = { ...DEFAULT_SETTINGS, ...(all.crew.settings || {}) };
  renderAll();
}

function showApp() {
  $("onboarding").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderAll();
}

// ---------- avatars: animated line-art profile marks (emoji kept as legacy fallback) ----------

const AVATAR_ART = {
  pumper: '<svg viewBox="0 0 48 48"><path d="M8 37 H40" opacity=".5"/><g class="aa-pump"><path d="M9 33 L26 27 L33 24.5"/><circle cx="37.5" cy="21.5" r="3.8" fill="currentColor" stroke="none"/><path d="M32 25 L31 33.5"/></g><path d="M9 33 L8 37"/></svg>',
  flex: '<svg viewBox="0 0 48 48"><circle cx="14" cy="9" r="4.5"/><path d="M14 15 V33"/><path d="M14 33 L9 43 M14 33 L20 43"/><path d="M14 20 L26 24"/><g class="aa-flex"><path d="M26 24 L36 16"/><circle cx="38" cy="14" r="4.5"/></g></svg>',
  grit: '<svg viewBox="0 0 48 48"><circle cx="24" cy="25" r="15"/><g class="aa-brow"><path d="M16 20 L22 22 M32 20 L26 22"/></g><circle cx="20" cy="27" r="1.7" fill="currentColor" stroke="none"/><circle cx="28" cy="27" r="1.7" fill="currentColor" stroke="none"/><path d="M19 34 H29"/><circle class="aa-sweat" cx="41" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>',
  beast: '<svg viewBox="0 0 48 48"><circle cx="24" cy="27" r="13"/><path class="aa-brow" d="M15 21 H33"/><circle cx="19.5" cy="26" r="1.7" fill="currentColor" stroke="none"/><circle cx="28.5" cy="26" r="1.7" fill="currentColor" stroke="none"/><path d="M20 34 Q24 31 28 34"/><path d="M11 16 L17 11 M37 16 L31 11"/></svg>',
  bolt: '<svg viewBox="0 0 48 48"><path class="aa-bolt" d="M27 5 L13 27 H22 L19 43 L35 20 H25 Z"/></svg>',
  spring: '<svg viewBox="0 0 48 48"><g class="aa-sprBody"><circle cx="24" cy="9" r="4.5"/><path d="M24 14 V27"/><path class="aa-sprArmL" d="M24 18 L13 9"/><path class="aa-sprArmR" d="M24 18 L35 9"/><path class="aa-sprLegL" d="M24 27 L14 40"/><path class="aa-sprLegR" d="M24 27 L34 40"/></g></svg>',
  zen: '<svg viewBox="0 0 48 48"><g class="aa-zenTorso"><circle cx="24" cy="10" r="4.5"/><path d="M24 15 V26"/><path d="M24 18 Q13 21 11 30 M24 18 Q35 21 37 30"/></g><path d="M10 33 Q24 25 38 33"/><path d="M14 37 H34" opacity=".5"/></svg>',
  bell: '<svg viewBox="0 0 48 48"><g class="aa-rock"><path d="M15 24 H33"/><rect x="8" y="15" width="6.5" height="18" rx="2.5"/><rect x="33.5" y="15" width="6.5" height="18" rx="2.5"/></g></svg>',
  flame: '<svg viewBox="0 0 48 48"><path class="aa-flick" d="M24 6 C28 14 34 17 34 27 A10 10 0 0 1 14 27 C14 20 20 16 24 6 Z"/><path d="M24 24 C26 28 28 29 28 32 A4 4 0 0 1 20 32 C20 29 22 27 24 24 Z" fill="currentColor" stroke="none" opacity=".8"/></svg>',
  star: '<svg viewBox="0 0 48 48"><path class="aa-twinkle" d="M24 6 L28.5 18 L41 19 L31 27 L34.5 40 L24 32.5 L13.5 40 L17 27 L7 19 L19.5 18 Z"/></svg>',
  peak: '<svg viewBox="0 0 48 48"><path d="M6 38 L20 14 L27 26 L33 18 L42 38 Z"/><path class="aa-flag" d="M20 14 V6 L27 9 L20 12"/></svg>',
  runner: '<svg viewBox="0 0 48 48"><circle cx="30" cy="10" r="4.5"/><path d="M28 15 L22 26"/><path d="M22 26 L14 30 M26 20 L36 24"/><path class="aa-runLegF" d="M22 26 L28 34 L24 42"/><path class="aa-runLegB" d="M22 26 L12 40"/></svg>',
  crown: '<svg viewBox="0 0 48 48"><path class="aa-seesaw" d="M10 34 L8 15 L18 24 L24 10 L30 24 L40 15 L38 34 Z"/><path d="M10 38 H38"/></svg>',
  wave: '<svg viewBox="0 0 48 48"><path class="aa-slide" d="M-8 30 Q-1 22 6 30 T20 30 T34 30 T48 30 T62 30" fill="none"/><path class="aa-slide2" d="M-12 38 Q-5 31 2 38 T16 38 T30 38 T44 38 T58 38 T72 38" fill="none" opacity=".5"/></svg>',
};
// avatar value format: "art" or "art.colour" (per-person icon colour)
const AVATAR_COLORS = { teal: "#0F7A6D", pine: "#0B3B34", blue: "#5B7FA6", mustard: "#C98A2B", brick: "#B23A2E", ink: "#1F1B16" };
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
// full circle chip incl. per-person background colour
function avatarChip(a) {
  const { color } = avatarParts(a);
  return `<span class="avatar"${color ? ` style="background:${color}"` : ""}>${avatarHTML(a)}</span>`;
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

// ---------- onboarding ----------

let obCrew = null, obAvatar = "pumper", obColor = "teal", obPendingCreate = false;
const AVATARS = ["pumper", "flex", "grit", "beast", "bolt", "spring", "zen", "bell", "flame", "star", "peak", "runner", "crown", "wave"];

$("ob-code-btn").addEventListener("click", async () => {
  const code = $("crew-code").value.trim().toUpperCase();
  if (code.length < 4) return obErr("Code needs at least 4 characters.");
  try {
    let crew = await state.adapter.findCrew(code);
    if (!crew) {
      if (!state.adapter.shared || obPendingCreate) {
        crew = await state.adapter.createCrew(code, { ...DEFAULT_SETTINGS, challenge_start: nextMonday() });
      } else {
        obPendingCreate = true;
        $("ob-code-btn").textContent = "No crew found — tap again to start one";
        return obErr(`No crew with code "${code}" yet.`);
      }
    }
    obCrew = crew;
    obErr("");
    $("ob-step-code").classList.add("hidden");
    $("ob-step-profile").classList.remove("hidden");
    const existing = await state.adapter.listProfiles(crew.id);
    $("ob-existing").innerHTML = existing.map((p) =>
      `<button data-id="${p.id}">${avatarChip(p.avatar)}${esc(p.name)}</button>`).join("");
    $("ob-existing").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => finishOnboarding(existing.find((p) => p.id === b.dataset.id))));
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
  } catch (e) { obErr("Couldn't reach the crew database. Try again."); console.error(e); }
});

$("ob-create-btn").addEventListener("click", async () => {
  const name = $("ob-name").value.trim();
  if (!name) return obErr("Give us a name.");
  const p = await state.adapter.createProfile(obCrew.id, name, `${obAvatar}.${obColor}`);
  finishOnboarding(p);
});

async function finishOnboarding(profile) {
  session.save({ crewId: obCrew.id, profileId: profile.id });
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
    scheduleDialRender();
  }
});

// council (Expansionist): the wind-up deserves a release — volt discharge on each full revolution
function crossedRev(before, after) {
  return after > 0 && Math.floor(after / REPS_PER_REV) > Math.floor(Math.max(0, before) / REPS_PER_REV);
}
function lapDischarge() {
  dial.classList.add("discharge");
  spawnSparks(10);
  setTimeout(() => dial.classList.remove("discharge"), 600);
}
["pointerup", "pointercancel"].forEach((ev) =>
  dial.addEventListener(ev, () => { dragging = false; dial.classList.remove("dragging"); }));

// quick-add chips: accessible, obvious alternative to cranking (council fix)
document.querySelectorAll(".qchip").forEach((b) =>
  b.addEventListener("click", () => {
    const n = parseInt(b.dataset.add, 10);
    const before = state.compose;
    state.rotation = Math.min(MAX_SET * DEG_PER_REP, state.rotation + n * DEG_PER_REP);
    state.compose = Math.round(state.rotation / DEG_PER_REP);
    hapticTick(5);
    if (crossedRev(before, state.compose)) lapDischarge();
    renderDial();
  }));

$("bank-btn").addEventListener("click", async () => {
  const reps = state.compose;
  if (!reps) return;
  if (reps < 0 && !window.confirm(`Remove ${-reps} pushups from today's tally?`)) return;
  const before = myTallyToday();
  await state.adapter.addSet(state.me.id, today(), reps);
  state.compose = 0; state.rotation = 0;
  hapticTick(20);
  localStorage.setItem("pushpact-banks", String((parseInt(localStorage.getItem("pushpact-banks"), 10) || 0) + 1));
  await refetch();
  const target = targetFor(today(), state.settings);
  if (before < target && before + reps >= target) {
    dial.classList.add("smashed");
    spawnSparks();
    setTimeout(() => dial.classList.remove("smashed"), 700);
  }
});

// volt spark burst from the dial rim on target smash
function spawnSparks(count = 26) {
  const r = dial.getBoundingClientRect().width / 2;
  for (let i = 0; i < count; i++) {
    const s = document.createElement("span");
    s.className = "spark" + (i % 3 === 2 ? " teal" : "");
    const ang = Math.random() * Math.PI * 2;
    const dist = r * (0.9 + Math.random() * 0.9);
    s.style.setProperty("--dx", `${Math.cos(ang) * dist}px`);
    s.style.setProperty("--dy", `${Math.sin(ang) * dist}px`);
    s.style.animationDelay = `${Math.random() * 0.12}s`;
    dial.appendChild(s);
    setTimeout(() => s.remove(), 1000);
  }
}

function myTallyToday() { return dayTally(state.sets, state.me.id, today()); }

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
      : `conic-gradient(var(--accent) 0deg ${deg}deg, #EDE3D0 ${deg}deg 360deg)`;
  } else {
    const rem = Math.min(-state.compose, REPS_PER_REV);
    const deg = (rem / REPS_PER_REV) * 360;
    knobDeg = 360 - deg;
    ring = `conic-gradient(#EDE3D0 0deg ${360 - deg}deg, rgba(178,58,46,.5) ${360 - deg}deg 360deg)`;
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
    `conic-gradient(${progFill}, rgba(31,27,22,.08) ${progDeg}deg 360deg)`;
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
  bank.textContent = state.compose
    ? (state.compose > 0 ? `Bank ${state.compose} pushups` : `Remove ${-state.compose} pushups`)
    : "Crank the dial to bank";
}

// ---------- today ----------

function renderToday() {
  renderDial();
  renderRope();
  const rows = state.sets
    .filter((s) => s.profile_id === state.me.id && s.day === today())
    .sort((a, b) => (a.logged_at < b.logged_at ? -1 : 1));
  $("ledger-rows").innerHTML = rows.length
    ? rows.map((s) => `
      <div class="l-row" data-sid="${s.id}" title="Tap to remove this set">
        <span class="reps ${s.reps < 0 ? "neg" : ""}">${s.reps}</span>
        <span class="stamps">${stamps(s.reps)}</span>
        ${isLate(s) ? '<span class="late">late</span>' : ""}
        <span class="t">${fmtTime(s.logged_at)}</span>
      </div>`).join("")
    : '<div class="l-empty">Nothing banked yet. The dial awaits.</div>';
  $("ledger-rows").querySelectorAll(".l-row[data-sid]").forEach((row) =>
    row.addEventListener("click", async () => {
      const s = rows.find((x) => x.id === row.dataset.sid);
      if (!s) return;
      if (!window.confirm(`Remove this set of ${s.reps}?`)) return;
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
      note = `<div class="postit${postitCls(ex.day)}"><small>${esc(m.name)} · ${ex.day === today() ? "today" : "yesterday"}</small>${esc(ex.excuse_text)}</div>`;
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

function stamps(n) {
  const count = Math.min(Math.abs(n), 30);
  let out = "";
  for (let i = 1; i <= count; i++)
    out += `<i class="stamp${i % 10 === 0 ? " five ten" : i % 5 === 0 ? " five" : ""}"></i>`;
  return out;
}
function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).toLowerCase() : "";
}

// council (Expansionist): a post-it curls a little more each day it hangs there.
// True read-tracking needs the shared DB; until then age since posting stands in.
function postitCls(day) {
  const age = Math.min(3, Math.max(0, Math.round((parseDay(today()) - parseDay(day)) / 86400000)));
  return age ? ` curl-${age}` : "";
}

// best single day, computed from the sets already in memory — pure display
function personalBest(sets, pid) {
  const per = {};
  for (const s of sets) if (s.profile_id === pid) per[s.day] = (per[s.day] || 0) + s.reps;
  return Object.values(per).reduce((a, b) => Math.max(a, b), 0);
}

function renderRope() {
  const n = streak({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, today: today(), settings: state.settings });
  const shown = Math.min(n, 6);
  // council (loss aversion): the next knot visibly frays when today is still unmet
  // and a streak is on the line — more urgently in the evening.
  const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, day: today(), today: today(), settings: state.settings });
  const atRisk = n > 0 && st.state === "pending";
  const urgent = atRisk && new Date().getHours() >= 17;
  // council (Expansionist): the rope tells both stories — fraying when in danger,
  // hanging slack and easy once today is banked
  const safe = st.state === "met" || st.state === "rest";
  let knots = "";
  for (let i = 0; i < shown; i++) knots += `<span class="knot${n > 0 && i === shown - 1 ? " volt" : ""}"></span>`;
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

// cycling ghost placeholders + particle vanish on submit (Aceternity vanish input, vanilla)
const GHOST_EXCUSES = [
  "the dog sat on me and I respected that",
  "gravity felt personal today",
  "my arms filed for annual leave",
  "the floor was too far away",
  "I was carbo-loading. all day.",
  "shoulder said no, and I listen to my body",
  "got pinned under a very heavy blanket",
  "training my neck by looking at the ceiling",
];
let ghostIdx = 0, ghostTimer = null;
function startGhost() {
  const ghost = $("excuse-ghost").firstElementChild;
  const tick = () => {
    ghost.textContent = $("excuse-text").value ? "" : GHOST_EXCUSES[ghostIdx % GHOST_EXCUSES.length];
    ghostIdx++;
  };
  tick();
  clearInterval(ghostTimer);
  ghostTimer = setInterval(tick, 3000);
}
$("excuse-text").addEventListener("input", () => {
  $("excuse-ghost").firstElementChild.textContent = $("excuse-text").value ? "" : GHOST_EXCUSES[ghostIdx % GHOST_EXCUSES.length];
});

function vanishText(done) {
  const ta = $("excuse-text");
  const canvas = $("excuse-canvas");
  const dpr = window.devicePixelRatio || 1;
  const w = ta.offsetWidth, h = ta.offsetHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.font = "600 24px Caveat, cursive";
  ctx.fillStyle = "#4A3A12";
  const words = ta.value.split(" ");
  let x = 2, y = 24;
  const lineH = 30, maxW = w - 4;
  words.forEach((word) => {
    const ww = ctx.measureText(word + " ").width;
    if (x + ww > maxW) { x = 2; y += lineH; }
    ctx.fillText(word, x, y); x += ww;
  });
  const img = ctx.getImageData(0, 0, w * dpr, h * dpr);
  const parts = [];
  for (let py = 0; py < img.height; py += 3 * dpr) {
    for (let px = 0; px < img.width; px += 3 * dpr) {
      if (img.data[(py * img.width + px) * 4 + 3] > 120) {
        parts.push({ x: px / dpr, y: py / dpr, vx: (Math.random() - 0.2) * 3.2, vy: (Math.random() - 0.5) * 2.4, a: 1 });
      }
    }
  }
  ta.classList.add("vanishing");
  const t0 = performance.now();
  (function frame(t) {
    const p = (t - t0) / 650;
    ctx.clearRect(0, 0, w, h);
    parts.forEach((pt) => {
      pt.x += pt.vx; pt.y += pt.vy; pt.a = Math.max(0, 1 - p * 1.15);
      ctx.globalAlpha = pt.a;
      ctx.fillRect(pt.x, pt.y, 2.2, 2.2);
    });
    ctx.globalAlpha = 1;
    if (p < 1) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, w, h); ta.classList.remove("vanishing"); done(); }
  })(t0);
}

$("excuse-save").addEventListener("click", () => {
  const text = $("excuse-text").value.trim();
  if (!text) return;
  hapticTick(12);
  vanishText(async () => {
    await state.adapter.removeStatus(state.me.id, state.excuseDay, "excuse");
    await state.adapter.addStatus({ profile_id: state.me.id, day: state.excuseDay, kind: "excuse", excuse_text: text });
    $("excuse-text").value = "";
    $("excuse-modal").classList.add("hidden");
    refetch();
  });
});

function openExcuse(day) {
  state.excuseDay = day;
  const existing = state.statuses.find((s) => s.profile_id === state.me.id && s.day === day && s.kind === "excuse");
  $("excuse-text").value = existing?.excuse_text ?? "";
  $("excuse-delete").classList.toggle("hidden", !existing);
  $("excuse-modal").classList.remove("hidden");
  startGhost();
  $("excuse-text").focus();
}
$("excuse-delete").addEventListener("click", async () => {
  await state.adapter.removeStatus(state.me.id, state.excuseDay, "excuse");
  $("excuse-modal").classList.add("hidden");
  refetch();
});

// ---------- crew ----------

function renderCrew() {
  const cards = state.profiles.map((p) => {
    const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: p.id, day: today(), today: today(), settings: state.settings });
    const days = [...Array(7)].map((_, i) => addDays(today(), i - 6));
    const strip = days.map((d) => {
      const s = dayState({ sets: state.sets, statuses: state.statuses, profileId: p.id, day: d, today: today(), settings: state.settings });
      return `<span class="cell bg-${s.state}" title="${d}"></span>`;
    }).join("");
    const total = allTimeTotal(state.sets, p.id);
    const stk = streak({ sets: state.sets, statuses: state.statuses, profileId: p.id, today: today(), settings: state.settings });
    const ex = state.statuses.find((s) => s.profile_id === p.id && s.kind === "excuse" &&
      (s.day === today() || s.day === addDays(today(), -1)));
    return `
      <div class="crew-card" data-pid="${p.id}">
        <div class="who">
          ${avatarChip(p.avatar)}
          <div><div class="nm">${esc(p.name)}${p.id === state.me.id ? " (you)" : ""}</div>
          <div class="sub">${stk} day streak · ${total.toLocaleString()} all-time${personalBest(state.sets, p.id) > 0 ? ` <span class="pb-badge">PB ${personalBest(state.sets, p.id)}</span>` : ""}</div></div>
          <span class="state-chip bg-${st.state}">${stateLabel(st)}</span>
        </div>
        <div class="big"><span class="n">${st.tally}</span><span class="of">of ${st.target} today</span></div>
        <div class="strip">${strip}</div>
        ${ex?.excuse_text && p.id !== state.me.id ? `<div class="postit${postitCls(ex.day)}"><small>${ex.day === today() ? "today" : "yesterday"}</small>${esc(ex.excuse_text)}</div>` : ""}
      </div>`;
  }).join("");
  $("crew-cards").innerHTML = cards;
}

$("share-btn").addEventListener("click", async () => {
  const link = `${location.origin}${location.pathname}?code=${encodeURIComponent(state.crew.crew_code)}`;
  const msg = `Push Pact — daily pushups, no hiding. Open ${link} (crew code ${state.crew.crew_code} is pre-filled)`;
  if (navigator.share) { try { await navigator.share({ text: msg }); } catch {} }
  else { await navigator.clipboard.writeText(msg); $("share-btn").textContent = "Copied!"; setTimeout(() => $("share-btn").textContent = "Share invite", 1500); }
});

// ---------- history ----------

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
  for (const x of days) {
    if (x.future) { cells += `<span class="hist-cell future"><span class="d">${x.d}</span></span>`; continue; }
    const rowEnd = (lead + x.d) % 7 === 0;
    const ink = x.d < lineEnd && !rowEnd ? " ink" : "";
    cells += `<span class="hist-cell${ink}" data-day="${x.day}"><span class="d">${x.d}</span><span class="st bg-${x.st.state}"></span></span>`;
  }
  $("hist-grid").classList.toggle("perfect", perfect);
  $("hist-grid").innerHTML = cells;
  $("hist-grid").querySelectorAll(".hist-cell[data-day]").forEach((c) =>
    c.addEventListener("click", () => { state.histSelected = c.dataset.day; renderHistDetail(); }));
  renderHistDetail();
}

function renderHistDetail() {
  const el = $("hist-detail");
  if (!state.histSelected) { el.classList.add("hidden"); return; }
  const day = state.histSelected;
  const pid = state.histPerson;
  const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: pid, day, today: today(), settings: state.settings });
  const rows = state.sets.filter((s) => s.profile_id === pid && s.day === day)
    .map((s) => `${s.reps > 0 ? "+" : ""}${s.reps} at ${fmtTime(s.logged_at)}${isLate(s) ? " (late)" : ""}`).join("<br>") || "No sets logged.";
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

// ---------- settings ----------

function renderSettings() {
  $("set-start").value = state.settings.target_start;
  $("set-step").value = state.settings.target_step;
  $("set-cap").value = state.settings.target_cap;
  $("set-rest").value = state.settings.rest_days_per_week;
  $("set-startdate").value = state.settings.challenge_start;
  $("set-crewname").value = state.crew.name ?? "";
  $("set-crewcode").textContent = state.crew.crew_code;
}

$("set-save").addEventListener("click", async () => {
  const s = {
    ...state.settings,
    target_start: num("set-start", 1), target_step: num("set-step", 0),
    target_cap: num("set-cap", 1), rest_days_per_week: num("set-rest", 0),
    challenge_start: $("set-startdate").value || state.settings.challenge_start,
  };
  const rulesChanged = ["target_start", "target_step", "target_cap", "rest_days_per_week", "challenge_start"]
    .some((k) => String(s[k]) !== String(state.settings[k]));
  if (rulesChanged && !window.confirm("This changes the challenge for the whole crew, effective immediately. Apply?")) return;
  await state.adapter.saveSettings(state.crew.id, s, $("set-crewname").value.trim());
  $("set-msg").textContent = "Saved. Applies to everyone immediately.";
  setTimeout(() => ($("set-msg").textContent = ""), 2500);
  refetch();
});
function num(id, min) { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? Math.max(v, min) : min; }

$("set-switch").addEventListener("click", () => { session.clear(); location.reload(); });

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

function renderAll() {
  if (!state.me) return;
  if (state.screen === "home") renderHome();
  if (state.screen === "today") renderToday();
  if (state.screen === "crew") renderCrew();
  if (state.screen === "history") renderHistory();
  if (state.screen === "settings") renderSettings();
}

// ---------- home dashboard ----------

function stateLabel(st) {
  if (st.state === "pending") return st.tally > 0 ? "in progress" : "not started";
  return st.state;
}

function renderHome() {
  const h = new Date().getHours();
  const part = h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
  $("hh-greet").textContent = `${part}, ${state.me.name}.`;
  const start = state.settings.challenge_start;
  const wk = Math.floor(Math.max(0, (parseDay(today()) - parseDay(start)) / 86400000) / 7) + 1;
  $("hh-sub").textContent = today() < start
    ? `Warm-up — the pact begins ${parseDay(start).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}`
    : `Week ${wk} of the pact · target ${targetFor(today(), state.settings)}/day`;

  const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, day: today(), today: today(), settings: state.settings });
  const stk = streak({ sets: state.sets, statuses: state.statuses, profileId: state.me.id, today: today(), settings: state.settings });
  const ws = weekStartOf(today());
  const weekTotal = state.sets
    .filter((s) => s.profile_id === state.me.id && s.day >= ws && s.day <= today())
    .reduce((a, s) => a + s.reps, 0);
  const pct = Math.min(100, Math.round((st.tally / st.target) * 100));
  // council: leading with "0 day streak" demotivates — show day-of-pact instead
  const dayN = Math.max(1, Math.floor((parseDay(today()) - parseDay(start)) / 86400000) + 1);
  const weekPart = weekTotal > 0 ? ` · ${weekTotal} banked this week` : "";
  const streakLine = stk > 0 ? `${stk} day streak` : (today() < start ? "warm-up" : `day ${dayN} of the pact`);
  // council: warn the night before the target rises, never spring it
  const nudge = targetFor(addDays(today(), 1), state.settings) > st.target
    ? ` · target rises to ${targetFor(addDays(today(), 1), state.settings)} tomorrow` : "";
  $("home-mycard").innerHTML = `
    <div class="hc-top"><span class="hc-label">You, today</span><span class="state-chip bg-${st.state}">${stateLabel(st)}</span></div>
    <div class="hc-nums"><span class="hc-tally">${st.tally}</span><span class="hc-of">/ ${st.target}</span></div>
    <div class="hc-bar"><span style="width:${pct}%"></span></div>
    <div class="hc-meta">${streakLine}${weekPart}${nudge}</div>
    <button class="btn hc-cta" id="hc-cta">Log pushups ›</button>`;
  $("hc-cta").addEventListener("click", () => switchScreen("today"));

  // Owner decision 2026-07-17: everyone always sees their OWN card first, then the
  // team's — solo use is first-class (supersedes the council's mates-first inversion).
  const others = state.profiles.filter((p) => p.id !== state.me.id);
  $("home-crew").innerHTML = `<div class="l-title">The crew today</div>` + (others.length
    ? others.map((p, i) => {
        const s = dayState({ sets: state.sets, statuses: state.statuses, profileId: p.id, day: today(), today: today(), settings: state.settings });
        return `<div class="row" data-pid="${p.id}" style="animation-delay:${0.06 * (i + 1)}s">
          ${avatarChip(p.avatar)}<span class="nm">${esc(p.name)}</span>
          <span class="nums">${s.tally} <small>/ ${s.target}</small></span><span class="sdot bg-${s.state}"></span>
        </div>`;
      }).join("")
    : `<div class="row"><span class="nm" style="color:var(--muted);font-weight:600">Flying solo for now — that counts too. Invite a friend from the Crew tab whenever.</span></div>`);

  let note = "";
  for (const m of others) {
    const ex = state.statuses.find((x) => x.profile_id === m.id && x.kind === "excuse" &&
      (x.day === today() || x.day === addDays(today(), -1)));
    if (ex?.excuse_text) {
      note = `<div class="postit${postitCls(ex.day)}"><small>${esc(m.name)} · ${ex.day === today() ? "today" : "yesterday"}</small>${esc(ex.excuse_text)}</div>`;
      break;
    }
  }
  if (!note) {
    // council: surface the excuse of the week when nothing fresher is up
    const weekEx = state.statuses
      .filter((x) => x.kind === "excuse" && x.excuse_text && x.day >= ws && x.day <= today())
      .sort((a, b) => (a.day < b.day ? 1 : -1))[0];
    if (weekEx) {
      const who = state.profiles.find((p) => p.id === weekEx.profile_id);
      note = `<div class="postit${postitCls(weekEx.day)}"><small>excuse of the week · ${esc(who?.name ?? "?")}</small>${esc(weekEx.excuse_text)}</div>`;
    }
  }
  $("home-postit").innerHTML = note;
}
function weekStartOf(d) {
  const shift = (parseDay(d).getDay() + 6) % 7;
  return addDays(d, -shift);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) refetch(); });

// floating-dock proximity magnify (Aceternity dock, vanilla)
(function bindDockMagnify() {
  const bar = document.querySelector(".tabbar");
  const tabs = [...bar.querySelectorAll(".tab")];
  const set = (x) => {
    tabs.forEach((t) => {
      const r = t.getBoundingClientRect();
      const d = Math.abs(x - (r.left + r.width / 2));
      const mag = Math.max(1, 1.32 - (d / 150) * 0.32);
      t.style.setProperty("--mag", mag.toFixed(3));
    });
  };
  const reset = () => { bar.classList.remove("magnifying"); tabs.forEach((t) => t.style.setProperty("--mag", 1)); };
  bar.addEventListener("pointermove", (e) => { bar.classList.add("magnifying"); set(e.clientX); });
  bar.addEventListener("touchmove", (e) => { bar.classList.add("magnifying"); set(e.touches[0].clientX); }, { passive: true });
  ["pointerleave", "touchend", "touchcancel"].forEach((ev) => bar.addEventListener(ev, reset));
})();

// animated tooltip: tap an avatar for a springy stat card
(function bindAvatarTips() {
  let hideTimer = null;
  document.addEventListener("click", (e) => {
    const av = e.target.closest(".crew-card .avatar, .home-crew .avatar, .ob-existing .avatar");
    const tip = $("av-tip");
    if (!av) { tip.classList.add("hidden"); return; }
    const card = av.closest("[data-pid]") || av.closest(".crew-card, .row");
    const pid = card?.dataset?.pid;
    const p = state.profiles.find((x) => x.id === pid);
    if (!p) return;
    const st = dayState({ sets: state.sets, statuses: state.statuses, profileId: p.id, day: today(), today: today(), settings: state.settings });
    const stk = streak({ sets: state.sets, statuses: state.statuses, profileId: p.id, today: today(), settings: state.settings });
    tip.innerHTML = `<b>${esc(p.name)}</b>${st.tally} / ${st.target} today · <span class="tip-volt">${stk} day streak</span><br>${allTimeTotal(state.sets, p.id).toLocaleString()} all-time${personalBest(state.sets, p.id) > 0 ? ` · PB ${personalBest(state.sets, p.id)}` : ""}`;
    const r = av.getBoundingClientRect();
    tip.classList.remove("hidden");
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 10}px`;
    hapticTick(4);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => tip.classList.add("hidden"), 2600);
  });
})();

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
