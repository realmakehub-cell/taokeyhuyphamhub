// HUY PHAM HUB Key API — Node.js 18+ + Express
// Giữ nguyên /api/verify và /api/admin/keys. Thêm luồng "vượt link mới nhận key":
//   POST /api/getkey/start  -> tạo phiên, trả link vượt (rút gọn) có token ẩn bên trong
//   POST /api/getkey/claim  -> người chơi quay lại từ link vượt, server cấp key 1 lần
//
// ENV:
//   ADMIN_SECRET        bắt buộc cho /api/admin/keys
//   PUBLIC_URL          URL HTTPS công khai của server, vd https://key.example.com
//   SHORTENER_TEMPLATE  URL API của dịch vụ rút gọn, chỗ đích thay bằng {URL}
//                       vd https://provider.example/api?api=API_KEY&url={URL}&format=text
//   DEV_SKIP_SHORTENER  =1 để test: bỏ qua link rút gọn, trả thẳng link nhận key
//   KEY_PREFIX (HUYPHAM) KEY_HOURS (24) KEY_COOLDOWN_HOURS (24) MIN_SECONDS (20)
//   IP_LOCK (=0 để tắt)  TRUST_PROXY (=1 khi chạy sau nginx/Cloudflare/host proxy)
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const DB_FILE = path.join(__dirname, "keys.json");
const HOURS_DEFAULT = 24;

const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHORTENER_TEMPLATE = process.env.SHORTENER_TEMPLATE || "";
const DEV_SKIP_SHORTENER = process.env.DEV_SKIP_SHORTENER === "1";
const cleanPrefix = p => String(p || "HUYPHAM").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) || "HUYPHAM";
const KEY_PREFIX = cleanPrefix(process.env.KEY_PREFIX);
const KEY_HOURS = Math.max(1, Math.min(720, Number(process.env.KEY_HOURS) || HOURS_DEFAULT));
const COOLDOWN_HOURS = process.env.KEY_COOLDOWN_HOURS === undefined ? 24 : Math.max(0, Number(process.env.KEY_COOLDOWN_HOURS) || 0);
const MIN_SECONDS = process.env.MIN_SECONDS === undefined ? 20 : Math.max(0, Number(process.env.MIN_SECONDS) || 0);
const IP_LOCK = process.env.IP_LOCK !== "0";
const SESSION_TTL_MS = 30 * 60 * 1000;      // phải quay lại trong 30 phút
const RESHOW_TTL_MS = 24 * 60 * 60 * 1000;  // F5 vẫn thấy lại key trong 24h

function readDb() {
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { db = {}; }
  db.keys = db.keys || {};
  db.sessions = db.sessions || {};
  db.claims = db.claims || {};
  return db;
}
function writeDb(db) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}
function normalizeKey(key) {
  return typeof key === "string" ? key.trim().toUpperCase() : "";
}
function part() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function makeKeys(db, prefix, count, hours) {
  const created = [];
  for (let i = 0; i < count; i++) {
    let key;
    do { key = `${prefix}-${part()}-${part()}-${part()}`; } while (db.keys[key]);
    db.keys[key] = { createdAt: null, expiresAt: null, durationHours: hours, status: "unused" };
    created.push(key);
  }
  return created;
}
const ipHash = req => crypto.createHash("sha256").update(String(req.ip || "")).digest("hex").slice(0, 32);
function prune(db) {
  const now = Date.now();
  for (const [t, s] of Object.entries(db.sessions)) if (now - s.createdAt > RESHOW_TTL_MS) delete db.sessions[t];
  const keep = Math.max(COOLDOWN_HOURS, 1) * 3600e3;
  for (const [h, at] of Object.entries(db.claims)) if (now - at > keep) delete db.claims[h];
}

// Giới hạn số lần bấm "Bắt đầu" để không bị spam API rút gọn: 5 lần/giờ/IP.
const startLog = new Map();
setInterval(() => startLog.clear(), 3600e3).unref();
function tooManyStarts(h) {
  const now = Date.now();
  const arr = (startLog.get(h) || []).filter(t => now - t < 3600e3);
  if (arr.length >= 5) { startLog.set(h, arr); return true; }
  arr.push(now); startLog.set(h, arr);
  return false;
}

async function shorten(dest) {
  if (DEV_SKIP_SHORTENER) return dest;
  if (!SHORTENER_TEMPLATE) throw new Error("SHORTENER_TEMPLATE chưa được đặt");
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(SHORTENER_TEMPLATE.replace("{URL}", encodeURIComponent(dest)), { signal: ctrl.signal });
    const text = (await r.text()).trim();
    let out = text;
    try {
      const j = JSON.parse(text);
      out = j.shortenedUrl || j.shortlink || j.short_url || j.url || (j.data && (j.data.shortenedUrl || j.data.short_url || j.data.url)) || "";
    } catch {}
    if (!r.ok || !/^https?:\/\//i.test(out)) throw new Error("Phản hồi rút gọn không hợp lệ: " + text.slice(0, 120));
    return out;
  } finally { clearTimeout(to); }
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "Huy Pham Hub Key API" }));

// ---------- Lấy key qua link vượt ----------
app.post("/api/getkey/start", async (req, res) => {
  const h = ipHash(req);
  const now = Date.now();
  const last = readDb().claims[h];
  if (COOLDOWN_HOURS > 0 && last && now - last < COOLDOWN_HOURS * 3600e3) {
    const waitMs = COOLDOWN_HOURS * 3600e3 - (now - last);
    return res.status(429).json({ ok: false, error: `Bạn đã nhận key gần đây. Thử lại sau ${Math.ceil(waitMs / 60000)} phút.` });
  }
  if (tooManyStarts(h)) return res.status(429).json({ ok: false, error: "Bạn thử quá nhiều lần. Chờ một lát rồi thử lại." });
  if (!PUBLIC_URL) return res.status(503).json({ ok: false, error: "Server chưa cấu hình PUBLIC_URL." });

  const t = crypto.randomBytes(16).toString("hex");
  try {
    const url = await shorten(`${PUBLIC_URL}/getkey.html?t=${t}`);
    const db = readDb();
    db.sessions[t] = { ipHash: h, createdAt: Date.now(), used: false };
    prune(db);
    writeDb(db);
    res.json({ ok: true, url });
  } catch (e) {
    console.error("shorten lỗi:", e.message);
    res.status(502).json({ ok: false, error: "Không tạo được link vượt. Thử lại sau." });
  }
});

app.post("/api/getkey/claim", (req, res) => {
  const t = String((req.body && req.body.token) || "");
  if (!/^[a-f0-9]{32}$/.test(t)) return res.status(400).json({ ok: false, error: "Link không hợp lệ." });
  const db = readDb();
  const s = db.sessions[t];
  const now = Date.now();
  if (!s) return res.status(410).json({ ok: false, error: "Link đã hết hạn. Bắt đầu lại để lấy key." });
  if (IP_LOCK && s.ipHash !== ipHash(req))
    return res.status(403).json({ ok: false, error: "Link này được tạo từ mạng khác. Bắt đầu lại trên thiết bị này." });
  if (s.used && s.key) return res.json({ ok: true, key: s.key, durationHours: KEY_HOURS });
  if (now - s.createdAt > SESSION_TTL_MS) return res.status(410).json({ ok: false, error: "Link đã hết hạn. Bắt đầu lại để lấy key." });

  const elapsed = (now - s.createdAt) / 1000;
  if (elapsed < MIN_SECONDS)
    return res.status(425).json({ ok: false, error: "Bạn chưa hoàn thành link vượt.", waitSeconds: Math.ceil(MIN_SECONDS - elapsed) });

  const key = makeKeys(db, KEY_PREFIX, 1, KEY_HOURS)[0];
  s.used = true; s.key = key; s.claimedAt = now;
  db.claims[s.ipHash] = now;
  writeDb(db);
  res.json({ ok: true, key, durationHours: KEY_HOURS });
});

// ---------- Admin: tạo key tay ----------
app.post("/api/admin/keys", (req, res) => {
  if (!ADMIN_SECRET || req.get("x-admin-secret") !== ADMIN_SECRET)
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  const count = Math.max(1, Math.min(10, Number(req.body.count) || 1));
  const hours = Math.max(1, Math.min(720, Number(req.body.hours) || HOURS_DEFAULT));
  const db = readDb();
  const created = makeKeys(db, cleanPrefix(req.body.prefix), count, hours);
  writeDb(db);
  res.json({ ok: true, keys: created, durationHours: hours, note: "Key validity starts on first successful activation." });
});

// ---------- Xác minh key (Lua + key.html gọi) ----------
app.post("/api/verify", (req, res) => {
  const key = normalizeKey(req.body && req.body.key);
  if (!key || key.length > 100) return res.status(400).json({ ok: false, error: "Invalid request" });
  const db = readDb();
  const entry = db.keys[key];
  if (!entry) return res.status(401).json({ ok: false, error: "Key không hợp lệ" });

  const now = Date.now();
  if (entry.status === "unused") {
    entry.createdAt = now;
    entry.expiresAt = now + entry.durationHours * 60 * 60 * 1000;
    entry.status = "active";
    writeDb(db);
  }
  if (entry.status !== "active" || !entry.expiresAt || now >= entry.expiresAt) {
    entry.status = "expired";
    writeDb(db);
    return res.status(401).json({ ok: false, error: "Key đã hết hạn" });
  }
  return res.json({ ok: true, expiresAt: entry.expiresAt, remainingMs: entry.expiresAt - now });
});

app.listen(PORT, () => console.log(`Huy Pham Hub Key API listening on :${PORT}`));
