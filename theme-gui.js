const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const HTML_PATH = path.join(__dirname, "public", "theme-gui.html");
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const SNOWFLAKE_RE = /^\d{15,22}$/;
const CLIP_ID_RE = /^[a-f0-9]{16}$/;
const sessions = new Map();
let clipBusy = false;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function sendAudio(res, preview) {
  if (!preview || !preview.buf || preview.buf.length < 1000) fail(404, "No clip audio to preview.");
  const body = preview.buf;
  res.writeHead(200, {
    "Content-Type": preview.contentType || "audio/wav",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function readRequestBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(Object.assign(new Error("File is too large (max 8 MB)."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buf, contentType) {
  const bm = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!bm) fail(400, "Expected a file upload.");
  const boundary = Buffer.from("--" + String(bm[1] || bm[2]).trim());
  const fields = {};
  const files = {};
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf(boundary, pos);
    if (start < 0) break;
    pos = start + boundary.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;
    if (buf[pos] === 13) pos += 1;
    if (buf[pos] === 10) pos += 1;
    const headerEnd = buf.indexOf(Buffer.from("\r\n\r\n"), pos);
    if (headerEnd < 0) break;
    const header = buf.slice(pos, headerEnd).toString("utf8");
    const nextBound = buf.indexOf(boundary, headerEnd + 4);
    if (nextBound < 0) break;
    let bodyEnd = nextBound;
    if (bodyEnd >= 2 && buf[bodyEnd - 2] === 13 && buf[bodyEnd - 1] === 10) bodyEnd -= 2;
    const body = buf.slice(headerEnd + 4, bodyEnd);
    const nameM = header.match(/name="([^"]+)"/i);
    const fileM = header.match(/filename="([^"]*)"/i);
    if (nameM) {
      const name = nameM[1];
      if (fileM && fileM[1]) files[name] = { filename: fileM[1], data: body };
      else fields[name] = body.toString("utf8");
    }
    pos = nextBound;
  }
  return { fields, files };
}

function readBody(req, limit = 32_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function mintToken(userId, guildId) {
  pruneSessions();
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { userId, guildId, exp: Date.now() + TOKEN_TTL_MS });
  return token;
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (!session || now > session.exp) sessions.delete(token);
  }
}

function getSession(token) {
  if (!token || typeof token !== "string" || token.length < 32 || token.length > 128) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.exp) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function tokenFrom(req, url) {
  const header = req.headers["x-theme-token"];
  if (header) return String(header).slice(0, 128);
  return String(url.searchParams.get("t") || "").slice(0, 128);
}

function pathUserId(pathname, index) {
  const id = pathname.split("/")[index];
  if (!SNOWFLAKE_RE.test(id || "")) fail(400, "Invalid user id.");
  return id;
}

function pathClipId(pathname, index) {
  const id = pathname.split("/")[index];
  if (!CLIP_ID_RE.test(id || "")) fail(400, "Invalid clip id.");
  return id;
}

function parseCooldownMinutes(value) {
  if (value === null || value === undefined || value === "inherit" || value === "") return null;
  if (value === false) return 0;
  if (value === true) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) fail(400, "Invalid cooldown minutes.");
  return n;
}

function startThemeGui(deps) {
  const {
    client,
    canManageThemes,
    setMemberThemeSong,
    deleteMemberThemeSong,
    listThemeSongs,
    listLibraryClips,
    getClipTitle,
    assignLibraryClip,
    deleteLibraryClip,
    previewClipAudio,
    previewMemberAudio,
    importUploadedClip,
    trimLibraryClip,
    libraryClipKey,
    getGuildCooldownMinutes,
    setGuildCooldownMinutes,
    setMemberCooldownMinutes,
    clampDuration,
    clampCooldownMinutes,
    userCooldownMinutesFromTheme,
    minDuration,
    maxDuration,
    defaultDuration,
    DEFAULT_COOLDOWN_MINUTES,
  } = deps;

  const port = Number(process.env.THEME_GUI_PORT || 3847);
  const publicUrl = (process.env.THEME_GUI_URL || "https://leagueofbanter.com").replace(/\/$/, "");
  setInterval(pruneSessions, 60_000).unref();

  async function requireManager(req, url) {
    const session = getSession(tokenFrom(req, url));
    if (!session) fail(401, "Link expired or invalid. Run /set-theme-gui again.");
    const guild = await client.guilds.fetch(session.guildId);
    const member = await guild.members.fetch({ user: session.userId, force: true });
    if (!canManageThemes(member)) fail(403, "You are not allowed to manage theme songs.");
    return { session, guild, member };
  }

  async function membersInGuild(guild, userIds) {
    const ids = [...new Set((userIds || []).map(String).filter((id) => SNOWFLAKE_RE.test(id)))];
    const found = new Map();
    if (!ids.length) return found;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        const fetched = await guild.members.fetch({ user: chunk });
        for (const [id, member] of fetched) {
          if (member && member.user && !member.user.bot) found.set(id, member);
        }
      } catch {
        for (const id of chunk) {
          const member = guild.members.cache.get(id);
          if (member && member.user && !member.user.bot) found.set(id, member);
        }
      }
    }
    return found;
  }

  async function resolveMember(guild, raw) {
    const q = String(raw || "").trim();
    if (!q) fail(400, "Pick a server member.");
    const mention = q.match(/^<@!?(\d+)>$/);
    const wrapped = q.match(/\((\d{15,22})\)\s*$/);
    const id = mention ? mention[1] : wrapped ? wrapped[1] : SNOWFLAKE_RE.test(q) ? q : null;
    if (id) {
      try {
        return await guild.members.fetch(id);
      } catch {
        fail(404, "That Discord user is not in this server.");
      }
    }
    const found = await guild.members.fetch({ query: q.slice(0, 32), limit: 8 });
    if (found.size === 1) return found.first();
    const exact = found.find(
      (m) =>
        m.user.username.toLowerCase() === q.toLowerCase() ||
        (m.displayName || "").toLowerCase() === q.toLowerCase(),
    );
    if (exact) return exact;
    if (found.size > 1) fail(400, "Multiple members match that name. Pick one from the list.");
    fail(404, "No member found. Pick one from the list.");
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, publicUrl);
      if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = fs.readFileSync(HTML_PATH, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Length": Buffer.byteLength(html),
        });
        if (req.method === "HEAD") res.end();
        else res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/me") {
        const { member, guild } = await requireManager(req, url);
        json(res, 200, {
          guildId: guild.id,
          guildName: guild.name,
          managerId: member.id,
          managerTag: member.user.tag,
          minDuration,
          maxDuration,
          defaultDuration,
          defaultCooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/themes") {
        const { guild } = await requireManager(req, url);
        const themes = await listThemeSongs();
        const members = await membersInGuild(guild, themes.map((doc) => doc._id));
        const rows = [];
        for (const doc of themes) {
          const member = members.get(String(doc._id));
          if (!member) continue;
          const song = doc.theme_song || {};
          rows.push({
            userId: doc._id,
            username: member.displayName || member.user.username,
            url: song.url || "",
            duration: song.duration || defaultDuration,
            cooldownMinutes: userCooldownMinutesFromTheme(song),
            lastPlayedAt: doc.lastPlayedAt || 0,
            hasAudio: Boolean(doc.hasAudio),
            clipId: song.clipId || "",
            start: song.start != null ? Number(song.start) : 0,
          });
        }
        rows.sort((a, b) => String(a.username).localeCompare(String(b.username)));
        json(res, 200, {
          themes: rows,
          guildCooldownMinutes: await getGuildCooldownMinutes(guild.id),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/members") {
        const { guild } = await requireManager(req, url);
        const q = String(url.searchParams.get("q") || "").trim().slice(0, 32);
        let members = [];
        if (q.length >= 1) {
          const found = await guild.members.fetch({ query: q, limit: 25 });
          members = [...found.values()];
        } else {
          members = [...guild.members.cache.values()];
        }
        json(res, 200, {
          members: members
            .filter((m) => m.user && !m.user.bot)
            .sort((a, b) =>
              String(a.displayName || a.user.username).localeCompare(String(b.displayName || b.user.username)),
            )
            .slice(0, 80)
            .map((m) => ({
              userId: m.id,
              username: m.user.username,
              displayName: m.displayName || m.user.username,
            })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/clips/upload") {
        await requireManager(req, url);
        if (clipBusy) fail(429, "Already clipping another theme. Wait a moment.");
        clipBusy = true;
        try {
          const raw = await readRequestBuffer(req, MAX_UPLOAD_BYTES);
          const { fields, files } = parseMultipart(raw, req.headers["content-type"]);
          const file = files.audio || files.file || files.clip;
          if (!file || !file.data || file.data.length < 100) fail(400, "Choose an audio file to upload.");
          const saved = await importUploadedClip({
            audioBuf: file.data,
            filename: file.filename,
            title: fields.title,
            duration: fields.duration,
            start: fields.start,
          });
          json(res, 200, saved);
        } finally {
          clipBusy = false;
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/clips") {
        const { guild } = await requireManager(req, url);
        const [clips, themes] = await Promise.all([listLibraryClips(), listThemeSongs()]);
        const members = await membersInGuild(guild, themes.map((doc) => doc._id));
        const rows = [];
        for (const clip of clips) {
          const usedBy = [];
          for (const doc of themes) {
            const member = members.get(String(doc._id));
            if (!member) continue;
            const song = doc.theme_song || {};
            if (!song.url) continue;
            const id = song.clipId || libraryClipKey(song.url, song.duration);
            if (id !== clip._id) continue;
            usedBy.push({
              userId: doc._id,
              username: member.displayName || member.user.username,
            });
          }
          rows.push({
            clipId: clip._id,
            url: clip.url,
            title: clip.title || "",
            duration: clip.duration,
            start: clip.start || 0,
            source: clip.source || (String(clip.url || "").startsWith("upload:") ? "upload" : ""),
            usedBy,
          });
        }
        rows.sort((a, b) => String(a.title || a.url).localeCompare(String(b.title || b.url)));
        json(res, 200, { clips: rows });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/clips/") && url.pathname.endsWith("/audio")) {
        await requireManager(req, url);
        const clipId = pathClipId(url.pathname, 3);
        sendAudio(res, await previewClipAudio(clipId));
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/clips/") && url.pathname.endsWith("/title")) {
        await requireManager(req, url);
        const clipId = pathClipId(url.pathname, 3);
        const title = await getClipTitle(clipId);
        json(res, 200, { title: title || "" });
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/clips/") && url.pathname.endsWith("/trim")) {
        await requireManager(req, url);
        if (clipBusy) fail(429, "Already clipping another theme. Wait a moment.");
        clipBusy = true;
        try {
          const clipId = pathClipId(url.pathname, 3);
          const body = await readBody(req);
          const saved = await trimLibraryClip(clipId, body.inPoint, body.outPoint, {
            replace: Boolean(body.replace),
            title: body.title,
            volume: body.volume,
          });
          json(res, 200, saved);
        } finally {
          clipBusy = false;
        }
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/clips/") && url.pathname.endsWith("/assign")) {
        const { guild } = await requireManager(req, url);
        const clipId = pathClipId(url.pathname, 3);
        const body = await readBody(req);
        const member = await resolveMember(guild, body.user || body.userId);
        const saved = await assignLibraryClip(
          clipId,
          member.id,
          member.user.username,
          parseCooldownMinutes(body.cooldownMinutes),
        );
        json(res, 200, {
          userId: member.id,
          username: member.displayName || member.user.username,
          clipped: false,
          duration: saved.duration,
          url: saved.url,
        });
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/clips/")) {
        const { guild } = await requireManager(req, url);
        const clipId = pathClipId(url.pathname, 3);
        await deleteLibraryClip(clipId, guild.id);
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/settings") {
        const { guild } = await requireManager(req, url);
        const body = await readBody(req);
        const minutes = clampCooldownMinutes(body.cooldownMinutes);
        json(res, 200, { guildCooldownMinutes: await setGuildCooldownMinutes(guild.id, minutes) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/themes") {
        const { guild } = await requireManager(req, url);
        if (clipBusy) fail(429, "Already clipping another theme. Wait a moment.");
        clipBusy = true;
        try {
          const body = await readBody(req);
          const member = await resolveMember(guild, body.user || body.userId);
          const duration = Number(body.duration);
          const cooldownMinutes = parseCooldownMinutes(body.cooldownMinutes);
          const saved = await setMemberThemeSong(
            member.id,
            String(body.url || "").trim(),
            Number.isFinite(duration) ? duration : defaultDuration,
            member.user.username,
            cooldownMinutes,
          );
          json(res, 200, {
            userId: member.id,
            username: member.displayName || member.user.username,
            duration: saved.duration,
            clipped: saved.clipped,
            cooldownMinutes,
            url: String(body.url || "").trim(),
          });
        } catch (err) {
          console.error("theme clip failed:", err.message || err);
          throw err;
        } finally {
          clipBusy = false;
        }
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/themes/") && url.pathname.endsWith("/audio")) {
        const { guild } = await requireManager(req, url);
        const userId = pathUserId(url.pathname, 3);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) fail(404, "That user is not in this server.");
        sendAudio(res, await previewMemberAudio(userId));
        return;
      }

      if (req.method === "PATCH" && url.pathname.startsWith("/api/themes/") && url.pathname.endsWith("/cooldown")) {
        const { guild } = await requireManager(req, url);
        const userId = pathUserId(url.pathname, 3);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) fail(404, "That user is not in this server.");
        const body = await readBody(req);
        const minutes = parseCooldownMinutes(body.cooldownMinutes);
        await setMemberCooldownMinutes(userId, minutes);
        json(res, 200, { userId, cooldownMinutes: minutes });
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/themes/") && url.pathname.endsWith("/reset-cooldown")) {
        const { guild } = await requireManager(req, url);
        const userId = pathUserId(url.pathname, 3);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) fail(404, "That user is not in this server.");
        await deps.clearThemeCooldown(userId);
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/themes/")) {
        const { guild } = await requireManager(req, url);
        const userId = pathUserId(url.pathname, 3);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) fail(404, "That user is not in this server.");
        await deleteMemberThemeSong(userId);
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error("theme gui:", error.message || error);
      json(res, status, { error: error.message || String(error) });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Theme GUI listening on :${port} public ${publicUrl}`);
  });

  return { mintToken, publicUrl, TOKEN_TTL_MS };
}

module.exports = { startThemeGui, mintToken, TOKEN_TTL_MS };
