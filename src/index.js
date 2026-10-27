/**
 * Chakudya Gateway
 *
 *   /p/<api path>  public docs traffic. Allowlisted routes only; the docs site's consumer
 *                  key (DOCS_SITE_KEY) is attached here, never shipped to the browser.
 *   /a/<api path>  admin. Needs a Supabase login token whose verified email is in ADMIN_EMAILS.
 *                  GET on ADMIN_GET_PATHS; writes only for the allowlisted routes below and only
 *                  while ADMIN_WRITES=true. The root key (ADMIN_API_KEY) is attached here.
 *                  Writes: create/revoke keys, approve/reject packaged-food submissions.
 *                  Read-only viewers: RAG ingest jobs (/rag/jobs) and the FHIR audit log (/fhir/AuditEvent).
 */

// Public allowlist. Everything else is refused, including every /admin route.
const PUBLIC_GET_PREFIXES = [
  "/health", "/foods", "/glycaemic-index", "/exchange", "/renal", "/formulas", "/drug-interactions",
  "/activity-energy", "/energy/factors",
];
// Exact paths only. Calculators that read reference data and store nothing. Never a /bulk route.
const PUBLIC_POST_PATHS = [
  "/rag/ask", "/meals/analyze", "/memory/write", "/feedback",
  "/energy/requirements", "/energy/food-energy", "/activity-energy/calculate",
];
const MAX_BODY_BYTES = 16 * 1024;
const PUBLIC_CACHE_SECONDS = 60;

const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(status, body, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(origin ? corsHeaders(origin) : {}), ...extra },
  });
}

function pathOk(path) {
  return path.startsWith("/") && !path.includes("..") && !path.includes("//") && !path.includes("\\");
}

function underPrefix(path, prefix) {
  return path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?");
}

function callApi(env, path, search, init) {
  const target = (env.API_URL || "").replace(/\/$/, "") + path + search;
  const req = new Request(target, init);
  return env.API ? env.API.fetch(req) : fetch(req);
}

function relay(res, origin, extra = {}) {
  const h = new Headers();
  const type = res.headers.get("Content-Type");
  if (type) h.set("Content-Type", type);
  Object.entries({ ...corsHeaders(origin), ...extra }).forEach(([k, v]) => h.set(k, v));
  return new Response(res.body, { status: res.status, headers: h });
}

/* ───────── public ───────── */

// NutriMind server memory: a browser-made id like nm_k3j9x0abc12. Anything else (for example an
// Oasis patient session) is refused so the public site can never read or write another app's memory.
const NM_SESSION = /^nm_[a-z0-9]{12,40}$/;
const FEEDBACK_REASONS = ["", "inaccurate", "incomplete", "unclear", "other"];
const clip = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function readJson(request, origin) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: json(413, { error: "Request body too large." }, origin) };
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return { body };
  } catch (_) { /* fall through */ }
  return { error: json(400, { error: "Invalid JSON." }, origin) };
}

// POST /p/memory/write - one short fact about what a NutriMind visitor asked. Fields are rebuilt.
async function handleMemoryWrite(request, env, origin, headers) {
  const { body, error } = await readJson(request, origin);
  if (error) return error;
  const session_id = clip(body.session_id, 60);
  const content = clip(body.content, 300);
  if (!NM_SESSION.test(session_id) || !content) return json(400, { error: "Invalid memory entry." }, origin);
  const res = await callApi(env, "/memory/write", "", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ session_id, content, kind: "fact" }),
  });
  return relay(res, origin);
}

// POST /p/feedback - thumbs up/down on a NutriMind answer, saved to Supabase (insert-only).
async function handleFeedback(request, env, origin) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json(503, { error: "Feedback is not configured." }, origin);
  const { body, error } = await readJson(request, origin);
  if (error) return error;
  const row = {
    fid: clip(body.fid, 40),
    rating: clip(body.rating, 8),
    reason: clip(body.reason, 16),
    mode: clip(body.mode, 8) || "both",
    question: clip(body.question, 600),
    answer: clip(body.answer, 4000),
  };
  const ok = /^[a-z0-9]{8,40}$/.test(row.fid) && ["up", "down", "none"].includes(row.rating) &&
    FEEDBACK_REASONS.includes(row.reason) && ["both", "general", "clinical"].includes(row.mode) && row.question;
  if (!ok) return json(400, { error: "Invalid feedback." }, origin);
  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/nutrimind_feedback", {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) return json(502, { error: "Could not save feedback." }, origin);
  return json(201, { status: "success" }, origin);
}

async function handlePublic(request, env, apiPath, search, origin, ctx) {
  const method = request.method;
  const allowed =
    (method === "GET" && PUBLIC_GET_PREFIXES.some((p) => underPrefix(apiPath, p))) ||
    (method === "POST" && PUBLIC_POST_PATHS.includes(apiPath));
  if (!allowed) return json(403, { error: "Not available through the docs gateway." }, origin);

  if (env.PUBLIC_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.PUBLIC_LIMITER.limit({ key: ip });
    if (!success) return json(429, { error: "Too many requests. Please slow down." }, origin, { "Retry-After": "30" });
  }
  if (method === "POST" && apiPath === "/feedback") return handleFeedback(request, env, origin);
  if (!env.DOCS_SITE_KEY) return json(503, { error: "Gateway is not configured." }, origin);

  const headers = { Authorization: `Bearer ${env.DOCS_SITE_KEY}`, Accept: "application/json" };

  if (method === "GET") {
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(new URL("/p" + apiPath + search, "https://gateway.cache").toString());
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return relay(hit, origin, { "X-Gateway-Cache": "HIT" });
    }
    const res = await callApi(env, apiPath, search, { method: "GET", headers });
    if (cache && res.status === 200) {
      const copy = new Response(res.clone().body, {
        status: 200,
        headers: { "Content-Type": res.headers.get("Content-Type") || "application/json", "Cache-Control": `public, max-age=${PUBLIC_CACHE_SECONDS}` },
      });
      ctx.waitUntil(cache.put(cacheKey, copy));
    }
    return relay(res, origin, { "X-Gateway-Cache": "MISS" });
  }

  if (apiPath === "/memory/write") return handleMemoryWrite(request, env, origin, headers);

  let text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: "Request body too large." }, origin);
  if (apiPath === "/rag/ask") {
    // Only NutriMind session ids may reach /rag/ask, and top_k stays small.
    try {
      const b = JSON.parse(text);
      if (b && typeof b === "object") {
        if ("session_id" in b && !NM_SESSION.test(String(b.session_id))) delete b.session_id;
        if ("top_k" in b) b.top_k = Math.min(10, Math.max(1, parseInt(b.top_k, 10) || 6));
        text = JSON.stringify(b);
      }
    } catch (_) { return json(400, { error: "Invalid JSON." }, origin); }
  }
  headers["Content-Type"] = "application/json";
  const res = await callApi(env, apiPath, search, { method: "POST", headers, body: text });
  return relay(res, origin);
}

/* ───────── admin ───────── */

// The only writes the admin gateway will forward, and only while ADMIN_WRITES = "true".
// Each entry validates and rebuilds the body so nothing unexpected reaches the API.
const ADMIN_ROLES_CREATABLE = ["reviewer", "admin"];
const ADMIN_WRITE_ROUTES = [
  {
    method: "POST",
    re: /^\/admin\/keys$/,
    body(raw) {
      let p;
      try { p = JSON.parse(raw); } catch (_) { return { error: "Body must be JSON." }; }
      const label = typeof p?.label === "string" ? p.label.trim() : "";
      if (!label || label.length > 80) return { error: "Label is required (max 80 characters)." };
      if (!ADMIN_ROLES_CREATABLE.includes(p?.role)) return { error: "Role must be reviewer or admin." };
      return { json: JSON.stringify({ label, role: p.role }) };
    },
  },
  { method: "DELETE", re: /^\/admin\/keys\/\d+$/ },
  // Dismiss an ingest job record from the admin list (the API refuses jobs that may still be running).
  { method: "DELETE", re: /^\/rag\/jobs\/[0-9a-fA-F-]{36}$/ },
  // Packaged-food review queue. The root key has no identity of its own, so the verified
  // admin email is stamped into reviewed_by here; the browser cannot choose it.
  {
    method: "POST",
    re: /^\/packaged\/[A-Za-z0-9-]{1,64}\/approve$/,
    body(_raw, email) { return { json: JSON.stringify({ reviewed_by: email }) }; },
  },
  {
    method: "POST",
    re: /^\/packaged\/[A-Za-z0-9-]{1,64}\/reject$/,
    body(raw, email) {
      let p;
      try { p = JSON.parse(raw); } catch (_) { return { error: "Body must be JSON." }; }
      const reason = typeof p?.reason === "string" ? p.reason.trim() : "";
      if (!reason || reason.length > 300) return { error: "A reason is required (max 300 characters)." };
      return { json: JSON.stringify({ reason, reviewed_by: email }) };
    },
  },
];

async function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  let user;
  try {
    const r = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/user", {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    user = await r.json();
  } catch (_) { return null; }
  const email = String(user?.email || "").toLowerCase();
  const verified = Boolean(user?.email_confirmed_at || user?.confirmed_at);
  const admins = csv(env.ADMIN_EMAILS).map((e) => e.toLowerCase());
  return email && verified && admins.includes(email) ? email : null;
}

// Document upload for the RAG pipeline (POST /rag/upload on the API). The browser sends multipart; this rebuilds
// the form with only the fields the API reads, after checking type and size, so nothing unexpected is forwarded.
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_EXT = ["pdf", "docx", "txt", "md", "csv", "html"];
const UPLOAD_CONTEXTS = ["clinical", "general", "both"];

async function handleAdminUpload(request, env, email, origin, noStore) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > UPLOAD_MAX_BYTES + 1024 * 1024) return json(413, { error: "File too large (max 25 MB)." }, origin, noStore);
  if (!/^multipart\/form-data/i.test(request.headers.get("Content-Type") || "")) {
    return json(400, { error: "Send multipart/form-data with a 'file' field." }, origin, noStore);
  }
  let form;
  try { form = await request.formData(); } catch (_) { return json(400, { error: "Could not read the upload." }, origin, noStore); }
  const file = form.get("file");
  if (!file || typeof file === "string") return json(400, { error: "A 'file' field is required." }, origin, noStore);
  const ext = String(file.name || "").split(".").pop().toLowerCase();
  if (!UPLOAD_EXT.includes(ext)) return json(400, { error: `Unsupported file type. Allowed: ${UPLOAD_EXT.join(", ")}.` }, origin, noStore);
  if (file.size > UPLOAD_MAX_BYTES) return json(413, { error: "File too large (max 25 MB)." }, origin, noStore);
  if (file.size === 0) return json(400, { error: "The file is empty." }, origin, noStore);
  const context = String(form.get("context") || "both");
  if (!UPLOAD_CONTEXTS.includes(context)) return json(400, { error: "Context must be clinical, general or both." }, origin, noStore);
  const source = clip(form.get("source"), 200);
  const replace = ["true", "1", "yes"].includes(String(form.get("replace") || "").toLowerCase());

  const out = new FormData();
  out.set("file", file, file.name);
  out.set("context", context);
  if (source) out.set("source", source);
  if (replace) out.set("replace", "true");
  console.log(JSON.stringify({ admin: email, method: "POST", path: "/rag/upload", file: String(file.name).slice(0, 120), bytes: file.size }));
  // No Content-Type here: fetch sets the multipart boundary for the rebuilt form.
  const res = await callApi(env, "/rag/upload", "", { method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}`, Accept: "application/json" }, body: out });
  return relay(res, origin, noStore);
}

async function handleAdmin(request, env, apiPath, search, origin) {
  const noStore = { "Cache-Control": "no-store" };
  if (!env.ADMIN_API_KEY || !env.ADMIN_EMAILS) return json(503, { error: "Admin access is not configured." }, origin, noStore);
  const email = await verifyAdmin(request, env);
  if (!email) return json(401, { error: "Admin sign-in required." }, origin, noStore);

  if (request.method === "GET") {
    if (!csv(env.ADMIN_GET_PATHS).some((p) => underPrefix(apiPath, p))) {
      return json(403, { error: "Route not enabled for the admin gateway." }, origin, noStore);
    }
    const res = await callApi(env, apiPath, search, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.ADMIN_API_KEY}`, Accept: "application/json" },
    });
    return relay(res, origin, noStore);
  }

  // Writes: off unless ADMIN_WRITES = "true", and only the allowlisted routes.
  if (String(env.ADMIN_WRITES).toLowerCase() !== "true") {
    return json(403, { error: "Admin writes are switched off." }, origin, noStore);
  }
  if (request.method === "POST" && apiPath === "/rag/upload") return handleAdminUpload(request, env, email, origin, noStore);
  const route = ADMIN_WRITE_ROUTES.find((r) => r.method === request.method && r.re.test(apiPath));
  if (!route) return json(405, { error: "This admin action is not enabled." }, origin, noStore);

  const headers = { Authorization: `Bearer ${env.ADMIN_API_KEY}`, Accept: "application/json" };
  let body;
  if (route.body) {
    const raw = await request.text();
    if (raw.length > 4096) return json(413, { error: "Request body too large." }, origin, noStore);
    const checked = route.body(raw, email);
    if (checked.error) return json(400, { error: checked.error }, origin, noStore);
    body = checked.json;
    headers["Content-Type"] = "application/json";
  }
  // One log line per admin action (who, what). Never the body: it can hold a new key label only,
  // and the raw key is never seen by this Worker's code, only relayed back to the caller.
  console.log(JSON.stringify({ admin: email, method: request.method, path: apiPath }));
  const res = await callApi(env, apiPath, "", { method: request.method, headers, ...(body ? { body } : {}) });
  return relay(res, origin, noStore);
}

/* ───────── entry ───────── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origins = csv(env.ALLOWED_ORIGINS);
    const origin = request.headers.get("Origin") || "";
    const originOk = origins.includes(origin);

    if (url.pathname === "/") return json(200, { service: "chakudya-gateway", status: "ok" }, originOk ? origin : "");

    if (request.method === "OPTIONS") {
      return originOk ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 });
    }
    if (!originOk) return json(403, { error: "Origin not allowed." }, "");

    const mode = url.pathname.startsWith("/p/") ? "p" : url.pathname.startsWith("/a/") ? "a" : null;
    if (!mode) return json(404, { error: "Not found." }, origin);
    const apiPath = url.pathname.slice(2);
    if (!pathOk(apiPath)) return json(400, { error: "Bad path." }, origin);

    try {
      return mode === "p"
        ? await handlePublic(request, env, apiPath, url.search, origin, ctx)
        : await handleAdmin(request, env, apiPath, url.search, origin);
    } catch (_) {
      return json(502, { error: "Upstream error." }, origin);
    }
  },
};
