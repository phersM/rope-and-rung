// Push Pact — data layer. Two adapters behind one interface:
//   LocalAdapter    — localStorage only (solo mode, works before Supabase is wired)
//   SupabaseAdapter — shared crew database (window.PUSHPACT_CONFIG = {url, anonKey} in config.js)
//
// Interface: init(), findCrew(code), createCrew(code), listProfiles(crewId),
// createProfile(crewId,name,avatar), fetchAll(crewId) -> {sets,statuses,settings,crew},
// addSet(profileId,day,reps), addStatus(row), removeStatus(profileId,day,kind),
// saveSettings(crewId,settings,name), subscribe(crewId,cb)

const uid = () => crypto.randomUUID();

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
  async createCrew(code, defaults) {
    const db = this._db();
    const crew = { id: uid(), name: "The Pact", crew_code: code, settings: defaults };
    db.crews.push(crew); this._save(db); return crew;
  }
  async listProfiles(crewId) { return this._db().profiles.filter((p) => p.crew_id === crewId); }
  async createProfile(crewId, name, avatar) {
    const db = this._db();
    const p = { id: uid(), crew_id: crewId, name, avatar, created_at: new Date().toISOString() };
    db.profiles.push(p); this._save(db); return p;
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
  subscribe() { return () => {}; }
}

// All reads/writes go through SECURITY DEFINER Postgres functions (see
// supabase/schema.sql) that re-validate crew_code against crew_id on every
// call — anon has zero direct table grants. This adapter keeps this.code /
// this.crewId from the join step and threads them into every RPC so no
// caller in app.js needs to change.
export class SupabaseAdapter {
  constructor(cfg, supabaseLib) {
    this.cfg = cfg; this.lib = supabaseLib; this.shared = true; this.client = null;
    this.code = null; this.crewId = null;
  }
  async init() {
    this.client = this.lib.createClient(this.cfg.url, this.cfg.anonKey);
  }
  async findCrew(code) {
    const { data, error } = await this.client.rpc("find_crew", { p_code: code });
    if (error) throw error;
    if (data) { this.code = code; this.crewId = data.id; }
    return data;
  }
  async createCrew(code, defaults) {
    const { data, error } = await this.client.rpc("create_crew", { p_code: code, p_settings: defaults });
    if (error) throw error;
    this.code = code; this.crewId = data.id;
    return data;
  }
  async listProfiles(crewId) {
    const { data, error } = await this.client.rpc("crew_profiles", { p_code: this.code, p_crew_id: crewId });
    if (error) throw error;
    return data ?? [];
  }
  async createProfile(crewId, name, avatar) {
    const { data, error } = await this.client.rpc("create_profile",
      { p_code: this.code, p_crew_id: crewId, p_name: name, p_avatar: avatar });
    if (error) throw error;
    return data;
  }
  async fetchAll(crewId) {
    const { data, error } = await this.client.rpc("crew_bundle", { p_code: this.code, p_crew_id: crewId });
    if (error) throw error;
    return { crew: data.crew, profiles: data.profiles ?? [], sets: data.sets ?? [], statuses: data.statuses ?? [] };
  }
  async addSet(profileId, day, reps) {
    const { error } = await this.client.rpc("add_set",
      { p_code: this.code, p_crew_id: this.crewId, p_profile_id: profileId, p_day: day, p_reps: reps });
    if (error) throw error;
  }
  async addStatus(row) {
    const { error } = await this.client.rpc("add_status", {
      p_code: this.code, p_crew_id: this.crewId, p_profile_id: row.profile_id,
      p_day: row.day, p_kind: row.kind, p_excuse_text: row.excuse_text ?? null,
    });
    if (error) throw error;
  }
  async removeSet(setId) {
    const { error } = await this.client.rpc("remove_set",
      { p_code: this.code, p_crew_id: this.crewId, p_set_id: setId });
    if (error) throw error;
  }
  async removeStatus(profileId, day, kind) {
    const { error } = await this.client.rpc("remove_status",
      { p_code: this.code, p_crew_id: this.crewId, p_profile_id: profileId, p_day: day, p_kind: kind });
    if (error) throw error;
  }
  async saveSettings(crewId, settings, name) {
    const { error } = await this.client.rpc("save_settings",
      { p_code: this.code, p_crew_id: crewId, p_settings: settings, p_name: name ?? "" });
    if (error) throw error;
  }
  // Realtime intentionally not wired — see schema.sql note. Falls back to
  // the app's existing refetch-after-mutation + refetch-on-focus behaviour.
  subscribe() { return () => {}; }
}

export async function makeAdapter() {
  const cfg = globalThis.PUSHPACT_CONFIG;
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
  return new LocalAdapter();
}
