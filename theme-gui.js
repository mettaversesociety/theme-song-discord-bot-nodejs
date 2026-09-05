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
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
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
  if (value === null || value === "inherit" || value === "") return null;
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
  const publicUrl = (process.env.THEME_GUI_URL || "https://leagueofbanter.abrdns.com").replace(/\/$/, "");
  setInterval(pruneSessions, 60_000).unref();

  async function requireManager(req, url) {
    const session = getSession(tokenFrom(req, url));
    if (!session) fail(401, "Link expired or invalid. Run /set-theme-gui again.");
    const guild = await client.guilds.fetch(session.guildId);
    const member = await guild.members.fetch(session.userId);
    if (!canManageThemes(member)) fail(403, "You are not allowed to manage theme songs.");
    return { session, guild, member };
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
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = fs.readFileSync(HTML_PATH, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        });
        res.end(html);
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
        const rows = [];
        for (const doc of themes) {
          if (!SNOWFLAKE_RE.test(String(doc._id))) continue;
          const member = guild.members.cache.get(doc._id);
          const song = doc.theme_song || {};
          rows.push({
            userId: doc._id,
            username: (member && (member.displayName || member.user.username)) || song.username || doc._id,
            url: song.url || "",
            duration: song.duration || defaultDuration,
            cooldownMinutes: userCooldownMinutesFromTheme(song),
            lastPlayedAt: doc.lastPlayedAt || 0,
            hasAudio: Boolean(doc.hasAudio),
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

      if (req.method === "GET" && url.pathname === "/api/clips") {
        const { guild } = await requireManager(req, url);
        const [clips, themes] = await Promise.all([listLibraryClips(), listThemeSongs()]);
        const rows = [];
        for (const clip of clips) {
          const usedBy = [];
          for (const doc of themes) {
            const song = doc.theme_song || {};
            if (!song.url) continue;
            const id = song.clipId || libraryClipKey(song.url, song.duration);
            if (id !== clip._id) continue;
            if (!SNOWFLAKE_RE.test(String(doc._id))) continue;
            const member = guild.members.cache.get(doc._id);
            usedBy.push({
              userId: doc._id,
              username: (member && (member.displayName || member.user.username)) || song.username || doc._id,
            });
          }
          rows.push({
            clipId: clip._id,
            url: clip.url,
            title: clip.title || "",
            duration: clip.duration,
            start: clip.start || 0,
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
        const themes = await listThemeSongs();
        const memberIds = [];
        for (const doc of themes) {
          if (!SNOWFLAKE_RE.test(String(doc._id))) continue;
          const member =
            guild.members.cache.get(doc._id) || (await guild.members.fetch(doc._id).catch(() => null));
          if (member) memberIds.push(String(doc._id));
        }
        await deleteLibraryClip(clipId, memberIds);
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
        const body = await readBody(req);
        const member = await resolveMember(guild, body.user || body.userId);
        const duration = clampDuration(body.duration || defaultDuration);
        const cooldownMinutes = parseCooldownMinutes(body.cooldownMinutes);
        clipBusy = true;
        try {
          const saved = await setMemberThemeSong(
            member.id,
            String(body.url || "").trim(),
            duration,
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
        await requireManager(req, url);
        const userId = pathUserId(url.pathname, 3);
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
