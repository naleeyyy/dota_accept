// Tiny relay: the Windows client long-polls /api/poll, the web page POSTs /api/press.
// The client-generated ID is the only credential, so it must be long and random.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const POLL_HOLD_MS = 20000; // how long a poll request is held open
const ONLINE_WINDOW_MS = 35000; // client counts as online if it polled this recently
const ID_RE = /^[a-f0-9]{32,64}$/;

// id -> { waiter: res | null, pending: number, lastSeen: ms }
const clients = new Map();

function getClient(id) {
  let c = clients.get(id);
  if (!c) {
    c = { waiter: null, pending: 0, lastSeen: 0 };
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
      if (data.length > 1024) req.destroy();
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

// Simple per-IP limiter for the press/status endpoints to slow down ID guessing.
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

const indexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(indexHtml);
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true });
  }

  // Windows client: wait for presses.
  if (req.method === "GET" && url.pathname === "/api/poll") {
    const id = (url.searchParams.get("id") || "").toLowerCase();
    if (!ID_RE.test(id)) return json(res, 400, { error: "bad id" });

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

  // Web page: press Enter.
  if (req.method === "POST" && url.pathname === "/api/press") {
    if (rateLimited(req)) return json(res, 429, { error: "slow down" });
    const { id: rawId } = await readBody(req);
    const id = String(rawId || "").trim().toLowerCase();
    if (!ID_RE.test(id)) return json(res, 400, { error: "Invalid ID format" });

    const c = clients.get(id);
    if (!isOnline(c)) return json(res, 404, { error: "No client online with that ID" });

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

  // Web page: is the client connected?
  if (req.method === "GET" && url.pathname === "/api/status") {
    if (rateLimited(req)) return json(res, 429, { error: "slow down" });
    const id = (url.searchParams.get("id") || "").trim().toLowerCase();
    if (!ID_RE.test(id)) return json(res, 400, { error: "Invalid ID format" });
    return json(res, 200, { online: isOnline(clients.get(id)) });
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
