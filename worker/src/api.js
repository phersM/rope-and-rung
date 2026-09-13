// Rope & Rung crew API — Cloudflare Pages Functions over D1.
//
// Answers POST /rpc/<name> with the same eleven procedures, the same argument
// names and the same { data } / { message } envelope as supabase/schema.sql and
// serve-dev.py, so the app's RpcAdapter call sequence (data.js) is unchanged.
//
// This Worker is the only thing that can reach the database, which makes it
// the security boundary the Postgres SECURITY DEFINER functions used to be.
// Every procedure that touches a crew re-validates crew_code against crew_id,
// and against the profile or set involved, before reading or writing. Input is
// shape-checked first so nothing malformed ever reaches a query.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME = 40, MAX_AVATAR = 40, MAX_EXCUSE = 500, MAX_SETTINGS = 64 * 1024;
const MAX_BODY = 2 * 1024 * 1024;   // import_crew carries a whole solo history
const MAX_IMPORT = { profiles: 50, sets: 10000, statuses: 5000 };
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

class Denied extends Error {}

const now = () => new Date().toISOString();

// 256 % 32 = 0, so the modulo is exactly uniform
const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (n) => ALPHABET[n % 32]).join("");

// ---------- argument checks ----------
function str(a, key, { max, allowEmpty = false, nullable = false } = {}) {
  const v = a[key];
  if (nullable && (v === null || v === undefined)) return null;
  if (typeof v !== "string") throw new Denied(`missing argument '${key}'`);
  if (!allowEmpty && !v.trim()) throw new Denied(`empty argument '${key}'`);
  if (max && v.length > max) throw new Denied(`argument '${key}' too long`);
  return v;
}
const code = (a) => { const v = str(a, "p_code"); if (!CODE_RE.test(v)) throw new Denied("invalid crew code"); return v; };
const uuid = (a, key) => { const v = str(a, key); if (!UUID_RE.test(v)) throw new Denied(`invalid ${key}`); return v; };
const day = (a) => { const v = str(a, "p_day"); if (!DAY_RE.test(v)) throw new Denied("invalid p_day"); return v; };
const kind = (a) => { const v = str(a, "p_kind"); if (v !== "rest" && v !== "excuse") throw new Denied("invalid p_kind"); return v; };
function reps(a) {
  const v = a.p_reps;
  if (!Number.isInteger(v) || v === 0 || v < -500 || v > 500) throw new Denied("invalid p_reps");
  return v;
}
function settings(a) {
  const v = a.p_settings;
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Denied("invalid p_settings");
  const json = JSON.stringify(v);
  if (json.length > MAX_SETTINGS) throw new Denied("p_settings too large");
  return json;
}

// ---------- row shaping ----------
const crewOut = (c) => c && { ...c, settings: JSON.parse(c.settings) };

// ---------- the guards (the schema's `if not exists ... raise`) ----------
async function crewFor(db, a) {
  const c = await db.prepare("SELECT * FROM crews WHERE id = ?1 AND crew_code = ?2")
    .bind(uuid(a, "p_crew_id"), code(a)).first();
  if (!c) throw new Denied("invalid crew code");
  return c;
}
async function profileInCrew(db, a) {
  const ok = await db.prepare(
    `SELECT p.id FROM profiles p JOIN crews c ON c.id = p.crew_id
      WHERE c.id = ?1 AND c.crew_code = ?2 AND p.id = ?3`)
    .bind(uuid(a, "p_crew_id"), code(a), uuid(a, "p_profile_id")).first();
  if (!ok) throw new Denied("invalid crew code or profile");
}

// ---------- procedures ----------
const PROCEDURES = {
  async find_crew(db, a) {
    const v = str(a, "p_code");
    if (!CODE_RE.test(v)) return null;  // not a code at all: same answer as a miss
    return crewOut(await db.prepare("SELECT * FROM crews WHERE crew_code = ?1").bind(v).first());
  },

  // Takes no code: the server picks it, so a client cannot choose a weak one.
  // A collision is ~1 in 1.1e12; the retry means even then the answer is a
  // different NEW crew, never somebody else's.
  async create_crew(db, a) {
    const s = settings(a);
    for (let attempt = 0; attempt < 5; attempt++) {
      const crew = { id: crypto.randomUUID(), name: "The Climb", crew_code: newCode(), settings: s, created_at: now() };
      try {
        await db.prepare("INSERT INTO crews (id, name, crew_code, settings, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
          .bind(crew.id, crew.name, crew.crew_code, crew.settings, crew.created_at).run();
        return crewOut(crew);
      } catch (e) {
        if (!String(e.message).includes("UNIQUE")) throw e;
      }
    }
    throw new Denied("could not allocate a crew code");
  },

  // Brings a phone's solo history (LocalAdapter, from the months there was no
  // crew database) into a NEW shared crew — the promise the onboarding copy
  // makes: "they'll come with you when crews come back".
  //
  // Only ever creates. Like create_crew it takes no code and hands back a fresh
  // server-generated one, so it cannot reach into an existing crew. Row ids are
  // kept (the phone's saved session points at them), and a clash with any
  // existing row fails the whole batch rather than overwriting it. Timestamps
  // are kept too: the achievements are computed from them (White Knuckle is a
  // start after 10:45pm), so replaying the sets through add_set would stamp
  // every one "now" and hand out the wrong marks.
  async import_crew(db, a) {
    const c = a.p_crew;
    if (!c || typeof c !== "object") throw new Denied("invalid p_crew");
    const crewId = uuid(c, "id");
    const crewSettings = settings({ p_settings: c.settings ?? {} });
    const crewName = typeof c.name === "string" && c.name.trim() ? str(c, "name", { max: MAX_NAME }) : "The Climb";
    const stamp = (v) => (typeof v === "string" && STAMP_RE.test(v) ? v : now());
    const list = (key, max) => {
      const v = a[key] ?? [];
      if (!Array.isArray(v) || v.length > max) throw new Denied(`invalid ${key}`);
      return v;
    };
    const profiles = list("p_profiles", MAX_IMPORT.profiles).map((p) => ({
      id: uuid(p, "id"), crew_id: crewId, name: str(p, "name", { max: MAX_NAME }),
      avatar: str(p, "avatar", { max: MAX_AVATAR }), created_at: stamp(p.created_at),
    }));
    if (!profiles.length) throw new Denied("nothing to import");
    const pids = new Set(profiles.map((p) => p.id));
    const owned = (r) => { const id = uuid(r, "profile_id"); if (!pids.has(id)) throw new Denied("row outside the crew"); return id; };
    const sets = list("p_sets", MAX_IMPORT.sets).map((r) => ({
      id: uuid(r, "id"), profile_id: owned(r), day: day({ p_day: r.day }), reps: reps({ p_reps: r.reps }),
      logged_at: stamp(r.logged_at),
    }));
    const statuses = list("p_statuses", MAX_IMPORT.statuses).map((r) => ({
      id: uuid(r, "id"), profile_id: owned(r), day: day({ p_day: r.day }), kind: kind({ p_kind: r.kind }),
      excuse_text: str({ e: r.excuse_text }, "e", { max: MAX_EXCUSE, allowEmpty: true, nullable: true }),
      created_at: stamp(r.created_at),
    }));
    // a solo phone can hold the same (profile, day, kind) twice; the table can't
    const seen = new Set();
    const uniqueStatuses = statuses.filter((r) => {
      const k = `${r.profile_id}|${r.day}|${r.kind}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });

    const fromJson = (cols) => cols.map((col) => `json_extract(value, '$.${col}')`).join(", ");
    for (let attempt = 0; attempt < 5; attempt++) {
      const crew = { id: crewId, name: crewName, crew_code: newCode(), settings: crewSettings, created_at: stamp(c.created_at) };
      try {
        // one batch = one transaction: all of it lands, or none of it does
        await db.batch([
          db.prepare("INSERT INTO crews (id, name, crew_code, settings, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
            .bind(crew.id, crew.name, crew.crew_code, crew.settings, crew.created_at),
          db.prepare(`INSERT INTO profiles (id, crew_id, name, avatar, created_at)
                      SELECT ${fromJson(["id", "crew_id", "name", "avatar", "created_at"])} FROM json_each(?1)`)
            .bind(JSON.stringify(profiles)),
          db.prepare(`INSERT INTO sets (id, profile_id, day, reps, logged_at)
                      SELECT ${fromJson(["id", "profile_id", "day", "reps", "logged_at"])} FROM json_each(?1)`)
            .bind(JSON.stringify(sets)),
          db.prepare(`INSERT INTO day_status (id, profile_id, day, kind, excuse_text, created_at)
                      SELECT ${fromJson(["id", "profile_id", "day", "kind", "excuse_text", "created_at"])} FROM json_each(?1)`)
            .bind(JSON.stringify(uniqueStatuses)),
        ]);
        return crewOut(crew);
      } catch (e) {
        const msg = String(e.message);
        if (msg.includes("crew_code")) continue;               // code collision: new code, try again
        if (msg.includes("UNIQUE") || msg.includes("PRIMARY")) throw new Denied("already imported");
        throw e;
      }
    }
    throw new Denied("could not allocate a crew code");
  },

  async crew_profiles(db, a) {
    await crewFor(db, a);
    const { results } = await db.prepare("SELECT * FROM profiles WHERE crew_id = ?1 ORDER BY created_at")
      .bind(a.p_crew_id).all();
    return results;
  },

  async create_profile(db, a) {
    await crewFor(db, a);
    const p = {
      id: crypto.randomUUID(), crew_id: a.p_crew_id,
      name: str(a, "p_name", { max: MAX_NAME }), avatar: str(a, "p_avatar", { max: MAX_AVATAR }),
      created_at: now(),
    };
    await db.prepare("INSERT INTO profiles (id, crew_id, name, avatar, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(p.id, p.crew_id, p.name, p.avatar, p.created_at).run();
    return p;
  },

  async update_profile(db, a) {
    await profileInCrew(db, a);
    const name = str(a, "p_name", { max: MAX_NAME }), avatar = str(a, "p_avatar", { max: MAX_AVATAR });
    return db.prepare("UPDATE profiles SET name = ?1, avatar = ?2 WHERE id = ?3 RETURNING *")
      .bind(name, avatar, a.p_profile_id).first();
  },

  async crew_bundle(db, a) {
    const crew = await crewFor(db, a);
    const id = a.p_crew_id;
    const [profiles, sets, statuses] = await db.batch([
      db.prepare("SELECT * FROM profiles WHERE crew_id = ?1 ORDER BY created_at").bind(id),
      db.prepare("SELECT s.* FROM sets s JOIN profiles p ON p.id = s.profile_id WHERE p.crew_id = ?1").bind(id),
      db.prepare("SELECT d.* FROM day_status d JOIN profiles p ON p.id = d.profile_id WHERE p.crew_id = ?1").bind(id),
    ]);
    return { crew: crewOut(crew), profiles: profiles.results, sets: sets.results, statuses: statuses.results };
  },

  async add_set(db, a) {
    await profileInCrew(db, a);
    const row = { id: crypto.randomUUID(), profile_id: a.p_profile_id, day: day(a), reps: reps(a), logged_at: now() };
    await db.prepare("INSERT INTO sets (id, profile_id, day, reps, logged_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(row.id, row.profile_id, row.day, row.reps, row.logged_at).run();
    return row;
  },

  async add_status(db, a) {
    await profileInCrew(db, a);
    const excuse = str(a, "p_excuse_text", { max: MAX_EXCUSE, allowEmpty: true, nullable: true });
    return db.prepare(
      `INSERT INTO day_status (id, profile_id, day, kind, excuse_text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (profile_id, day, kind) DO UPDATE SET excuse_text = excluded.excuse_text
       RETURNING *`)
      .bind(crypto.randomUUID(), a.p_profile_id, day(a), kind(a), excuse, now()).first();
  },

  async remove_set(db, a) {
    const hit = await db.prepare(
      `SELECT s.id FROM sets s JOIN profiles p ON p.id = s.profile_id JOIN crews c ON c.id = p.crew_id
        WHERE c.id = ?1 AND c.crew_code = ?2 AND s.id = ?3`)
      .bind(uuid(a, "p_crew_id"), code(a), uuid(a, "p_set_id")).first();
    if (!hit) throw new Denied("invalid crew code or set");
    await db.prepare("DELETE FROM sets WHERE id = ?1").bind(a.p_set_id).run();
    return null;
  },

  async remove_status(db, a) {
    await profileInCrew(db, a);
    await db.prepare("DELETE FROM day_status WHERE profile_id = ?1 AND day = ?2 AND kind = ?3")
      .bind(a.p_profile_id, day(a), kind(a)).run();
    return null;
  },

  async save_settings(db, a) {
    await crewFor(db, a);
    const s = settings(a);
    const name = typeof a.p_name === "string" && a.p_name.trim() ? str(a, "p_name", { max: MAX_NAME }) : null;
    return crewOut(await db.prepare(
      "UPDATE crews SET settings = ?1, name = COALESCE(?2, name) WHERE id = ?3 RETURNING *")
      .bind(s, name, a.p_crew_id).first());
  },
};

// The calls that need no credential. Pages Functions have no rate-limit
// binding, so OPEN_CALLS is optional and absent today. Guessing is still not a
// search: a code is one of ~1.1e12, and the free plan's 100,000 function calls
// a day is a hard ceiling on how fast anyone can try.
const OPEN = new Set(["find_crew", "create_crew", "import_crew"]);

// ---------- HTTP ----------
function cors(req, env) {
  const origin = req.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const h = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
              "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (origin && allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (status, payload, headers) =>
  new Response(JSON.stringify(payload), { status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handle(req, env) {
  {
    const headers = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(req.url);
    if (req.method !== "POST" || !url.pathname.startsWith("/rpc/")) return json(404, { message: "not found" }, headers);

    const name = url.pathname.slice("/rpc/".length).replace(/\/+$/, "");
    const fn = Object.hasOwn(PROCEDURES, name) ? PROCEDURES[name] : null;
    if (!fn) return json(404, { message: `no procedure ${name}` }, headers);

    if (OPEN.has(name) && env.OPEN_CALLS) {
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.OPEN_CALLS.limit({ key: ip });
      if (!success) return json(429, { message: "too many attempts, wait a minute" }, headers);
    }

    let args;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY) return json(413, { message: "request too large" }, headers);
      args = text ? JSON.parse(text) : {};
      if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error();
    } catch {
      return json(400, { message: "bad request body" }, headers);
    }

    try {
      return json(200, { data: await fn(env.DB, args) }, headers);
    } catch (e) {
      if (e instanceof Denied) return json(400, { message: e.message }, headers);
      console.error(`rpc ${name} failed`, e);
      return json(500, { message: "server error" }, headers);
    }
  }
}
