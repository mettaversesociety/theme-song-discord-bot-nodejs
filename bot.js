require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { MongoClient, Binary } = require("mongodb");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const ffmpegPath = require("ffmpeg-static");
const scdl = require("soundcloud-downloader").default;
const { startThemeGui } = require("./theme-gui");

process.env.FFMPEG_BINARY = ffmpegPath;

const DEFAULT_COOLDOWN_MINUTES = 15;
const MAX_COOLDOWN_MINUTES = 24 * 60;
const MIN_DURATION = 1;
const MAX_DURATION = 20;
const DEFAULT_DURATION = 10;
const DEFAULT_VOLUME = 0.4;
const SPAWN_TIMEOUT_MS = 90_000;
const YT_DLP_BIN = path.join(__dirname, "node_modules/@distube/yt-dlp/bin/yt-dlp");
const YT_COOKIES = path.join(__dirname, "youtube-cookies.txt");
const CLIPS_DIR = path.join(__dirname, "clips");
fs.mkdirSync(CLIPS_DIR, { recursive: true });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const db = () => mongoClient.db("theme_songsDB");

let defaultVolumeLevel = DEFAULT_VOLUME;
let volumeCollection;
const rolesCollection = () => db().collection("approvedRoles");
const approvedUsersCollection = () => db().collection("approvedUsers");
const themesCollection = () => db().collection("themeSongs");
const clipsCollection = () => db().collection("themeClips");
const guildSettingsCollection = () => db().collection("guildSettings");
const soundboardCollection = () => db().collection("soundboard");

const approvedRolesCache = new Map();
const approvedUsersCache = new Map();
const soundboardState = {};
const players = new Map();
const voiceConnections = new Map();
const themeSessions = new Map();
const themePlayLocks = new Map();
const playerPlayIds = new WeakMap();
let themeGui = null;

function clampDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(n)));
}

function roundHundredth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function playDurationMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DURATION * 1000;
  return Math.min((MAX_DURATION + 1) * 1000, Math.max(300, Math.round(n * 1000) + 400));
}

function clampCooldownMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_COOLDOWN_MINUTES, Math.round(n));
}

function userCooldownMinutesFromTheme(theme) {
  if (!theme) return null;
  if (theme.cooldownMinutes !== undefined && theme.cooldownMinutes !== null) {
    return clampCooldownMinutes(theme.cooldownMinutes);
  }
  if (theme.cooldown === false) return 0;
  return null;
}

function guildCooldownMinutesFromDoc(doc) {
  if (!doc) return DEFAULT_COOLDOWN_MINUTES;
  if (doc.cooldownMinutes !== undefined && doc.cooldownMinutes !== null) {
    return clampCooldownMinutes(doc.cooldownMinutes);
  }
  if (doc.themeCooldown === false) return 0;
  return DEFAULT_COOLDOWN_MINUTES;
}

function effectiveCooldownMs(guildMinutes, userMinutes) {
  const minutes = userMinutes === 0 ? 0 : userMinutes > 0 ? userMinutes : guildMinutes;
  return Math.max(0, minutes) * 60 * 1000;
}

function isYoutubeUrl(url) {
  return typeof url === "string" && (url.includes("youtube.com") || url.includes("youtu.be"));
}

function isSoundcloudUrl(url) {
  return typeof url === "string" && url.includes("soundcloud.com");
}

function parseTimestampToSeconds(raw) {
  if (raw == null || raw === "") return 0;
  let value = String(raw).trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value)));
  if (/[hms]/i.test(value)) {
    let sec = 0;
    const h = value.match(/(\d+)h/i);
    const m = value.match(/(\d+)m/i);
    const s = value.match(/(\d+(?:\.\d+)?)s/i);
    if (h) sec += parseInt(h[1], 10) * 3600;
    if (m) sec += parseInt(m[1], 10) * 60;
    if (s) sec += parseFloat(s[1]);
    return Math.max(0, Math.round(sec));
  }
  const colon = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!colon) return 0;
  const hours = colon[1] ? parseInt(colon[1], 10) : 0;
  const minutes = parseInt(colon[2], 10);
  const seconds = parseFloat(colon[3]);
  return Math.max(0, Math.round(hours * 3600 + minutes * 60 + seconds));
}

function parseStartSeconds(url) {
  try {
    const parsed = new URL(url);
    const fromQuery = parsed.searchParams.get("t") || parsed.searchParams.get("start");
    let fromHash = "";
    if (parsed.hash) {
      fromHash = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("t")
        || new URLSearchParams(parsed.hash.replace(/^#/, "")).get("start")
        || "";
    }
    return parseTimestampToSeconds(fromQuery || fromHash);
  } catch {
    return 0;
  }
}

function canonicalClipUrl(url) {
  try {
    const parsed = new URL(url);
    ["si", "feature", "pp", "ab_channel", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(
      (key) => parsed.searchParams.delete(key),
    );
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function trackKey(url) {
  try {
    const parsed = new URL(canonicalClipUrl(url));
    parsed.searchParams.delete("t");
    parsed.searchParams.delete("start");
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

function baseClipTitle(title) {
  return cleanTitle(title).replace(/\s+\(\d+\)$/, "");
}

function applyDuplicateTitleSuffixes(clips) {
  const groups = new Map();
  for (const clip of clips) {
    if (!clip || !clip.url) continue;
    const key = trackKey(clip.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(clip);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const ac = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bc = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (ac !== bc) return ac - bc;
      const as = Number(a.start) || 0;
      const bs = Number(b.start) || 0;
      if (as !== bs) return as - bs;
      return String(a._id).localeCompare(String(b._id));
    });
    const base = baseClipTitle(group[0].title) || "Clip";
    group.forEach((clip, index) => {
      clip.title = index === 0 ? base || clip.title : `${base} (${index + 1})`;
    });
  }
  return clips;
}

function clipKey(userId, url, duration) {
  const start = parseStartSeconds(url);
  return crypto
    .createHash("sha1")
    .update(`${userId}|${url}|${start}|${duration}`)
    .digest("hex")
    .slice(0, 16);
}

function libraryClipKey(url, duration) {
  const start = parseStartSeconds(url);
  return crypto
    .createHash("sha1")
    .update(`${canonicalClipUrl(url)}|${start}|${clampDuration(duration)}`)
    .digest("hex")
    .slice(0, 16);
}

function cleanTitle(raw) {
  const line = String(raw || "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return (line || "").slice(0, 200);
}

async function fetchClipTitle(url) {
  // Last-resort at clip time only. Page load and the shelf never call this.
  try {
    const endpoint = isYoutubeUrl(url)
      ? "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url)
      : isSoundcloudUrl(url)
        ? "https://soundcloud.com/oembed?format=json&url=" + encodeURIComponent(url)
        : "";
    if (!endpoint) return "";
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return "";
    const data = await res.json();
    return cleanTitle(data.title);
  } catch (error) {
    console.error("clip title fetch failed:", error.message || error);
    return "";
  }
}

async function upsertLibraryClip(url, duration, audioBuf, title, opts = {}) {
  if (!audioBuf || audioBuf.length < 1000) return null;
  const id = libraryClipKey(url, duration);
  const existing = await clipsCollection().findOne({ _id: id }, { projection: { title: 1 } });
  let resolved = cleanTitle(title);
  if (!resolved) resolved = existing && existing.title ? existing.title : "";
  const set = {
    url,
    duration: clampDuration(duration),
    start: parseStartSeconds(url),
    audio: new Binary(audioBuf),
    audioFormat: "ogg",
  };
  if (resolved) set.title = resolved;
  await clipsCollection().updateOne(
    { _id: id },
    { $set: set, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return id;
}

function clipPathFor(userId, url, duration) {
  return path.join(CLIPS_DIR, `${clipKey(userId, url, duration)}.ogg`);
}

function ytdlpProxyArgs() {
  return process.env.YTDLP_PROXY ? ["--proxy", process.env.YTDLP_PROXY] : [];
}

function prepareCookies() {
  if (!fs.existsSync(YT_COOKIES)) return { args: [], file: null };
  try {
    const dest = path.join(CLIPS_DIR, `.youtube-cookies.${crypto.randomBytes(4).toString("hex")}.tmp`);
    fs.copyFileSync(YT_COOKIES, dest);
    return { args: ["--cookies", dest], file: dest };
  } catch {
    return { args: [], file: null };
  }
}

function isYoutubeBotCheck(error) {
  const msg = String((error && error.message) || error).toLowerCase();
  return /sign in|not a bot|use --cookies|http error 403|http error 429/.test(msg);
}

function removeFullSources(key) {
  for (const name of fs.readdirSync(CLIPS_DIR)) {
    if (!name.startsWith(`${key}.full.`)) continue;
    try {
      fs.unlinkSync(path.join(CLIPS_DIR, name));
    } catch {
      /* ignore */
    }
  }
}

function spawnOnce(bin, args, timeoutMs = SPAWN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.stderr.on("data", (buf) => {
      err += buf.toString();
      if (err.length > 8000) err = err.slice(-4000);
    });
    proc.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error((err || `exit ${code}`).trim().slice(-500)));
    });
  });
}

function spawnStdoutBuffer(bin, args, inputBuf, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`${path.basename(bin)} timed out`));
    }, timeoutMs);
    proc.stdout.on("data", (buf) => chunks.push(buf));
    proc.stderr.on("data", (buf) => {
      err += buf.toString();
      if (err.length > 4000) err = err.slice(-2000);
    });
    proc.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error((err || `exit ${code}`).trim().slice(-400)));
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(inputBuf);
  });
}

function spawnStdoutNoStdin(bin, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`${path.basename(bin)} timed out`));
    }, timeoutMs);
    proc.stdout.on("data", (buf) => chunks.push(buf));
    proc.stderr.on("data", (buf) => {
      err += buf.toString();
      if (err.length > 4000) err = err.slice(-2000);
    });
    proc.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error((err || `exit ${code}`).trim().slice(-400)));
    });
  });
}

const VOICE_PRIME_MS = 150;
let silenceOgg = null;

async function getSilenceOgg() {
  if (silenceOgg && silenceOgg.length > 80) return silenceOgg;
  const pcm = Buffer.alloc(Math.round(48000 * 2 * 2 * (VOICE_PRIME_MS / 1000)));
  const buf = await spawnStdoutBuffer(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-application",
      "lowdelay",
      "-f",
      "ogg",
      "pipe:1",
    ],
    pcm,
    15_000,
  );
  if (!buf || buf.length < 80) throw new Error("silence ogg empty");
  silenceOgg = buf;
  return silenceOgg;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitVoiceReady(connection) {
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    throw new Error("voice connection gone");
  }
  if (connection.state.status !== VoiceConnectionStatus.Ready) {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  }
}

async function primeVoiceAfterReady(player, connection, stillCurrent) {
  let silence = null;
  try {
    silence = await getSilenceOgg();
  } catch (error) {
    console.error("voice prime silence failed:", error.message || error);
  }
  if (stillCurrent && !stillCurrent()) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    await waitVoiceReady(connection);
    if (stillCurrent && !stillCurrent()) return;
    console.log("voice Ready, priming", VOICE_PRIME_MS, "ms");
    const started = Date.now();
    if (silence) {
      try {
        playResource(player, Readable.from(silence), { inlineVolume: false, inputType: StreamType.OggOpus });
      } catch (error) {
        console.error("voice prime play failed:", error.message || error);
      }
    }
    const left = VOICE_PRIME_MS - (Date.now() - started);
    if (left > 0) await waitMs(left);
    if (stillCurrent && !stillCurrent()) return;
    if (connection.state.status === VoiceConnectionStatus.Ready) return;
  }
  await waitVoiceReady(connection);
  if (stillCurrent && !stillCurrent()) return;
  console.log("voice Ready after retries, priming", VOICE_PRIME_MS, "ms");
  const started = Date.now();
  if (silence) {
    try {
      playResource(player, Readable.from(silence), { inlineVolume: false, inputType: StreamType.OggOpus });
    } catch (error) {
      console.error("voice prime play failed:", error.message || error);
    }
  }
  const left = VOICE_PRIME_MS - (Date.now() - started);
  if (left > 0) await waitMs(left);
}

async function oggOpusToWav(buf) {
  return spawnStdoutBuffer(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-f",
    "wav",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1",
  ], buf);
}

async function audioFileToThemeOgg(inputBuf, start, duration) {
  if (!inputBuf || inputBuf.length < 100) {
    throw Object.assign(new Error("That file is empty."), { status: 400 });
  }
  try {
    const ogg = await spawnStdoutBuffer(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-ss",
        String(Math.max(0, start || 0)),
        "-t",
        String(clampDuration(duration)),
        "-filter:a",
        `volume=${defaultVolumeLevel}`,
        "-c:a",
        "libopus",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-application",
        "lowdelay",
        "-f",
        "ogg",
        "pipe:1",
      ],
      inputBuf,
      60_000,
    );
    if (!ogg || ogg.length < 1000) {
      throw Object.assign(new Error("Could not read that audio file."), { status: 400 });
    }
    return ogg;
  } catch (error) {
    if (error && error.status) throw error;
    throw Object.assign(new Error("Could not read that audio file."), { status: 400 });
  }
}

async function importUploadedClip({ audioBuf, filename, title, duration, start }) {
  const startSec = Math.max(0, Math.round(Number(start) || 0));
  const clippedDuration = clampDuration(duration || DEFAULT_DURATION);
  const ogg = await audioFileToThemeOgg(audioBuf, startSec, clippedDuration);
  const id = crypto
    .createHash("sha1")
    .update(`upload|${startSec}|${clippedDuration}|`)
    .update(ogg)
    .digest("hex")
    .slice(0, 16);
  const fromName = filename ? String(filename).replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") : "";
  const existing = await clipsCollection().findOne({ _id: id }, { projection: { title: 1 } });
  const resolvedTitle =
    cleanTitle(title) || cleanTitle(fromName) || (existing && existing.title) || "Uploaded clip";
  const url = "upload://" + id;
  await clipsCollection().updateOne(
    { _id: id },
    {
      $set: {
        url,
        duration: clippedDuration,
        start: startSec,
        title: resolvedTitle,
        audio: new Binary(ogg),
        audioFormat: "ogg",
        source: "upload",
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  console.log("imported upload clip", id, ogg.length, "bytes", resolvedTitle);
  return { clipId: id, title: resolvedTitle, duration: clippedDuration, start: startSec, url };
}

async function sliceThemeOgg(inputBuf, start, length) {
  if (!inputBuf || inputBuf.length < 1000) {
    throw Object.assign(new Error("That clip has no audio to edit."), { status: 404 });
  }
  const ogg = await spawnStdoutBuffer(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ss",
      String(start),
      "-t",
      String(length),
      "-c:a",
      "libopus",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-application",
      "lowdelay",
      "-f",
      "ogg",
      "pipe:1",
    ],
    inputBuf,
    30_000,
  );
  if (!ogg || ogg.length < 800) {
    throw Object.assign(new Error("Could not cut that selection."), { status: 400 });
  }
  return ogg;
}

async function trimLibraryClip(clipId, inPoint, outPoint, { replace = false, title } = {}) {
  const { clip, buf } = await resolveClipAudio(clipId);
  if (!buf) throw Object.assign(new Error("That clip is not in the library."), { status: 404 });
  const sourceDur = Math.max(Number(clip.duration) || 0, 0.3);
  const start = roundHundredth(Math.max(0, Number(inPoint) || 0));
  const end = roundHundredth(Math.min(sourceDur + 0.05, Number(outPoint)));
  const length = roundHundredth(end - start);
  if (!Number.isFinite(end) || length < 0.3) {
    throw Object.assign(new Error("Mark an in and out at least 0.3 seconds apart."), { status: 400 });
  }
  if (length > MAX_DURATION) {
    throw Object.assign(new Error("Keep the cut at 20 seconds or less."), { status: 400 });
  }
  let ogg;
  try {
    ogg = await sliceThemeOgg(buf, start, length);
  } catch (error) {
    if (error && error.status) throw error;
    throw Object.assign(new Error("Could not cut that selection."), { status: 400 });
  }
  const resolvedTitle = cleanTitle(title) || cleanTitle(clip.title) || "Clip";
  const newStart = roundHundredth((Number(clip.start) || 0) + start);
  if (replace) {
    await clipsCollection().updateOne(
      { _id: clipId },
      {
        $set: {
          audio: new Binary(ogg),
          audioFormat: "ogg",
          duration: length,
          start: newStart,
          title: resolvedTitle,
        },
      },
    );
    await themesCollection().updateMany(
      { "theme_song.clipId": clipId },
      {
        $set: {
          "theme_song.audio": new Binary(ogg),
          "theme_song.audioFormat": "ogg",
          "theme_song.duration": length,
          "theme_song.start": newStart,
          "theme_song.title": resolvedTitle,
        },
      },
    );
    console.log("replaced trimmed clip", clipId, length, "s");
    return { clipId, title: resolvedTitle, duration: length, start: newStart, replaced: true, url: clip.url || "" };
  }
  const id = crypto
    .createHash("sha1")
    .update(`trim|${clipId}|${start}|${length}|`)
    .update(ogg)
    .digest("hex")
    .slice(0, 16);
  const url = clip.url && !String(clip.url).startsWith("upload:") ? clip.url : "upload://" + id;
  await clipsCollection().updateOne(
    { _id: id },
    {
      $set: {
        url,
        duration: length,
        start: newStart,
        title: resolvedTitle,
        audio: new Binary(ogg),
        audioFormat: "ogg",
        source: clip.source || (String(clip.url || "").startsWith("upload:") ? "upload" : "trim"),
        parentClipId: clipId,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  console.log("saved trimmed clip", id, "from", clipId, length, "s");
  return { clipId: id, title: resolvedTitle, duration: length, start: newStart, replaced: false, url };
}

async function previewFromOgg(buf) {
  if (!buf || buf.length < 1000) return null;
  try {
    const wav = await oggOpusToWav(buf);
    if (wav && wav.length > 1000) return { buf: wav, contentType: "audio/wav" };
  } catch (error) {
    console.error("preview transcode failed:", error.message || error);
  }
  return { buf, contentType: "audio/ogg; codecs=opus" };
}

function ffmpegCut(src, out, start, duration) {
  return spawnOnce(ffmpegPath, [
    "-y",
    "-i",
    src,
    "-ss",
    String(start),
    "-t",
    String(duration),
    "-filter:a",
    `volume=${defaultVolumeLevel}`,
    "-c:a",
    "libopus",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-application",
    "lowdelay",
    out,
  ]);
}

async function cacheYoutubeClip(userId, url, duration) {
  const out = clipPathFor(userId, url, duration);
  try {
    if (fs.existsSync(out)) fs.unlinkSync(out);
  } catch {
    /* recut from source */
  }

  const key = clipKey(userId, url, duration);
  const start = parseStartSeconds(url);
  const len = clampDuration(duration);
  const srcTemplate = path.join(CLIPS_DIR, `${key}.full.%(ext)s`);
  const titlePromise = fetchClipTitle(url);

  const download = (cookies) =>
    spawnOnce(YT_DLP_BIN, [
      ...ytdlpProxyArgs(),
      "--js-runtimes",
      `node:${process.execPath}`,
      ...cookies,
      "-f",
      "bestaudio/best",
      "--no-playlist",
      "--no-warnings",
      "-o",
      srcTemplate,
      url,
    ]);

  removeFullSources(key);
  try {
    await download([]);
  } catch (err) {
    const cookies = prepareCookies();
    if (!cookies.args.length || !isYoutubeBotCheck(err)) throw err;
    removeFullSources(key);
    try {
      await download(cookies.args);
    } finally {
      if (cookies.file) {
        try {
          fs.unlinkSync(cookies.file);
        } catch {
          /* ignore */
        }
      }
    }
  }

  const src = fs
    .readdirSync(CLIPS_DIR)
    .filter((name) => name.startsWith(`${key}.full.`) && !name.endsWith(".part"))
    .map((name) => path.join(CLIPS_DIR, name))[0];
  if (!src) throw new Error("yt-dlp did not write source audio");

  await ffmpegCut(src, out, start, len);
  try {
    fs.unlinkSync(src);
  } catch {
    /* ignore */
  }
  console.log("cached youtube clip", out, "start", start, "len", len);
  return { file: out, title: cleanTitle(await titlePromise) };
}

async function cacheSoundcloudClip(userId, url, duration) {
  const out = clipPathFor(userId, url, duration);
  let title = "";
  try {
    const info = await scdl.getInfo(url);
    title = cleanTitle(info && info.title);
  } catch {
    /* title is optional; audio still clips */
  }
  try {
    if (fs.existsSync(out)) fs.unlinkSync(out);
  } catch {
    /* recut from source */
  }

  const start = parseStartSeconds(url);
  const len = clampDuration(duration);
  const tmp = path.join(CLIPS_DIR, `${clipKey(userId, url, duration)}.sc.tmp`);
  const download = await scdl.download(url);
  await pipeline(download, fs.createWriteStream(tmp));
  await ffmpegCut(tmp, out, start, len);
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  console.log("cached soundcloud clip", out, "start", start, "len", len);
  return { file: out, title };
}

async function buildThemeClip(userId, url, duration) {
  let result;
  if (isYoutubeUrl(url)) result = await cacheYoutubeClip(userId, url, duration);
  else if (isSoundcloudUrl(url)) result = await cacheSoundcloudClip(userId, url, duration);
  else throw new Error("Only YouTube and SoundCloud URLs are supported.");

  const file = result && result.file;
  if (!file || !fs.existsSync(file) || fs.statSync(file).size < 1000) {
    throw new Error("Failed to clip audio.");
  }
  const buf = fs.readFileSync(file);
  try {
    fs.unlinkSync(file);
  } catch {
    /* mongo holds the clip */
  }
  return { buf, title: cleanTitle(result.title) };
}

function audioBufferFromTheme(theme) {
  if (!theme || !theme.audio) return null;
  const raw = theme.audio.buffer || theme.audio;
  // Always copy: Binary.buffer is a view into the BSON packet and can be
  // overwritten when the driver reuses memory for later reads.
  const buf = Buffer.isBuffer(raw) || ArrayBuffer.isView(raw)
    ? Buffer.from(raw)
    : Buffer.from(raw);
  return buf.length > 1000 ? buf : null;
}

async function connectMongo() {
  await mongoClient.connect();
  volumeCollection = db().collection("volumeSettings");
  const volumeDoc = await volumeCollection.findOne({ _id: "defaultVolume" });
  if (volumeDoc && volumeDoc.value !== undefined) defaultVolumeLevel = volumeDoc.value;
  else await volumeCollection.insertOne({ _id: "defaultVolume", value: defaultVolumeLevel });
  console.log("Connected to MongoDB");
}

function snowflake(id) {
  return id == null ? "" : String(id);
}

function loadIdList(values) {
  return (Array.isArray(values) ? values : []).map(snowflake).filter(Boolean);
}

async function loadApprovedCaches() {
  const roles = await rolesCollection().find({}).toArray();
  approvedRolesCache.clear();
  roles.forEach(({ guildId, roleIds }) => approvedRolesCache.set(snowflake(guildId), loadIdList(roleIds)));
  const users = await approvedUsersCollection().find({}).toArray();
  approvedUsersCache.clear();
  users.forEach(({ guildId, userIds }) => approvedUsersCache.set(snowflake(guildId), loadIdList(userIds)));
  console.log("Approved role/user caches loaded");
}

function memberRoleIds(member) {
  const ids = new Set();
  if (member?.roles?.cache) {
    for (const id of member.roles.cache.keys()) ids.add(snowflake(id));
  }
  if (Array.isArray(member?._roles)) {
    for (const id of member._roles) ids.add(snowflake(id));
  }
  return ids;
}

function hasApprovedRole(member) {
  if (!member) return false;
  const guildId = snowflake(member.guild?.id);
  const roles = approvedRolesCache.get(guildId) || [];
  const users = approvedUsersCache.get(guildId) || [];
  if (users.includes(snowflake(member.id))) return true;
  const have = memberRoleIds(member);
  return roles.some((id) => have.has(id));
}

function isGuildAdmin(member) {
  if (!member) return false;
  if (snowflake(member.guild?.ownerId) === snowflake(member.id)) return true;
  const perms = member.permissions;
  if (!perms) return false;
  return perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageGuild);
}

function canManageThemes(member) {
  return isGuildAdmin(member) || hasApprovedRole(member);
}

function normalizeUserCooldownMinutes(value) {
  if (value === null || value === undefined || value === "inherit") return null;
  if (value === false) return 0;
  if (value === true) return null;
  return clampCooldownMinutes(value);
}

async function setMemberThemeSong(userId, url, duration, username, cooldownMinutes = null) {
  if (!isYoutubeUrl(url) && !isSoundcloudUrl(url)) {
    throw new Error("Provide a valid YouTube or SoundCloud URL.");
  }
  if (typeof url !== "string" || url.length > 500) {
    throw new Error("URL is too long.");
  }
  const clippedDuration = clampDuration(duration);
  const minutes = normalizeUserCooldownMinutes(cooldownMinutes);
  const start = parseStartSeconds(url);
  const existing = await getMemberThemeSong(userId);
  let recordedStart = existing && existing.start != null ? Number(existing.start) : null;
  if (existing && existing.clipId && !Number.isFinite(recordedStart)) {
    const storedMeta = await clipsCollection().findOne({ _id: existing.clipId }, { projection: { start: 1 } });
    if (storedMeta && storedMeta.start != null) recordedStart = Number(storedMeta.start);
  }
  const sameClip =
    existing &&
    trackKey(existing.url) === trackKey(url) &&
    Number(existing.duration) === clippedDuration &&
    start === parseStartSeconds(existing.url) &&
    (recordedStart === null || recordedStart === start) &&
    audioBufferFromTheme(existing);

  if (sameClip) {
    const clipId = existing.clipId || libraryClipKey(url, clippedDuration);
    const library = await clipsCollection().findOne({ _id: clipId }, { projection: { title: 1 } });
    const title = baseClipTitle(existing.title || (library && library.title));
    await themesCollection().updateOne(
      { _id: userId },
      {
        $set: {
          "theme_song.url": url,
          "theme_song.duration": clippedDuration,
          "theme_song.start": start,
          "theme_song.username": username || null,
          "theme_song.cooldown": minutes !== 0,
          "theme_song.cooldownMinutes": minutes,
          "theme_song.clipId": clipId,
          "theme_song.title": title,
        },
      },
    );
    return { duration: clippedDuration, clipped: false };
  }

  const library = await clipsCollection().findOne({ _id: libraryClipKey(url, clippedDuration) });
  const libraryBuf = audioBufferFromTheme(library);
  if (libraryBuf) {
    await themesCollection().updateOne(
      { _id: userId },
      {
        $set: {
          theme_song: {
            url: library.url || url,
            duration: clippedDuration,
            start: library.start != null ? Number(library.start) : start,
            username: username || null,
            cooldown: minutes !== 0,
            cooldownMinutes: minutes,
            audio: new Binary(libraryBuf),
            audioFormat: library.audioFormat || "ogg",
            clipId: library._id,
            title: library.title || "",
          },
        },
      },
      { upsert: true },
    );
    return { duration: clippedDuration, clipped: false };
  }

  const clipped = await buildThemeClip(userId, url, clippedDuration);
  let title = clipped.title;
  if (!title) {
    const storedClip = await clipsCollection().findOne(
      { _id: libraryClipKey(url, clippedDuration) },
      { projection: { title: 1 } },
    );
    title = (storedClip && storedClip.title) || (await fetchClipTitle(url));
  }
  const clipId = await upsertLibraryClip(url, clippedDuration, clipped.buf, title, { skipTitle: true });
  await themesCollection().updateOne(
    { _id: userId },
    {
      $set: {
        theme_song: {
          url,
          duration: clippedDuration,
          start,
          username: username || null,
          cooldown: minutes !== 0,
          cooldownMinutes: minutes,
          audio: new Binary(clipped.buf),
          audioFormat: "ogg",
          clipId,
          title,
        },
      },
    },
    { upsert: true },
  );
  console.log("saved theme clip to mongo", userId, clipped.buf.length, "bytes", title ? `title=${title}` : "no title");
  return { duration: clippedDuration, clipped: true };
}

async function getClipTitle(clipId) {
  const existing = await clipsCollection().findOne({ _id: clipId }, { projection: { title: 1 } });
  if (existing && existing.title) return existing.title;
  const fromTheme = await themesCollection().findOne(
    { "theme_song.clipId": clipId },
    { projection: { "theme_song.title": 1 } },
  );
  return (fromTheme && fromTheme.theme_song && fromTheme.theme_song.title) || "";
}

async function listLibraryClips() {
  const stored = await clipsCollection().find({}, { projection: { audio: 0 } }).toArray();
  const themes = await themesCollection()
    .find(
      { "theme_song.url": { $exists: true } },
      { projection: { "theme_song.url": 1, "theme_song.duration": 1, "theme_song.clipId": 1, "theme_song.title": 1 } },
    )
    .toArray();
  const byId = new Map();
  for (const clip of stored) byId.set(clip._id, clip);
  for (const doc of themes) {
    const song = doc.theme_song || {};
    if (!song.url) continue;
    if (song.clipId) {
      const prev = byId.get(song.clipId);
      if (prev && song.title && !prev.title) prev.title = song.title;
      continue;
    }
    const id = libraryClipKey(song.url, song.duration);
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, {
        _id: id,
        url: song.url,
        duration: song.duration,
        start: parseStartSeconds(song.url),
        title: song.title || "",
      });
    } else if (song.title && !prev.title) {
      prev.title = song.title;
    }
  }
  return applyDuplicateTitleSuffixes([...byId.values()]);
}

async function resolveClipAudio(clipId) {
  const stored = await clipsCollection().findOne({ _id: clipId });
  const storedBuf = audioBufferFromTheme(stored);
  if (storedBuf) return { clip: stored, buf: storedBuf };

  const docs = await themesCollection()
    .find({ "theme_song.url": { $exists: true } }, { projection: { "theme_song.url": 1, "theme_song.duration": 1, "theme_song.clipId": 1 } })
    .toArray();
  for (const doc of docs) {
    const song = doc.theme_song || {};
    const id = song.clipId || (song.url && libraryClipKey(song.url, song.duration));
    if (id !== clipId) continue;
    const full = await themesCollection().findOne({ _id: doc._id });
    const songFull = full && full.theme_song;
    const buf = audioBufferFromTheme(songFull);
    if (!buf) continue;
    const title = cleanTitle((stored && stored.title) || (songFull && songFull.title));
    await clipsCollection().updateOne(
      { _id: clipId },
      {
        $set: {
          url: songFull.url,
          duration: songFull.duration,
          start: songFull.start != null ? Number(songFull.start) : parseStartSeconds(songFull.url),
          title,
          audio: new Binary(buf),
          audioFormat: songFull.audioFormat || "ogg",
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    return { clip: { ...(stored || {}), ...songFull, _id: clipId, title }, buf };
  }
  return { clip: stored, buf: null };
}

async function previewClipAudio(clipId) {
  const { buf } = await resolveClipAudio(clipId);
  return previewFromOgg(buf);
}

async function resolveAssignedClipAudio(userId) {
  const saved = await getMemberThemeSong(userId);
  if (!saved) return { saved: null, buf: null, title: "", clipId: "", source: "none" };

  if (saved.clipId) {
    const resolved = await resolveClipAudio(saved.clipId);
    if (resolved && resolved.buf) {
      return {
        saved,
        buf: Buffer.from(resolved.buf),
        title: cleanTitle((resolved.clip && resolved.clip.title) || saved.title),
        clipId: saved.clipId,
        source: "library:" + saved.clipId,
      };
    }
  }

  const fromTheme = audioBufferFromTheme(saved);
  if (fromTheme) {
    return {
      saved,
      buf: Buffer.from(fromTheme),
      title: cleanTitle(saved.title),
      clipId: saved.clipId || "",
      source: "theme_song.audio",
    };
  }

  if (saved.url) {
    const resolved = await resolveClipAudio(libraryClipKey(saved.url, saved.duration));
    if (resolved && resolved.buf) {
      const clipId = (resolved.clip && resolved.clip._id) || libraryClipKey(saved.url, saved.duration);
      return {
        saved,
        buf: Buffer.from(resolved.buf),
        title: cleanTitle((resolved.clip && resolved.clip.title) || saved.title),
        clipId,
        source: "libraryKey:" + clipId,
      };
    }
  }

  return { saved, buf: null, title: cleanTitle(saved.title), clipId: saved.clipId || "", source: "none" };
}

async function previewMemberAudio(userId) {
  const resolved = await resolveAssignedClipAudio(userId);
  return previewFromOgg(resolved.buf);
}

async function assignLibraryClip(clipId, userId, username, cooldownMinutes = null) {
  const { clip, buf } = await resolveClipAudio(clipId);
  if (!buf) throw Object.assign(new Error("That clip is not in the library."), { status: 404 });
  const minutes = normalizeUserCooldownMinutes(cooldownMinutes);
  await themesCollection().updateOne(
    { _id: userId },
    {
      $set: {
        theme_song: {
          url: clip.url,
          duration: clip.duration,
          start: clip.start != null ? Number(clip.start) : parseStartSeconds(clip.url),
          username: username || null,
          cooldown: minutes !== 0,
          cooldownMinutes: minutes,
          audio: new Binary(buf),
          audioFormat: clip.audioFormat || "ogg",
          clipId: clip._id,
          title: clip.title || "",
        },
      },
    },
    { upsert: true },
  );
  return { duration: clip.duration, url: clip.url, clipped: false };
}

function themeUsesLibraryClip(song, clipId) {
  if (!song) return false;
  if (song.clipId) return String(song.clipId) === String(clipId);
  if (!song.url) return false;
  return libraryClipKey(song.url, song.duration) === clipId;
}

function removeDiskClipFiles(clipId) {
  const prefix = String(clipId || "");
  if (!prefix) return;
  for (const name of fs.readdirSync(CLIPS_DIR)) {
    if (name.startsWith(".")) continue;
    const matched = name === `${prefix}.ogg` || name.startsWith(`${prefix}.`);
    if (!matched) continue;
    try {
      fs.unlinkSync(path.join(CLIPS_DIR, name));
    } catch {
      /* ignore */
    }
  }
}

async function deleteLibraryClip(clipId) {
  const clip = await clipsCollection().findOne({ _id: clipId }, { projection: { audio: 0 } });
  let unassigned = 0;
  const themes = await themesCollection()
    .find(
      { "theme_song.url": { $exists: true } },
      { projection: { "theme_song.url": 1, "theme_song.duration": 1, "theme_song.clipId": 1, "theme_song.start": 1 } },
    )
    .toArray();
  for (const doc of themes) {
    if (!themeUsesLibraryClip(doc.theme_song, clipId)) continue;
    const filter = { _id: doc._id };
    if (doc.theme_song && doc.theme_song.clipId) filter["theme_song.clipId"] = clipId;
    const cleared = await themesCollection().updateOne(filter, { $unset: { theme_song: "" } });
    if (cleared.modifiedCount) unassigned += 1;
  }
  const deleted = await clipsCollection().deleteOne({ _id: clipId });
  removeDiskClipFiles(clipId);
  console.log(
    "deleted library clip",
    clipId,
    "mongoDeleted=" + deleted.deletedCount,
    "unassigned=" + unassigned,
    clip ? "" : "missing-doc",
  );
}

async function setMemberCooldownMinutes(userId, cooldownMinutes) {
  const minutes = normalizeUserCooldownMinutes(cooldownMinutes);
  const result = await themesCollection().updateOne(
    { _id: userId, "theme_song.url": { $exists: true } },
    {
      $set: {
        "theme_song.cooldownMinutes": minutes,
        "theme_song.cooldown": minutes !== 0,
      },
    },
  );
  if (!result.matchedCount) throw Object.assign(new Error("No theme saved for that user."), { status: 404 });
}

async function deleteMemberThemeSong(userId) {
  await themesCollection().updateOne({ _id: userId }, { $unset: { theme_song: "" } });
}

async function clearThemeCooldown(userId) {
  await themesCollection().updateOne({ _id: userId }, { $unset: { lastPlayedAt: "" } });
}

async function listThemeSongs() {
  return themesCollection()
    .aggregate([
      { $match: { "theme_song.url": { $exists: true, $nin: [null, ""] } } },
      {
        $addFields: {
          hasAudio: {
            $and: [
              { $ne: [{ $type: "$theme_song.audio" }, "missing"] },
              { $ne: [{ $type: "$theme_song.audio" }, "null"] },
            ],
          },
        },
      },
      { $project: { "theme_song.audio": 0 } },
    ])
    .toArray();
}

async function getMemberThemeSong(userId) {
  const user = await themesCollection().findOne({ _id: userId });
  if (!user || !user.theme_song) return null;
  return { ...user.theme_song, lastPlayedAt: user.lastPlayedAt || 0 };
}

async function markThemePlayed(userId) {
  await themesCollection().updateOne(
    { _id: userId },
    { $set: { lastPlayedAt: Date.now() } },
    { upsert: true },
  );
}

async function getGuildCooldownMinutes(guildId) {
  const doc = await guildSettingsCollection().findOne({ _id: guildId });
  return guildCooldownMinutesFromDoc(doc);
}

async function setGuildCooldownMinutes(guildId, minutes) {
  const value = clampCooldownMinutes(minutes);
  await guildSettingsCollection().updateOne(
    { _id: guildId },
    { $set: { cooldownMinutes: value, themeCooldown: value > 0 } },
    { upsert: true },
  );
  return value;
}

async function getGuildThemeCooldown(guildId) {
  return (await getGuildCooldownMinutes(guildId)) > 0;
}

async function setGuildThemeCooldown(guildId, enabled) {
  await setGuildCooldownMinutes(guildId, enabled ? DEFAULT_COOLDOWN_MINUTES : 0);
}

function getPlayer(guildId) {
  let player = players.get(guildId);
  if (!player) {
    player = createAudioPlayer();
    players.set(guildId, player);
  }
  return player;
}

function getThemeSession(guildId) {
  if (!themeSessions.has(guildId)) {
    themeSessions.set(guildId, {
      guildId,
      playingUserId: null,
      timeoutId: null,
      stallTimeoutId: null,
      queue: [],
      generation: 0,
      clipReplay: null,
      recovering: false,
      clipElapsedMs: 0,
      clipPlayingSince: 0,
    });
  }
  return themeSessions.get(guildId);
}

function enqueueThemeWork(guildId, fn) {
  const prev = themePlayLocks.get(guildId) || Promise.resolve();
  const run = prev.then(fn, fn);
  themePlayLocks.set(
    guildId,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

function cancelThemeSession(guildId) {
  const session = getThemeSession(guildId);
  session.generation += 1;
  session.playingUserId = null;
  session.queue = [];
  session.clipReplay = null;
  session.recovering = false;
  session.clipElapsedMs = 0;
  session.clipPlayingSince = 0;
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    session.timeoutId = null;
  }
  if (session.stallTimeoutId) {
    clearTimeout(session.stallTimeoutId);
    session.stallTimeoutId = null;
  }
}

function humanVoiceCount(channel) {
  if (!channel || !channel.members) return 0;
  return channel.members.filter((member) => member.user && !member.user.bot).size;
}

function botVoiceChannelId(guildId) {
  const connection = voiceConnections.get(guildId);
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return null;
  return connection.joinConfig.channelId || null;
}

function maybeLeaveIfEmpty(guildId) {
  const channelId = botVoiceChannelId(guildId);
  if (!channelId) return;
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  if (humanVoiceCount(channel) > 0) return;
  cancelThemeSession(guildId);
  const connection = voiceConnections.get(guildId);
  try {
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  } catch {
    /* ignore */
  }
  voiceConnections.delete(guildId);
  const player = players.get(guildId);
  if (player) {
    try {
      player.stop(true);
    } catch {
      /* ignore */
    }
  }
}

async function maintainConnection(channel, player) {
  const guildId = channel.guild.id;
  let connection = voiceConnections.get(guildId);
  const usable = connection && connection.state.status !== VoiceConnectionStatus.Destroyed;

  if (usable && connection.joinConfig.channelId === channel.id) {
    if (!connection.state.subscription || connection.state.subscription.player !== player) {
      connection.subscribe(player);
    }
    if (connection.state.status !== VoiceConnectionStatus.Ready) {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    }
    return connection;
  }

  if (usable && typeof connection.rejoin === "function") {
    const rejoined = connection.rejoin({
      channelId: channel.id,
      selfDeaf: false,
      selfMute: false,
    });
    if (rejoined) {
      connection.subscribe(player);
      voiceConnections.set(guildId, connection);
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      return connection;
    }
  }

  if (usable) {
    try {
      connection.destroy();
    } catch {
      /* ignore */
    }
  }

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
  });
  connection.on("error", (error) => console.error("Voice connection error:", error));
  voiceConnections.set(guildId, connection);
  connection.subscribe(player);
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  return connection;
}

function voiceConnectionReady(guildId) {
  const connection = voiceConnections.get(guildId);
  return Boolean(connection && connection.state.status === VoiceConnectionStatus.Ready);
}

function nextPlayId(player) {
  const id = (playerPlayIds.get(player) || 0) + 1;
  playerPlayIds.set(player, id);
  return id;
}

function currentPlayId(player) {
  return playerPlayIds.get(player) || 0;
}

function playResource(player, stream, opts, onDone) {
  const playId = nextPlayId(player);
  let finished = false;
  let startedPlaying = false;
  const done = (completed) => {
    if (finished) return;
    finished = true;
    if (typeof onDone === "function") onDone(completed === true);
  };

  const inlineVolume = opts.inlineVolume !== false;
  const resource = createAudioResource(stream, {
    inlineVolume,
    inputType: opts.inputType,
  });
  if (inlineVolume && resource.volume) resource.volume.setVolume(defaultVolumeLevel);

  player.removeAllListeners("error");
  player.removeAllListeners(AudioPlayerStatus.Idle);
  player.removeAllListeners(AudioPlayerStatus.Playing);
  player.removeAllListeners(AudioPlayerStatus.Buffering);
  player.removeAllListeners(AudioPlayerStatus.Paused);
  player.removeAllListeners(AudioPlayerStatus.AutoPaused);

  player.on("error", (error) => {
    console.error("AudioPlayer error:", error.message || error);
    try {
      if (stream && typeof stream.destroy === "function") stream.destroy();
    } catch {
      /* ignore */
    }
    done(false);
  });

  const onPlayingCb = typeof opts.onPlaying === "function" ? opts.onPlaying : null;
  const onHoldCb = typeof opts.onHold === "function" ? opts.onHold : null;
  const onPlaying = () => {
    if (playId !== currentPlayId(player)) return;
    startedPlaying = true;
    if (onPlayingCb) onPlayingCb();
  };
  const onHold = () => {
    if (playId !== currentPlayId(player)) return;
    if (onHoldCb) onHoldCb();
  };
  if (onPlayingCb || typeof onDone === "function") {
    player.on(AudioPlayerStatus.Playing, onPlaying);
  }
  if (onHoldCb) {
    if (AudioPlayerStatus.Buffering) player.on(AudioPlayerStatus.Buffering, onHold);
    if (AudioPlayerStatus.Paused) player.on(AudioPlayerStatus.Paused, onHold);
    if (AudioPlayerStatus.AutoPaused) player.on(AudioPlayerStatus.AutoPaused, onHold);
  }
  if (typeof onDone === "function") {
    player.on(AudioPlayerStatus.Idle, () => {
      if (playId !== currentPlayId(player)) return;
      if (opts.guildId && !voiceConnectionReady(opts.guildId)) {
        console.log("voice Idle during connection transition; will replay if still current");
        if (typeof opts.onInterrupted === "function") opts.onInterrupted();
        else done(false);
        return;
      }
      try {
        if (stream && typeof stream.destroy === "function") stream.destroy();
      } catch {
        /* ignore */
      }
      player.removeAllListeners("error");
      player.removeAllListeners(AudioPlayerStatus.Idle);
      player.removeAllListeners(AudioPlayerStatus.Playing);
      player.removeAllListeners(AudioPlayerStatus.Buffering);
      player.removeAllListeners(AudioPlayerStatus.Paused);
      player.removeAllListeners(AudioPlayerStatus.AutoPaused);
      done(startedPlaying);
    });
  }

  player.play(resource);
}

function onThemeDone(guildId, generation, completed) {
  const session = getThemeSession(guildId);
  if (session.generation !== generation) return;
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    session.timeoutId = null;
  }
  if (session.stallTimeoutId) {
    clearTimeout(session.stallTimeoutId);
    session.stallTimeoutId = null;
  }
  const userId = session.playingUserId;
  session.playingUserId = null;
  session.clipReplay = null;
  session.clipElapsedMs = 0;
  session.clipPlayingSince = 0;
  if (!completed) {
    const player = players.get(guildId);
    if (player) {
      player.removeAllListeners("error");
      player.removeAllListeners(AudioPlayerStatus.Idle);
      player.removeAllListeners(AudioPlayerStatus.Playing);
      player.removeAllListeners(AudioPlayerStatus.Buffering);
      player.removeAllListeners(AudioPlayerStatus.Paused);
      player.removeAllListeners(AudioPlayerStatus.AutoPaused);
      try {
        player.stop(true);
      } catch {
        /* already idle */
      }
    }
  }
  if (completed && userId) {
    markThemePlayed(userId).catch((error) => console.error("markThemePlayed:", error.message || error));
  }
  const next = session.queue.shift();
  if (next) startThemePlayback(next).catch((err) => console.error("Queued theme failed:", err));
}

function pauseClipTimer(session) {
  if (session.clipPlayingSince) {
    session.clipElapsedMs = (session.clipElapsedMs || 0) + (Date.now() - session.clipPlayingSince);
    session.clipPlayingSince = 0;
  }
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    session.timeoutId = null;
  }
  if (!session.stallTimeoutId && session.guildId) {
    const generation = session.generation;
    session.stallTimeoutId = setTimeout(() => {
      session.stallTimeoutId = null;
      if (session.generation !== generation) return;
      console.log("theme stall timeout; abandoning incomplete play");
      onThemeDone(session.guildId, generation, false);
    }, 10_000);
  }
}

function armClipStopTimer(session, player, generation, duration) {
  if (session.generation !== generation) return;
  if (session.stallTimeoutId) {
    clearTimeout(session.stallTimeoutId);
    session.stallTimeoutId = null;
  }
  if (session.timeoutId) clearTimeout(session.timeoutId);
  const total = playDurationMs(duration);
  const elapsed = Number(session.clipElapsedMs) || 0;
  const remaining = Math.max(300, total - elapsed);
  session.clipPlayingSince = Date.now();
  session.timeoutId = setTimeout(() => {
    if (session.generation !== generation) return;
    session.clipPlayingSince = 0;
    if (player.state.status !== AudioPlayerStatus.Idle) player.stop();
  }, remaining);
}

async function recoverThemeAfterVoiceReady(guildId, generation) {
  const session = getThemeSession(guildId);
  if (session.generation !== generation) return;
  if (session.recovering) return;
  if (!session.clipReplay) {
    onThemeDone(guildId, generation, false);
    return;
  }
  session.recovering = true;
  pauseClipTimer(session);
  session.clipElapsedMs = 0;
  try {
    const replay = session.clipReplay;
    const player = getPlayer(guildId);
    const connection = voiceConnections.get(guildId);
    if (!connection) {
      onThemeDone(guildId, generation, false);
      return;
    }
    try {
      await waitVoiceReady(connection);
    } catch {
      onThemeDone(guildId, generation, false);
      return;
    }
    if (session.generation !== generation || !session.clipReplay) return;
    if (player.state.status === AudioPlayerStatus.Playing) return;
    console.log("replaying theme after voice Ready for", replay.userId);
    await primeVoiceAfterReady(player, connection, () => session.generation === generation);
    if (session.generation !== generation || !session.clipReplay) return;
    const playOpts = {
      inlineVolume: replay.playOpts.inlineVolume,
      inputType: replay.playOpts.inputType,
      guildId,
      onPlaying: () => armClipStopTimer(session, player, generation, replay.duration),
      onHold: () => pauseClipTimer(session),
      onInterrupted: () => {
        void recoverThemeAfterVoiceReady(guildId, generation);
      },
    };
    playResource(player, Readable.from(replay.buf), playOpts, (completed) => onThemeDone(guildId, generation, completed));
  } catch (error) {
    console.error("theme recover failed:", error.message || error);
    if (getThemeSession(guildId).generation === generation) onThemeDone(guildId, generation, false);
  } finally {
    const current = getThemeSession(guildId);
    if (current.generation === generation) current.recovering = false;
  }
}

async function requestThemePlay(channel, url, duration, userId, lastPlayedAt, userCooldownMinutes) {
  if (!channel || !url || !userId) return;

  const guildId = channel.guild.id;
  const player = getPlayer(guildId);
  const session = getThemeSession(guildId);
  if (
    session.playingUserId === userId &&
    botVoiceChannelId(guildId) === channel.id &&
    player.state.status === AudioPlayerStatus.Playing
  ) {
    return;
  }

  const guildMinutes = await withTimeout(getGuildCooldownMinutes(guildId), 10_000, "cooldown lookup");
  const cooldownMs = effectiveCooldownMs(guildMinutes, userCooldownMinutes);
  if (cooldownMs > 0 && lastPlayedAt && Date.now() - Number(lastPlayedAt) < cooldownMs) {
    console.log("Skipping theme; cooldown active for", userId);
    return;
  }

  if (session.playingUserId) {
    console.log(
      session.playingUserId === userId
        ? "Restarting theme from the beginning for " + userId
        : "Preempting theme of " + session.playingUserId + " with " + userId,
    );
    cancelThemeSession(guildId);
    player.removeAllListeners("error");
    player.removeAllListeners(AudioPlayerStatus.Idle);
    player.removeAllListeners(AudioPlayerStatus.Playing);
    player.removeAllListeners(AudioPlayerStatus.Buffering);
    player.removeAllListeners(AudioPlayerStatus.Paused);
    player.removeAllListeners(AudioPlayerStatus.AutoPaused);
    try {
      player.stop(true);
    } catch {
      /* next playResource replaces the stream */
    }
  }

  const job = { channel, url, duration: clampDuration(duration), userId };
  await startThemePlayback(job);
}

async function startThemePlayback({ channel, url, duration, userId }) {
  const guildId = channel.guild.id;
  const session = getThemeSession(guildId);
  session.generation += 1;
  const generation = session.generation;
  session.playingUserId = userId;
  session.clipElapsedMs = 0;
  session.clipPlayingSince = 0;

  try {
    const player = getPlayer(guildId);
    const liveMember = channel.guild.members.cache.get(userId);
    const liveChannel = liveMember?.voice?.channel;
    const target = liveChannel && liveChannel.id ? liveChannel : channel;
    const connectP = maintainConnection(target, player);
    const ignoreConnect = () => {};
    connectP.catch(ignoreConnect);

    const assigned = await withTimeout(resolveAssignedClipAudio(userId), 10_000, "clip lookup");
    const audioBytes = assigned.buf;
    const playMeta = {
      title: assigned.title || "",
      clipId: assigned.clipId || "",
      source: assigned.source,
    };

    let stream;
    let playOpts = {};

    if (audioBytes) {
      console.log(
        "Playing theme for",
        userId,
        "title=" + (playMeta.title || "?"),
        "clipId=" + (playMeta.clipId || "-"),
        "source=" + playMeta.source,
        "bytes=" + audioBytes.length,
      );
      stream = Readable.from(audioBytes);
      playOpts = { inlineVolume: false, inputType: StreamType.OggOpus };
    } else if (isSoundcloudUrl(url)) {
      console.log("Playing live SoundCloud theme for", userId, url);
      stream = await withTimeout(scdl.download(url), 20_000, "soundcloud");
    } else {
      console.error("No saved clip for", userId, "- refusing live YouTube on join");
      connectP.catch(ignoreConnect);
      session.playingUserId = null;
      onThemeDone(guildId, generation);
      return;
    }

    if (session.generation !== generation) {
      connectP.catch(ignoreConnect);
      return;
    }

    const connection = await connectP;
    if (session.generation !== generation) return;

    await primeVoiceAfterReady(player, connection, () => session.generation === generation);
    if (session.generation !== generation) return;

    const clipDuration = (assigned.saved && assigned.saved.duration) || duration;
    if (audioBytes) {
      session.clipReplay = {
        userId,
        buf: audioBytes,
        playOpts: { inlineVolume: playOpts.inlineVolume, inputType: playOpts.inputType },
        duration: clipDuration,
      };
    } else {
      session.clipReplay = null;
    }
    playOpts.guildId = guildId;
    playOpts.onPlaying = () => armClipStopTimer(session, player, generation, clipDuration);
    playOpts.onHold = () => pauseClipTimer(session);
    playOpts.onInterrupted = () => {
      void recoverThemeAfterVoiceReady(guildId, generation);
    };
    playResource(player, stream, playOpts, (completed) => onThemeDone(guildId, generation, completed));
  } catch (error) {
    console.error("Error playing theme song:", error);
    onThemeDone(guildId, generation);
  }
}

async function playSoundBite(interaction, channel, url) {
  await interaction.deferUpdate();
  if (!isSoundcloudUrl(url)) {
    return interaction.followUp({ content: "Soundbites must be SoundCloud URLs.", ephemeral: true });
  }
  const guildId = channel.guild.id;
  await enqueueThemeWork(guildId, async () => {
    try {
      cancelThemeSession(guildId);
      const player = getPlayer(guildId);
      await maintainConnection(channel, player);
      const stream = await withTimeout(scdl.download(url), 20_000, "soundcloud");
      cancelThemeSession(guildId);
      playResource(player, stream, { inlineVolume: true });
    } catch (error) {
      console.error("soundbite play failed:", error.message || error);
    }
  });
}

async function playYoutube(channel, url) {
  if (!isYoutubeUrl(url)) throw new Error("Not a YouTube URL");
  const guildId = channel.guild.id;
  await enqueueThemeWork(guildId, async () => {
    cancelThemeSession(guildId);
    const player = getPlayer(guildId);
    await maintainConnection(channel, player);
    const cookies = prepareCookies();
    const proc = spawn(
      YT_DLP_BIN,
      [
        ...ytdlpProxyArgs(),
        "--js-runtimes",
        `node:${process.execPath}`,
        ...cookies.args,
        "-f",
        "bestaudio/best",
        "-o",
        "-",
        "--no-playlist",
        "--no-warnings",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const cleanupCookies = () => {
      if (!cookies.file) return;
      try {
        fs.unlinkSync(cookies.file);
      } catch {
        /* ignore */
      }
    };
    proc.on("close", cleanupCookies);
    proc.on("error", cleanupCookies);
    proc.stderr.on("data", (buf) => {
      const msg = buf.toString().trim();
      if (msg) console.error("yt-dlp:", msg);
    });
    cancelThemeSession(guildId);
    playResource(player, proc.stdout, { inlineVolume: true });
  });
}

async function addSoundbite(title, url) {
  if (!isSoundcloudUrl(url)) {
    return { success: false, message: "Provide a valid SoundCloud URL." };
  }
  const existing = await soundboardCollection().findOne({ title });
  if (existing) {
    return { success: false, message: `A soundbite named "${title}" already exists.` };
  }
  await soundboardCollection().insertOne({ title, url });
  return { success: true, message: `Soundbite "${title}" added.` };
}

async function deleteSoundbite(title) {
  await soundboardCollection().deleteOne({ title });
}

async function getSoundboard(page = 0) {
  const itemsPerPage = 20;
  const totalItems = await soundboardCollection().countDocuments();
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  const soundboard = await soundboardCollection()
    .find({})
    .skip(page * itemsPerPage)
    .limit(itemsPerPage)
    .toArray();
  return { soundboard, currentPage: page, totalPages };
}

async function sendSoundboard(interaction, soundboard, currentPage, totalPages, edit = false) {
  if (soundboard.length === 0) {
    const payload = { content: "Your soundboard is empty.", ephemeral: true };
    if (edit) await interaction.update({ content: payload.content, components: [] });
    else await interaction.reply(payload);
    return;
  }

  const components = [];
  for (let i = 0; i < soundboard.length; i += 5) {
    const row = new ActionRowBuilder();
    soundboard.slice(i, i + 5).forEach((soundbite) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`play-${soundbite.title}`)
          .setLabel(soundbite.title.slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      );
    });
    components.push(row);
  }

  const paginationRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("previous-page")
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId("next-page")
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1),
  );
  components.push(paginationRow);

  const payload = {
    content: `Your Soundboard (Page ${currentPage + 1} of ${totalPages}):`,
    components,
    ephemeral: true,
  };
  if (edit) await interaction.update({ content: payload.content, components });
  else await interaction.reply(payload);
}

async function approveRoleOrUser(interaction) {
  const member = interaction.member;
  if (!isGuildAdmin(member)) {
    return interaction.reply({ content: "Only the server owner or admins can approve theme managers.", ephemeral: true });
  }
  const role = interaction.options.getRole("role");
  const user = interaction.options.getUser("user");
  if (!role && !user) {
    return interaction.reply({ content: "Specify a role or a user.", ephemeral: true });
  }
  const guildId = snowflake(interaction.guild.id);
  const granted = [];
  if (role) {
    const roleId = snowflake(role.id);
    await rolesCollection().updateOne(
      { guildId },
      { $addToSet: { roleIds: roleId } },
      { upsert: true },
    );
    const approved = approvedRolesCache.get(guildId) || [];
    if (!approved.includes(roleId)) {
      approved.push(roleId);
      approvedRolesCache.set(guildId, approved);
    }
    granted.push(`role **${role.name}**`);
  }
  if (user) {
    const userId = snowflake(user.id);
    await approvedUsersCollection().updateOne(
      { guildId },
      { $addToSet: { userIds: userId } },
      { upsert: true },
    );
    const approved = approvedUsersCache.get(guildId) || [];
    if (!approved.includes(userId)) {
      approved.push(userId);
      approvedUsersCache.set(guildId, approved);
    }
    granted.push(`user **${user.tag}**`);
  }
  await interaction.reply({
    content: `${granted.join(" and ")} can manage theme songs and use /set-theme-gui.`,
    ephemeral: true,
  });
}

async function disapproveRoleOrUser(interaction) {
  const member = interaction.member;
  if (!isGuildAdmin(member)) {
    return interaction.reply({ content: "Only the server owner or admins can disapprove theme managers.", ephemeral: true });
  }
  const role = interaction.options.getRole("role");
  const user = interaction.options.getUser("user");
  if (!role && !user) {
    return interaction.reply({ content: "Specify a role or a user.", ephemeral: true });
  }
  const guildId = snowflake(interaction.guild.id);
  const revoked = [];
  if (role) {
    const roleId = snowflake(role.id);
    await rolesCollection().updateOne({ guildId }, { $pull: { roleIds: roleId } });
    const approved = (approvedRolesCache.get(guildId) || []).filter((id) => id !== roleId);
    approvedRolesCache.set(guildId, approved);
    revoked.push(`role **${role.name}**`);
  }
  if (user) {
    const userId = snowflake(user.id);
    await approvedUsersCollection().updateOne({ guildId }, { $pull: { userIds: userId } });
    const approved = (approvedUsersCache.get(guildId) || []).filter((id) => id !== userId);
    approvedUsersCache.set(guildId, approved);
    revoked.push(`user **${user.tag}**`);
  }
  await interaction.reply({
    content: `${revoked.join(" and ")} can no longer manage theme songs or use /set-theme-gui.`,
    ephemeral: true,
  });
}

const commands = [
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set the default volume for the bot")
    .addIntegerOption((option) =>
      option.setName("volume").setDescription("Volume level (0 to 100)").setRequired(true).setMinValue(0).setMaxValue(100),
    ),
  new SlashCommandBuilder()
    .setName("approve-role-or-user")
    .setDescription("Approve a role or user to manage theme songs")
    .addRoleOption((option) => option.setName("role").setDescription("Role to approve"))
    .addUserOption((option) => option.setName("user").setDescription("User to approve")),
  new SlashCommandBuilder()
    .setName("disapprove-role-or-user")
    .setDescription("Disapprove a role or user from managing theme songs")
    .addRoleOption((option) => option.setName("role").setDescription("Role to disapprove"))
    .addUserOption((option) => option.setName("user").setDescription("User to disapprove")),
  new SlashCommandBuilder()
    .setName("set-theme")
    .setDescription("Clip and save a theme song for voice joins")
    .addStringOption((option) => option.setName("url").setDescription("YouTube or SoundCloud URL").setRequired(true))
    .addIntegerOption((option) =>
      option.setName("duration").setDescription("Seconds to play (1-20)").setMinValue(MIN_DURATION).setMaxValue(MAX_DURATION),
    )
    .addBooleanOption((option) =>
      option.setName("cooldown").setDescription("Skip this theme for 15 minutes after it plays"),
    )
    .addUserOption((option) => option.setName("user").setDescription("Set a theme for someone else (managers only)")),
  new SlashCommandBuilder()
    .setName("set-theme-gui")
    .setDescription("Open the private theme manager for this server")
    .setDMPermission(false)
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName("theme-cooldown")
    .setDescription("Set the server default theme cooldown")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("True = use server cooldown, False = off"),
    )
    .addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription("Server cooldown minutes (0 = off)")
        .setMinValue(0)
        .setMaxValue(MAX_COOLDOWN_MINUTES),
    ),
  new SlashCommandBuilder()
    .setName("add-soundbite")
    .setDescription("Add a SoundCloud soundbite")
    .addStringOption((option) => option.setName("title").setDescription("Title").setRequired(true))
    .addStringOption((option) => option.setName("url").setDescription("SoundCloud URL").setRequired(true)),
  new SlashCommandBuilder()
    .setName("delete-soundbite")
    .setDescription("Delete a soundbite")
    .addStringOption((option) => option.setName("title").setDescription("Title").setRequired(true)),
  new SlashCommandBuilder().setName("soundboard").setDescription("View your soundboard"),
  new SlashCommandBuilder()
    .setName("yt")
    .setDescription("Play a YouTube URL in your voice channel")
    .addStringOption((option) => option.setName("url").setDescription("YouTube URL").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current playback"),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  for (const guild of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id), { body: commands });
  }
  console.log(`Registered slash commands for ${client.guilds.cache.size} guild(s)`);
}

client.once("ready", async () => {
  if (!client.user) return;
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await loadApprovedCaches();
    await registerCommands();
    getSilenceOgg().catch((error) => console.error("silence ogg:", error.message || error));
  } catch (error) {
    console.error("Startup error:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlash(interaction);
      return;
    }
    if (interaction.isButton()) await handleButton(interaction);
  } catch (error) {
    console.error("interaction error:", error);
    const content = `Error: ${error.message || error}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }
});

async function handleSlash(interaction) {
  const { commandName } = interaction;

  if (commandName === "volume") {
    const volume = interaction.options.getInteger("volume");
    defaultVolumeLevel = volume / 100;
    await volumeCollection.updateOne({ _id: "defaultVolume" }, { $set: { value: defaultVolumeLevel } }, { upsert: true });
    return interaction.reply({ content: `Default volume set to ${volume}%. New clips will use this level.`, ephemeral: true });
  }

  if (commandName === "approve-role-or-user") return approveRoleOrUser(interaction);
  if (commandName === "disapprove-role-or-user") return disapproveRoleOrUser(interaction);

  if (commandName === "theme-cooldown") {
    if (!canManageThemes(interaction.member)) {
      return interaction.reply({ content: "You cannot change the server theme cooldown.", ephemeral: true });
    }
    const minutesOpt = interaction.options.getInteger("minutes");
    const enabled = interaction.options.getBoolean("enabled");
    if (minutesOpt === null && enabled === null) {
      return interaction.reply({ content: "Set enabled or minutes.", ephemeral: true });
    }
    const minutes =
      minutesOpt !== null
        ? clampCooldownMinutes(minutesOpt)
        : enabled === false
          ? 0
          : DEFAULT_COOLDOWN_MINUTES;
    await setGuildCooldownMinutes(interaction.guild.id, minutes);
    return interaction.reply({
      content:
        minutes > 0
          ? `Server theme cooldown is ${minutes} minutes (a user can still set Off or a custom time).`
          : "Server theme cooldown is Off. Themes play on every join unless a user set their own cooldown.",
      ephemeral: true,
    });
  }

  if (commandName === "set-theme") {
    const url = interaction.options.getString("url");
    const duration = clampDuration(interaction.options.getInteger("duration") || DEFAULT_DURATION);
    const cooldownOpt = interaction.options.getBoolean("cooldown");
    const cooldownMinutes = cooldownOpt === false ? 0 : null;
    const targetUser = interaction.options.getUser("user");
    let userId = interaction.user.id;
    let label = interaction.user.username;

    if (targetUser) {
      if (!canManageThemes(interaction.member)) {
        return interaction.reply({ content: "You cannot set theme songs for other users.", ephemeral: true });
      }
      userId = targetUser.id;
      label = targetUser.username;
    }

    await interaction.deferReply({ ephemeral: true });
    const saved = await setMemberThemeSong(userId, url, duration, label, cooldownMinutes);
    return interaction.editReply({
      content: `${saved.clipped ? "Clipped and saved" : "Updated"} theme for ${label}: ${saved.duration}s from ${url}. Cooldown: ${
        cooldownMinutes === 0 ? "off" : "uses the server default"
      }.`,
    });
  }

  if (commandName === "set-theme-gui") {
    let member = interaction.member;
    try {
      member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    } catch {
      /* use the interaction member */
    }
    if (!canManageThemes(member)) {
      console.log("set-theme-gui denied", {
        userId: snowflake(interaction.user.id),
        guildId: snowflake(interaction.guild?.id),
        approvedUsers: approvedUsersCache.get(snowflake(interaction.guild?.id)) || [],
        approvedRoles: approvedRolesCache.get(snowflake(interaction.guild?.id)) || [],
        memberRoles: [...memberRoleIds(member)],
      });
      return interaction.reply({ content: "Only approved managers can open the theme desk.", ephemeral: true });
    }
    if (!themeGui) {
      return interaction.reply({ content: "Theme desk is not running.", ephemeral: true });
    }
    const token = themeGui.mintToken(interaction.user.id, interaction.guild.id);
    const url = `${themeGui.publicUrl}/?t=${token}`;
    return interaction.reply({
      content: `Theme desk for **${interaction.guild.name}**. Only you can see this. The link expires in 2 hours.\n${url}`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open theme desk").setURL(url),
        ),
      ],
      ephemeral: true,
    });
  }

  if (commandName === "add-soundbite") {
    const title = interaction.options.getString("title");
    const url = interaction.options.getString("url");
    const response = await addSoundbite(title, url);
    return interaction.reply({ content: response.message, ephemeral: true });
  }

  if (commandName === "delete-soundbite") {
    const title = interaction.options.getString("title");
    await deleteSoundbite(title);
    return interaction.reply({ content: `Soundbite "${title}" deleted.`, ephemeral: true });
  }

  if (commandName === "soundboard") {
    const { soundboard, currentPage, totalPages } = await getSoundboard(0);
    soundboardState[interaction.user.id] = { page: currentPage, totalPages };
    return sendSoundboard(interaction, soundboard, currentPage, totalPages, false);
  }

  if (commandName === "yt") {
    const channel = interaction.member.voice.channel;
    if (!channel) {
      return interaction.reply({ content: "Join a voice channel first.", ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    await playYoutube(channel, interaction.options.getString("url"));
    return interaction.editReply({ content: "Playing YouTube." });
  }

  if (commandName === "skip") {
    const channel = interaction.member.voice.channel;
    if (!channel) {
      return interaction.reply({ content: "Join a voice channel first.", ephemeral: true });
    }
    const player = getPlayer(channel.guild.id);
    if (player.state.status === AudioPlayerStatus.Idle) {
      return interaction.reply({ content: "Nothing is playing.", ephemeral: true });
    }
    cancelThemeSession(channel.guild.id);
    player.removeAllListeners("error");
    player.removeAllListeners(AudioPlayerStatus.Idle);
    player.removeAllListeners(AudioPlayerStatus.Playing);
    player.removeAllListeners(AudioPlayerStatus.Buffering);
    player.removeAllListeners(AudioPlayerStatus.Paused);
    player.removeAllListeners(AudioPlayerStatus.AutoPaused);
    player.stop(true);
    return interaction.reply({ content: "Skipped.", ephemeral: true });
  }
}

async function handleButton(interaction) {
  const userId = interaction.user.id;
  const [action, title] = interaction.customId.split("-");
  if (!soundboardState[userId]) {
    const initial = await getSoundboard(0);
    soundboardState[userId] = { page: initial.currentPage, totalPages: initial.totalPages };
  }
  const state = soundboardState[userId];

  if (action === "play") {
    const { soundboard } = await getSoundboard(state.page);
    const soundbite = soundboard.find((item) => item.title === title);
    if (!soundbite) {
      return interaction.reply({ content: "That soundboard is stale. Run /soundboard again.", ephemeral: true });
    }
    const channel = interaction.member.voice.channel;
    if (!channel) {
      return interaction.reply({ content: "Join a voice channel first.", ephemeral: true });
    }
    return playSoundBite(interaction, channel, soundbite.url);
  }

  if (action === "previous" || action === "next") {
    state.page = action === "previous" ? Math.max(0, state.page - 1) : Math.min(state.totalPages - 1, state.page + 1);
    const { soundboard, currentPage, totalPages } = await getSoundboard(state.page);
    state.page = currentPage;
    state.totalPages = totalPages;
    return sendSoundboard(interaction, soundboard, currentPage, totalPages, true);
  }
}

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (oldState.channelId === newState.channelId) return;
  const member = newState.member;
  if (!member || member.user.bot) return;

  const guildId = newState.guild.id;

  if (!newState.channelId) {
    await enqueueThemeWork(guildId, async () => maybeLeaveIfEmpty(guildId));
    return;
  }

  await enqueueThemeWork(guildId, async () => {
    try {
      const liveMember = newState.guild.members.cache.get(member.id) || member;
      const liveChannel = liveMember.voice?.channel;
      if (!liveChannel || (typeof liveChannel.isVoiceBased === "function" && !liveChannel.isVoiceBased())) {
        maybeLeaveIfEmpty(guildId);
        return;
      }

      const theme = await withTimeout(getMemberThemeSong(member.id), 10_000, "theme lookup");
      if (!theme) {
        maybeLeaveIfEmpty(guildId);
        return;
      }

      await requestThemePlay(
        liveChannel,
        theme.url,
        theme.duration,
        member.id,
        theme.lastPlayedAt,
        userCooldownMinutesFromTheme(theme),
      );
    } catch (error) {
      console.error("Error requesting theme play:", error);
    }
  });
});

async function syncStoredClipTitles() {
  const clips = await clipsCollection()
    .find({ title: { $exists: true, $nin: [null, ""] } }, { projection: { title: 1 } })
    .toArray();
  const titled = new Map(
    clips
      .map((clip) => [clip._id, baseClipTitle(clip.title)])
      .filter(([, title]) => title),
  );
  if (!titled.size) return;
  const themes = await themesCollection()
    .find(
      { "theme_song.url": { $exists: true } },
      { projection: { "theme_song.url": 1, "theme_song.duration": 1, "theme_song.clipId": 1, "theme_song.title": 1 } },
    )
    .toArray();
  let copied = 0;
  for (const doc of themes) {
    const song = doc.theme_song || {};
    if (song.title) continue;
    const id = song.clipId || (song.url && libraryClipKey(song.url, song.duration));
    const title = titled.get(id);
    if (!title) continue;
    await themesCollection().updateOne(
      { _id: doc._id },
      { $set: { "theme_song.title": title, "theme_song.clipId": id } },
    );
    copied += 1;
  }
  if (copied) console.log("copied stored clip titles onto", copied, "theme songs");
}

async function main() {
  await connectMongo();
  syncStoredClipTitles().catch((error) => console.error("title sync:", error));
  themeGui = startThemeGui({
    client,
    canManageThemes,
    setMemberThemeSong,
    deleteMemberThemeSong,
    listThemeSongs,
    getGuildCooldownMinutes,
    setGuildCooldownMinutes,
    setMemberCooldownMinutes,
    listLibraryClips,
    getClipTitle,
    assignLibraryClip,
    deleteLibraryClip,
    previewClipAudio,
    previewMemberAudio,
    importUploadedClip,
    trimLibraryClip,
    libraryClipKey,
    clearThemeCooldown,
    clampDuration,
    clampCooldownMinutes,
    userCooldownMinutesFromTheme,
    DEFAULT_COOLDOWN_MINUTES,
    minDuration: MIN_DURATION,
    maxDuration: MAX_DURATION,
    defaultDuration: DEFAULT_DURATION,
  });
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
