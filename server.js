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
// Các trang đã gộp vào public/index.html. Link cũ vẫn chạy (chặn cả file cũ nếu còn trong public/).
app.get("/getkey.html", (req, res) => {
  const qs = req.url.slice(req.path.length);
  res.redirect(302, qs ? "/" + qs : "/#lay-key");
});
app.get("/key.html", (_req, res) => res.redirect(302, "/#nhap-key"));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const DB_FILE = path.join(__dirname, "keys.json");
const HOURS_DEFAULT = 24;

const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHORTENER_TEMPLATE = process.env.SHORTENER_TEMPLATE || "";
