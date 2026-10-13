// Tiny relay: the Windows client long-polls /api/poll, the web page POSTs /api/press.
// The client also POSTs /api/ready when it sees the Accept button, which sends a
// web push to every browser subscribed with that client ID.
// The client-generated ID is the only credential, so it must be long and random.
const http = require("http");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const POLL_HOLD_MS = 20000; // how long a poll request is held open
const ONLINE_WINDOW_MS = 35000; // client counts as online if it polled this recently
const READY_WINDOW_MS = 30000; // page shows "match ready" for this long
const MAX_SUBS_PER_ID = 10;
const ID_RE = /^[a-f0-9]{32,64}$/;

// --- Persistent state: VAPID keys and push subscriptions ---

fs.mkdirSync(DATA_DIR, { recursive: true });
const vapidFile = path.join(DATA_DIR, "vapid.json");
const subsFile = path.join(DATA_DIR, "subs.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

let vapid = readJson(vapidFile, null);
if (!vapid) {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidFile, JSON.stringify(vapid));
}
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:noreply@example.com",
  vapid.publicKey,
  vapid.privateKey
);

// id -> [subscription, ...]
const subs = new Map(Object.entries(readJson(subsFile, {})));
function saveSubs() {
  fs.writeFile(subsFile, JSON.stringify(Object.fromEntries(subs)), () => {});
}

// --- In-memory client state ---

// id -> { waiter: res | null, pending: number, lastSeen: ms, readyAt: ms }
const clients = new Map();

function getClient(id) {
  let c = clients.get(id);
  if (!c) {
    c = { waiter: null, pending: 0, lastSeen: 0, readyAt: 0 };
    clients.set(id, c);
  }
  return c;
}

function isOnline(c) {
  return !!c && (c.waiter !== null || Date.now() - c.lastSeen < ONLINE_WINDOW_MS);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 8192) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function cleanId(raw) {
  const id = String(raw || "").trim().toLowerCase();
  return ID_RE.test(id) ? id : null;
}

// Simple per-IP limiter for the web endpoints to slow down ID guessing.
const hits = new Map();
function rateLimited(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const h = hits.get(ip) || { count: 0, start: now };
  if (now - h.start > 60000) {
    h.count = 0;
    h.start = now;
  }
  h.count++;
  hits.set(ip, h);
  return h.count > 120;
}

async function notifyReady(id) {
  const list = subs.get(id) || [];
  if (!list.length) return 0;
  const payload = JSON.stringify({ title: "Match ready!", body: "Tap Accept to press Enter.", id });
  const alive = [];
  await Promise.all(
    list.map((s) =>
      webpush.sendNotification(s, payload, { TTL: 30, urgency: "high" }).then(
        () => alive.push(s),
        (err) => {
          // 404/410 means the browser dropped the subscription.
          if (err.statusCode !== 404 && err.statusCode !== 410) {
            alive.push(s);
            console.error("push failed:", err.statusCode, err.body);
          }
        }
      )
    )
  );
  if (alive.length !== list.length) {
    if (alive.length) subs.set(id, alive);
    else subs.delete(id);
    saveSubs();
  }
  return alive.length;
}

// --- Static files ---

const staticFiles = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/sw.js": ["sw.js", "text/javascript"],
  "/manifest.json": ["manifest.json", "application/manifest+json"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/setup": ["setup.html", "text/html; charset=utf-8"],
  "/client.zip": ["client.zip", "application/zip"], // built by the Dockerfile
};
const staticCache = {};
for (const [route, [file, type]] of Object.entries(staticFiles)) {
  const p = path.join(__dirname, "public", file);
  if (fs.existsSync(p)) staticCache[route] = { body: fs.readFileSync(p), type };
}

// --- Routes ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "GET" && staticCache[url.pathname]) {
    const f = staticCache[url.pathname];
    res.writeHead(200, { "Content-Type": f.type, "Cache-Control": "no-cache" });
    return res.end(f.body);
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true });
  }

  // Windows client: wait for presses.
  if (req.method === "GET" && url.pathname === "/api/poll") {
    const id = cleanId(url.searchParams.get("id"));
    if (!id) return json(res, 400, { error: "bad id" });

    const c = getClient(id);
    c.lastSeen = Date.now();

    if (c.pending > 0) {
      const n = c.pending;
      c.pending = 0;
      return json(res, 200, { press: n });
    }

    // Only one poller per ID; a newer one replaces the old.
    if (c.waiter) json(c.waiter, 200, { press: 0 });
    c.waiter = res;

    const timer = setTimeout(() => {
      if (c.waiter === res) {
        c.waiter = null;
        c.lastSeen = Date.now();
        json(res, 200, { press: 0 });
      }
    }, POLL_HOLD_MS);

    res.on("close", () => {
      clearTimeout(timer);
      if (c.waiter === res) c.waiter = null;
    });
    return;
  }

  // Windows client: the Accept button is on screen.
  if (req.method === "POST" && url.pathname === "/api/ready") {
    const id = cleanId((await readBody(req)).id);
    if (!id) return json(res, 400, { error: "bad id" });
    const c = getClient(id);
    c.lastSeen = Date.now();
    if (Date.now() - c.readyAt < 20000) return json(res, 200, { ok: true, sent: 0 });
    c.readyAt = Date.now();
    const sent = await notifyReady(id);
    console.log(`ready: notified ${sent} browser(s)`);
    return json(res, 200, { ok: true, sent });
  }

  // Web page: press Enter.
  if (req.method === "POST" && url.pathname === "/api/press") {
    if (rateLimited(req)) return json(res, 429, { error: "slow down" });
    const id = cleanId((await readBody(req)).id);
    if (!id) return json(res, 400, { error: "Invalid ID format" });

    const c = clients.get(id);
    if (!isOnline(c)) return json(res, 404, { error: "No client online with that ID" });

    c.readyAt = 0;
    if (c.waiter) {
      const w = c.waiter;
      c.waiter = null;
      c.lastSeen = Date.now();
      json(w, 200, { press: 1 });
    } else {
      // Client is between polls; deliver on its next poll.
      c.pending++;
    }
    return json(res, 200, { ok: true });
  }

  // Web page: is the client connected, and is a match waiting?
  if (req.method === "GET" && url.pathname === "/api/status") {
    if (rateLimited(req)) return json(res, 429, { error: "slow down" });
    const id = cleanId(url.searchParams.get("id"));
    if (!id) return json(res, 400, { error: "Invalid ID format" });
    const c = clients.get(id);
    return json(res, 200, {
      online: isOnline(c),
      ready: !!c && Date.now() - c.readyAt < READY_WINDOW_MS,
    });
  }

  // Web page: push setup.
  if (req.method === "GET" && url.pathname === "/api/vapid") {
    return json(res, 200, { publicKey: vapid.publicKey });
  }

  if (req.method === "POST" && url.pathname === "/api/subscribe") {
    if (rateLimited(req)) return json(res, 429, { error: "slow down" });
    const body = await readBody(req);
    const id = cleanId(body.id);
    const sub = body.subscription;
    if (!id) return json(res, 400, { error: "Invalid ID format" });
    if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys) {
      return json(res, 400, { error: "bad subscription" });
    }
    const list = (subs.get(id) || []).filter((s) => s.endpoint !== sub.endpoint);
    list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    subs.set(id, list.slice(-MAX_SUBS_PER_ID));
    saveSubs();
    return json(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("Not found");
});

// Drop clients that went away so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (!c.waiter && now - c.lastSeen > 10 * 60000) clients.delete(id);
  }
  for (const [ip, h] of hits) {
    if (now - h.start > 60000) hits.delete(ip);
  }
}, 60000).unref();

server.listen(PORT, () => console.log(`Listening on :${PORT}`));
