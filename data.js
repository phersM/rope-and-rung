// Rope & Rung — data layer. Adapters behind one interface:
//   LocalAdapter    — localStorage only (solo mode: offline, or no backend reachable)
//   HttpRpcAdapter  — the shared crew database: the Cloudflare API in worker/
//                     (D1 behind Pages Functions), or serve-dev.py locally
//   SupabaseAdapter — the previous backend, kept for a config.js that names one
//
// Interface: init(), findCrew(code), createCrew(defaults), resume(code,crewId),
// listProfiles(crewId),
// createProfile(crewId,name,avatar), updateProfile(profileId,name,avatar),
// fetchAll(crewId) -> {sets,statuses,settings,crew},
// addSet(profileId,day,reps), addStatus(row), removeStatus(profileId,day,kind),
// saveSettings(crewId,settings,name), subscribe(crewId,cb)

// randomUUID() is a secure-context API: it exists on https and on localhost,
// and is undefined over plain http — which is exactly how a phone on the LAN
// reaches the dev server. Without a fallback, onboarding dies on the first tap
// on the one device you most want to test on. getRandomValues() carries no
// such restriction, so build the v4 by hand when randomUUID isn't there.
const uid = () => crypto.randomUUID?.() ?? uuidV4();

function uuidV4() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;   // version 4
  b[8] = (b[8] & 0x3f) | 0x80;   // variant 10xx
  const h = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Crew codes are generated, never chosen — the code is the only thing standing
// between a stranger and a crew, and humans asked to invent one invent ROPE26.
// Alphabet drops I/O/0/1 so a code read aloud or typed off a screenshot can't
// be got wrong; 256 % 32 = 0, so the modulo stays uniform. Supabase generates
// its own server-side (see supabase/schema.sql — the client is not trusted to
// do it); this covers LocalAdapter, where the code is a local placeholder
// nobody can join with anyway.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
export const newCrewCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)),
    (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
export const looksLikeCode = (s) =>
  new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(s);

export class LocalAdapter {
  constructor() { this.key = "pushpact-local"; this.shared = false; }
  _db() {
    return JSON.parse(localStorage.getItem(this.key) || '{"crews":[],"profiles":[],"sets":[],"statuses":[]}');
  }
  _save(db) { localStorage.setItem(this.key, JSON.stringify(db)); }
  async init() {}
  async findCrew(code) {
    return this._db().crews.find((c) => c.crew_code === code) ?? null;
  }
  async createCrew(defaults) {
    const db = this._db();
    const crew = { id: uid(), name: "The Climb", crew_code: newCrewCode(), settings: defaults };
    db.crews.push(crew); this._save(db); return crew;
  }
  resume() {}
  async listProfiles(crewId) { return this._db().profiles.filter((p) => p.crew_id === crewId); }
  async createProfile(crewId, name, avatar) {
    const db = this._db();
    const p = { id: uid(), crew_id: crewId, name, avatar, created_at: new Date().toISOString() };
    db.profiles.push(p); this._save(db); return p;
  }
  async updateProfile(profileId, name, avatar) {
    const db = this._db();
    const p = db.profiles.find((x) => x.id === profileId);
    if (p) { p.name = name; p.avatar = avatar; }
    this._save(db);
  }
  async fetchAll(crewId) {
    const db = this._db();
    const crew = db.crews.find((c) => c.id === crewId);
    const profiles = db.profiles.filter((p) => p.crew_id === crewId);
    const pids = new Set(profiles.map((p) => p.id));
    return {
      crew, profiles,
      sets: db.sets.filter((s) => pids.has(s.profile_id)),
      statuses: db.statuses.filter((s) => pids.has(s.profile_id)),
    };
  }
  async addSet(profileId, day, reps) {
    const db = this._db();
    db.sets.push({ id: uid(), profile_id: profileId, day, reps, logged_at: new Date().toISOString() });
    this._save(db);
  }
  async addStatus(row) {
    const db = this._db();
    db.statuses.push({ id: uid(), created_at: new Date().toISOString(), ...row });
    this._save(db);
  }
  async removeSet(setId) {
    const db = this._db();
    db.sets = db.sets.filter((s) => s.id !== setId);
    this._save(db);
  }
  async removeStatus(profileId, day, kind) {
    const db = this._db();
    db.statuses = db.statuses.filter((s) => !(s.profile_id === profileId && s.day === day && s.kind === kind));
    this._save(db);
  }
  async saveSettings(crewId, settings, name) {
    const db = this._db();
    const c = db.crews.find((x) => x.id === crewId);
    if (c) { c.settings = settings; if (name) c.name = name; }
    this._save(db);
  }
  // No-op is CORRECT here, not a stub: LocalAdapter is single-device
  // localStorage, there is no second writer to ever hear from, so leave
  // this as-is — do not "fix" it into a storage-event listener or similar.
  subscribe() { return () => {}; }
}

// Shared-crew adapters. All reads/writes go through code-gated remote
// procedures (see supabase/schema.sql) that re-validate crew_code against
// crew_id on every call — the client has zero direct table access. The adapter
// keeps this.code / this.crewId from the join step and threads them into every
// call, so no caller in app.js needs to know.
//
// The call sequence lives HERE, once, and both transports inherit it. That is
// deliberate: serve-dev.py's local backend is only a trustworthy rehearsal for
// Supabase if the two cannot drift apart. Subclasses supply _rpc() and nothing
// else.

// Cheap, stable "did the crew's data actually change" fingerprint for a
// fetchAll() bundle. Whole-content (not just row counts), so a same-length
// edit — renaming a profile, editing a set's reps, flipping crew settings —
// still registers; arrays are sorted by id first so two fetches of identical
// data can never disagree just because the backend happened to return rows
// in a different order (which would otherwise fire cb() on every poll,
// exactly what we're told not to do). A two-person crew's whole bundle is a
// few KB at most, so stringifying it every poll is not worth optimising
// into something cleverer.
function bundleSignature({ crew, profiles = [], sets = [], statuses = [] }) {
  const byId = (arr) => [...arr].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ crew, profiles: byId(profiles), sets: byId(sets), statuses: byId(statuses) });
}

// Two-person app, a set gets logged a handful of times a day: anything
// tighter than this just burns battery and (on Supabase) free-tier request
// quota for no perceptible gain, and 15s still means a crewmate's pushup
// shows up well within the same sitting.
const POLL_INTERVAL_MS = 15000;

class RpcAdapter {
  constructor() { this.shared = true; this.code = null; this.crewId = null; }
  async _rpc() { throw new Error("subclass must implement _rpc"); }

  async findCrew(code) {
    const data = await this._rpc("find_crew", { p_code: code });
    if (data) { this.code = code; this.crewId = data.id; }
    return data;
  }
  async createCrew(defaults) {
    // no code is sent: the server generates it, so a tampered client cannot
    // weaken the only credential this app has
    const data = await this._rpc("create_crew", { p_settings: defaults });
    this.code = data.crew_code; this.crewId = data.id;
    return data;
  }
  // Solo history -> a new shared crew (see import_crew in worker/src/api.js).
  // Ids are kept, so the phone's saved session still points at the right rows;
  // only the crew code is new.
  async importCrew({ crew, profiles, sets, statuses }) {
    const data = await this._rpc("import_crew",
      { p_crew: crew, p_profiles: profiles, p_sets: sets, p_statuses: statuses });
    this.code = data.crew_code; this.crewId = data.id;
    return data;
  }
  // Restoring a saved session skips findCrew/createCrew, so nothing would have
  // set this.code and every call below would go out with a null code — which
  // the schema correctly rejects, silently logging the user out on every
  // reload. The session carries the code back in; this puts it where the
  // adapter expects it.
  resume(code, crewId) { this.code = code; this.crewId = crewId; }

  async listProfiles(crewId) {
    return (await this._rpc("crew_profiles", { p_code: this.code, p_crew_id: crewId })) ?? [];
  }
  async createProfile(crewId, name, avatar) {
    return this._rpc("create_profile",
      { p_code: this.code, p_crew_id: crewId, p_name: name, p_avatar: avatar });
  }
  async updateProfile(profileId, name, avatar) {
    await this._rpc("update_profile",
      { p_code: this.code, p_crew_id: this.crewId, p_profile_id: profileId, p_name: name, p_avatar: avatar });
  }
  async fetchAll(crewId) {
    const data = await this._rpc("crew_bundle", { p_code: this.code, p_crew_id: crewId });
    return { crew: data.crew, profiles: data.profiles ?? [], sets: data.sets ?? [], statuses: data.statuses ?? [] };
  }
  async addSet(profileId, day, reps) {
    await this._rpc("add_set",
      { p_code: this.code, p_crew_id: this.crewId, p_profile_id: profileId, p_day: day, p_reps: reps });
  }
  async addStatus(row) {
    await this._rpc("add_status", {
      p_code: this.code, p_crew_id: this.crewId, p_profile_id: row.profile_id,
      p_day: row.day, p_kind: row.kind, p_excuse_text: row.excuse_text ?? null,
    });
  }
  async removeSet(setId) {
    await this._rpc("remove_set",
      { p_code: this.code, p_crew_id: this.crewId, p_set_id: setId });
  }
  async removeStatus(profileId, day, kind) {
    await this._rpc("remove_status",
      { p_code: this.code, p_crew_id: this.crewId, p_profile_id: profileId, p_day: day, p_kind: kind });
  }
  async saveSettings(crewId, settings, name) {
    await this._rpc("save_settings",
      { p_code: this.code, p_crew_id: crewId, p_settings: settings, p_name: name ?? "" });
  }
  // Neither transport pushes changes at the network layer (DevServerAdapter
  // never will; SupabaseAdapter's postgres_changes override lives below and
  // falls back to this), so both drive updates by polling fetchAll() and
  // diffing bundleSignature() against the last one seen — cb() only fires
  // when something actually changed, never on a bare timer tick.
  //
  // Pausing while document.hidden is true (and resuming on
  // visibilitychange) is what stops the interval from ticking away in a
  // backgrounded tab; the returned unsubscribe clears the interval, removes
  // the visibilitychange listener, AND flips `stopped` so a fetch that was
  // already in flight when unsubscribe() was called can't sneak a late
  // cb() through after the caller believes it has stopped.
  subscribe(crewId, cb) {
    if (!crewId) return () => {}; // never poll for a crew that isn't loaded yet

    let timer = null;
    let stopped = false;
    let inFlight = false;
    let lastSig = null;

    const poll = async () => {
      if (stopped || document.hidden || inFlight) return;
      inFlight = true;
      try {
        const bundle = await this.fetchAll(crewId);
        const sig = bundleSignature(bundle);
        // lastSig === null means this is the priming poll (or the previous
        // one errored before ever setting it) — never fire cb() on that
        // first comparison, only on an actual change from a known baseline.
        if (!stopped && lastSig !== null && sig !== lastSig) cb();
        lastSig = sig;
      } catch {
        // transient network blip — the next tick just tries again
      } finally {
        inFlight = false;
      }
    };

    const start = () => { if (!timer && !stopped && !document.hidden) timer = setInterval(poll, POLL_INTERVAL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => { if (document.hidden) stop(); else start(); };

    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) poll(); // seed lastSig now rather than waiting a full interval for the first comparison
    start();

    return () => {
      stopped = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }
}

export class SupabaseAdapter extends RpcAdapter {
  constructor(cfg, supabaseLib) { super(); this.cfg = cfg; this.lib = supabaseLib; this.client = null; }
  async init() { this.client = this.lib.createClient(this.cfg.url, this.cfg.anonKey); }
  async _rpc(name, args) {
    const { data, error } = await this.client.rpc(name, args);
    if (error) throw error;
    return data;
  }

  // UNVERIFIED. The Supabase project this app points to is dead (its host no
  // longer resolves), so this override has never actually connected to a
  // realtime socket, let alone received an event from one — the polling path
  // above is the only part of subscribe() that has been exercised.
  //
  // It is also, by the same reasoning that already lives in
  // supabase/schema.sql:264, unverifiable even in principle against the
  // CURRENT schema: Realtime replication is deliberately NOT enabled on
  // crews/profiles/sets/day_status there, and anon has no RLS SELECT grant on
  // any of them (every read goes through a SECURITY DEFINER RPC instead) —
  // so even a perfectly-filtered channel would most likely report
  // "SUBSCRIBED" and then deliver zero events, forever, with no error to
  // catch. That is exactly the failure mode a naive "prefer realtime, fall
  // back to polling only on error" implementation would miss silently. So
  // this keeps the inherited poll loop running unconditionally as the proven
  // delivery mechanism, and layers a best-effort channel on top purely as a
  // latency improvement for whenever the schema is revisited (the note's own
  // suggested fix: "denormalized crew_id + a narrow view").
  //
  // The filters below scope the channel to just this crew's rows without
  // needing that schema change: crews/profiles already carry a crew_id-ish
  // column directly, and sets/day_status (which only carry profile_id) are
  // scoped by an explicit profile_id IN-list snapshotted from this crew's
  // current members when subscribe() runs — never an unfiltered channel,
  // which is precisely the cross-crew broadcast leak schema.sql:264 already
  // rejected for exactly this reason. A profile created *after* this call
  // won't be covered by that snapshot until the next loadCrew() resubscribes;
  // the polling loop still catches that case in the meantime.
  subscribe(crewId, cb) {
    const pollUnsub = super.subscribe(crewId, cb);
    if (!crewId || !this.client) return pollUnsub;

    let channel = null;
    let stopped = false;
    (async () => {
      let profiles;
      try { profiles = await this.listProfiles(crewId); } catch { return; }
      if (stopped || !profiles.length) return; // nothing to scope a filter to yet — polling covers it
      const ids = profiles.map((p) => p.id).join(",");
      try {
        channel = this.client
          .channel(`crew-${crewId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "crews", filter: `id=eq.${crewId}` }, () => cb())
          .on("postgres_changes", { event: "*", schema: "public", table: "profiles", filter: `crew_id=eq.${crewId}` }, () => cb())
          .on("postgres_changes", { event: "*", schema: "public", table: "sets", filter: `profile_id=in.(${ids})` }, () => cb())
          .on("postgres_changes", { event: "*", schema: "public", table: "day_status", filter: `profile_id=in.(${ids})` }, () => cb())
          .subscribe();
      } catch {
        // channel could not be built at all — the poll loop above already covers us
      }
      if (stopped) { try { channel?.unsubscribe(); } catch {} }
    })();

    return () => {
      stopped = true;
      pollUnsub();
      try { channel?.unsubscribe(); } catch {}
    };
  }
}

// The crew database. Every environment speaks the same POST /rpc/<name>
// envelope, so one adapter serves both:
//   - production: the Cloudflare API (worker/ — D1 behind Pages Functions),
//     which replaced Supabase on 2026-09-14 after that project was deleted;
//   - dev: serve-dev.py's in-process backend on the same origin (base ""),
//     selected only by an explicit devServer flag in the gitignored config.js.
// The API URL is not a secret — like Supabase's anon key it only names the
// door; the crew code is what opens it, re-checked server-side on every call.
export const CREW_API = "https://rope-and-rung-api.pages.dev";

export class HttpRpcAdapter extends RpcAdapter {
  constructor(base) { super(); this.base = base; }
  async init() {}
  async _rpc(name, args) {
    const res = await fetch(`${this.base ? `${this.base}/` : ""}rpc/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // status travels with the error so callers can tell "the server said no"
      // (4xx) from "couldn't reach it" (a TypeError from fetch, or a 5xx)
      const err = new Error(body.message ?? `crew server error on ${name}`);
      err.status = res.status;
      throw err;
    }
    return body.data;
  }
}

export async function makeAdapter() {
  const cfg = globalThis.PUSHPACT_CONFIG;
  // dev-only, and only ever on an explicit flag — config.js is gitignored, so
  // this branch cannot exist on the deployed site
  if (cfg?.devServer) return new HttpRpcAdapter("");
  if (cfg?.url && cfg?.anonKey) {
    try {
      const lib = await import("https://esm.sh/@supabase/supabase-js@2");
      const a = new SupabaseAdapter(cfg, lib);
      await a.init();
      return a;
    } catch (e) {
      console.warn("Supabase unavailable, falling back to solo mode", e);
    }
  }
  if (cfg?.solo) return new LocalAdapter();
  return new HttpRpcAdapter(cfg?.api ?? CREW_API);
}
