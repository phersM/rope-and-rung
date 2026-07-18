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

export class SupabaseAdapter {
  constructor(cfg, supabaseLib) {
    this.cfg = cfg; this.lib = supabaseLib; this.shared = true; this.client = null;
  }
  async init() {
    this.client = this.lib.createClient(this.cfg.url, this.cfg.anonKey);
  }
  async findCrew(code) {
    const { data, error } = await this.client.from("crews").select("*").eq("crew_code", code).maybeSingle();
    if (error) throw error;
    return data;
  }
  async createCrew(code, defaults) {
    const { data, error } = await this.client.from("crews")
      .insert({ name: "The Pact", crew_code: code, settings: defaults }).select().single();
    if (error) throw error;
    return data;
  }
  async listProfiles(crewId) {
    const { data, error } = await this.client.from("profiles").select("*").eq("crew_id", crewId).order("created_at");
    if (error) throw error;
    return data;
  }
  async createProfile(crewId, name, avatar) {
    const { data, error } = await this.client.from("profiles")
      .insert({ crew_id: crewId, name, avatar }).select().single();
    if (error) throw error;
    return data;
  }
  async fetchAll(crewId) {
    const [{ data: crew }, { data: profiles }] = await Promise.all([
      this.client.from("crews").select("*").eq("id", crewId).single(),
      this.client.from("profiles").select("*").eq("crew_id", crewId).order("created_at"),
    ]);
    const pids = (profiles ?? []).map((p) => p.id);
    const [{ data: sets }, { data: statuses }] = await Promise.all([
      this.client.from("sets").select("*").in("profile_id", pids),
      this.client.from("day_status").select("*").in("profile_id", pids),
    ]);
    return { crew, profiles: profiles ?? [], sets: sets ?? [], statuses: statuses ?? [] };
  }
  async addSet(profileId, day, reps) {
    const { error } = await this.client.from("sets").insert({ profile_id: profileId, day, reps });
    if (error) throw error;
  }
  async addStatus(row) {
    const { error } = await this.client.from("day_status").insert(row);
    if (error) throw error;
  }
  async removeSet(setId) {
    const { error } = await this.client.from("sets").delete().eq("id", setId);
    if (error) throw error;
  }
  async removeStatus(profileId, day, kind) {
    const { error } = await this.client.from("day_status").delete()
      .eq("profile_id", profileId).eq("day", day).eq("kind", kind);
    if (error) throw error;
  }
  async saveSettings(crewId, settings, name) {
    const patch = { settings }; if (name) patch.name = name;
    const { error } = await this.client.from("crews").update(patch).eq("id", crewId);
    if (error) throw error;
  }
  subscribe(crewId, cb) {
    const ch = this.client.channel("pushpact")
      .on("postgres_changes", { event: "*", schema: "public", table: "sets" }, cb)
      .on("postgres_changes", { event: "*", schema: "public", table: "day_status" }, cb)
      .on("postgres_changes", { event: "*", schema: "public", table: "crews" }, cb)
      .subscribe();
    return () => this.client.removeChannel(ch);
  }
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
