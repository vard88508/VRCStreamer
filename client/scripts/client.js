import { createStreamer } from "./streamer.js";
import { createUi } from "./ui.js";

const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~";
const storagePrefix = "vrc-audio-streamer-";
const storageVersion = "2";

const storageKeys = {
  version: `${storagePrefix}storage-version`,
  code: `${storagePrefix}code`,
  server: `${storagePrefix}server`,
  customApi: `${storagePrefix}custom-api`,
  customPassword: `${storagePrefix}custom-password`,
  bookmarkedServers: `${storagePrefix}bookmarked-servers`,
  serverMeta: `${storagePrefix}server-meta`,
  encoderMode: `${storagePrefix}encoder-mode`,
  micDevice: `${storagePrefix}mic-device`,
  language: `${storagePrefix}language`,
  sourceSettings: `${storagePrefix}source-settings`
};

const config = {
  streamCodeLength: 32,
  sampleRate: 48000,
  channels: 2,
  framesPerChunk: 1024,
  expectedAacConfigHex: "1190",
  statsRefreshMs: 15000,
  configRefreshMs: 60000,
  monitorOutputGain: 0.0001,
  videoWidth: 1280,
  videoHeight: 720,
  videoFps: 30,
  videoCaptureFps: 30,
  videoBitrate: 2500000,
  videoPlaceholderHoldMs: 15000,
  maxAudioWsBufferedBytes: 256 * 1024,
  maxVideoWsBufferedBytes: 1024 * 1024,
  isFirefoxBased: /\b(Firefox|FxiOS|Waterfox|LibreWolf|Iceweasel)\b/i.test(navigator.userAgent),
  patronTiers: [
    { key: "Tier4", className: "tier4" },
    { key: "Tier3", className: "tier3" },
    { key: "Tier2", className: "tier2" },
    { key: "Tier1", className: "tier1" }
  ]
};

config.expectedEncodedFps = config.sampleRate / config.framesPerChunk;
config.expectedEncodedFpsLabel = config.expectedEncodedFps.toFixed(1);
config.videoKeyframeInterval = config.videoFps * 2;
config.videoFramePeriodUs = Math.round(1000000 / config.videoFps);

const encoderModes = {
  native192: {
    bitrate: 192000,
    preferNative: true,
    allowWasmFallback: false,
    nativeAacBitrates: [192000]
  },
  wasm192: {
    bitrate: 192000,
    preferNative: false,
    allowWasmFallback: true,
    nativeAacBitrates: []
  },
  wasm320: {
    bitrate: 320000,
    preferNative: false,
    allowWasmFallback: true,
    nativeAacBitrates: []
  }
};

const fallbackServers = [
  {
    name: "Local 554",
    description: "Local test server on default RTSP port 554.",
    apiBase: "http://127.0.0.1:8081",
    rtspBase: "rtsp://127.0.0.1"
  },
  {
    name: "Local 8554",
    description: "Local test server on RTSP port 8554.",
    apiBase: "http://127.0.0.1:8081",
    rtspBase: "rtsp://127.0.0.1:8554"
  }
];

let active = null;
let streamCode = "";
let baseServers = fallbackServers;
let bookmarkedServers = [];
let servers = fallbackServers;
let serverMetaCache = Object.create(null);
let serverInfo = null;
let nativeAacAvailable = true;
let sourceRequestInFlight = false;
let linkRestartInFlight = false;
let urlSeq = 0;
let remoteDataSeq = 0;
let remoteDataUrl = "";
let remoteDataLoaded = false;
let clientConfig = { langs: { en: "English" }, servers: [], motd: null, patrons: null, remoteData: "" };

const app = {
  config,
  storageKeys,
  encoderModes,
  get active() { return active; },
  set active(value) { active = value; },
  get streamCode() { return streamCode; },
  set streamCode(value) { streamCode = value; },
  get nativeAacAvailable() { return nativeAacAvailable; },
  set nativeAacAvailable(value) { nativeAacAvailable = Boolean(value); },
  get sourceRequestInFlight() { return sourceRequestInFlight; },
  set sourceRequestInFlight(value) { sourceRequestInFlight = Boolean(value); },
  get linkRestartInFlight() { return linkRestartInFlight; },
  set linkRestartInFlight(value) { linkRestartInFlight = Boolean(value); },
  readStorage,
  writeStorage,
  readJsonStorage,
  writeJsonStorage,
  selectedEncoderMode,
  selectedServer,
  serverKey,
  serverDisplayName,
  serverDescription,
  currentServerInfo,
  serverVideoEnabled,
  wsUrlForCode,
  waitForOpen,
  handleStreamerMessage
};

const ui = createUi(app);
const streamer = createStreamer(app);
app.ui = ui;
app.streamer = streamer;
window.force_resync = streamer.forceResync;

function readStorage(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}

function readJsonStorage(key, fallback) {
  try {
    const value = JSON.parse(readStorage(key, ""));
    return value == null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  writeStorage(key, JSON.stringify(value));
}

function resetStorageIfVersionChanged() {
  try {
    if (localStorage.getItem(storageKeys.version) === storageVersion) return;
    const keep = new Set([storageKeys.bookmarkedServers]);
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(storagePrefix) && !keep.has(key)) keys.push(key);
    }
    keys.forEach(key => localStorage.removeItem(key));
    localStorage.setItem(storageKeys.version, storageVersion);
  } catch (_) {}
}

function randomCode() {
  const bytes = new Uint8Array(config.streamCodeLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += charset[byte % charset.length];
  return out;
}

function validStoredCode(code) {
  return typeof code === "string"
    && code.length === config.streamCodeLength
    && /^[\x21-\x7e]+$/.test(code);
}

function saveCode(code) {
  streamCode = code;
  writeStorage(storageKeys.code, code);
}

function rotateCode() {
  const code = randomCode();
  saveCode(code);
  return code;
}

function loadCode() {
  const saved = readStorage(storageKeys.code);
  return validStoredCode(saved) ? saved : rotateCode();
}

async function streamHashHex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < 16; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function normalizeBase(value, defaultProtocol) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = defaultProtocol + text;
  return text.replace(/\/+$/, "");
}

function normalizeServerEntry(entry) {
  if (typeof entry === "string") entry = { apiBase: entry };
  if (!entry || typeof entry !== "object") return null;
  const apiBase = entry.apiBase || entry.api || entry.http || entry.host || "";
  const rtspBase = entry.rtspBase || entry.rtsp || entry.media || "";
  if (typeof apiBase !== "string" || typeof rtspBase !== "string") return null;
  if (!apiBase.trim()) return null;
  return {
    name: String(entry.name || entry.label || "").trim(),
    description: String(entry.description || "").trim(),
    apiBase: apiBase.trim(),
    rtspBase: rtspBase.trim(),
    password: String(entry.password || "").trim(),
    video: entry.video === true
  };
}

function hostLabel(value) {
  try {
    return new URL(normalizeBase(value, "https://")).host;
  } catch (_) {
    return String(value || "").trim() || "Server";
  }
}

function hostName(value, defaultProtocol) {
  try {
    return new URL(normalizeBase(value, defaultProtocol)).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function isLoopbackBase(value, defaultProtocol) {
  return isLoopbackHost(hostName(value, defaultProtocol));
}

function safeRtspBaseForServer(server, value) {
  const base = normalizeBase(value, "rtsp://").replace(/^rtspt:\/\//i, "rtsp://");
  if (!base) return "";
  return !isLoopbackBase(server.apiBase, "https://") && isLoopbackBase(base, "rtsp://") ? "" : base;
}

function sameServer(left, right) {
  return normalizeBase(left.apiBase, "https://") === normalizeBase(right.apiBase, "https://");
}

function serverKey(server) {
  const apiDefault = location.protocol === "https:" ? "https://" : "http://";
  return normalizeBase(server.apiBase, apiDefault);
}

function normalizeServerMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  return {
    name: String(meta.name || "").trim(),
    description: String(meta.description || "").trim(),
    rtspBase: String(meta.rtspBase || meta.rtsp_base || "").trim(),
    video: Boolean(meta.video)
  };
}

function loadServerMetaCache() {
  serverMetaCache = Object.create(null);
  const saved = readJsonStorage(storageKeys.serverMeta, {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  for (const [key, value] of Object.entries(saved)) {
    const meta = normalizeServerMeta(value);
    if (meta && (meta.name || meta.description || meta.rtspBase || meta.video)) serverMetaCache[key] = meta;
  }
}

function saveServerMetaCache() {
  writeJsonStorage(storageKeys.serverMeta, serverMetaCache);
}

function savedServerMeta(server) {
  return serverMetaCache[serverKey(server)] || null;
}

function serverDisplayName(server) {
  const meta = savedServerMeta(server);
  const video = meta ? meta.video : Boolean(server.video);
  const name = ((meta && meta.name) || server.name || hostLabel(server.apiBase))
    .replace(/^[🔊📺]\s*/u, "")
    .replace(/\s*[🔊📺]\s*$/u, "");
  return `${name} ${video ? "📺" : "🔊"}`;
}

function serverDescription(server) {
  const meta = savedServerMeta(server);
  return (meta && meta.description) || server.description || "";
}

function serverRtspBase(server) {
  const meta = savedServerMeta(server);
  return safeRtspBaseForServer(server, (meta && meta.rtspBase) || server.rtspBase || "");
}

function currentServerKey() {
  return serverKey(selectedServer());
}

function currentServerInfo() {
  return serverInfo && serverInfo.key === currentServerKey() ? serverInfo : null;
}

function serverVideoEnabled() {
  const info = currentServerInfo();
  if (info) return Boolean(info.video);
  const meta = savedServerMeta(selectedServer());
  return Boolean(meta && meta.video);
}

function loadBookmarkedServers() {
  const saved = readJsonStorage(storageKeys.bookmarkedServers, []);
  bookmarkedServers = Array.isArray(saved)
    ? saved.map(normalizeServerEntry).filter(Boolean)
    : [];
}

function saveBookmarkedServers() {
  writeJsonStorage(storageKeys.bookmarkedServers, bookmarkedServers);
}

function rebuildServers() {
  servers = baseServers.concat(bookmarkedServers);
}

function normalizeRemoteData(payload) {
  const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return {
    motd: data.motd && typeof data.motd === "object" && !Array.isArray(data.motd) ? data.motd : null,
    patrons: data.patrons && typeof data.patrons === "object" && !Array.isArray(data.patrons) ? data.patrons : null
  };
}

function normalizeConfig(payload) {
  const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const remoteData = typeof data.remoteData === "string" ? data.remoteData.trim() : "";
  return {
    langs: data.langs && typeof data.langs === "object" && !Array.isArray(data.langs) ? data.langs : { en: "English" },
    servers: Array.isArray(data.servers) ? data.servers : [],
    remoteData,
    ...normalizeRemoteData(data)
  };
}

async function fetchJson(urlInput) {
  const url = new URL(urlInput, location.href);
  url.searchParams.set("t", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url.pathname} ${response.status}`);
  return await response.json();
}

async function loadRemoteData(url) {
  if (!url) return null;
  try {
    return normalizeRemoteData(await fetchJson(url));
  } catch (_) {
    return null;
  }
}

function applyPageData(data) {
  ui.setMotdPayload(data.motd);
  ui.setPatronsPayload(data.patrons);
}

async function loadClientConfig() {
  const seq = ++remoteDataSeq;
  try {
    clientConfig = normalizeConfig(await fetchJson("config.json"));
  } catch (_) {
    clientConfig = { langs: { en: "English" }, servers: [], motd: null, patrons: null, remoteData: "" };
  }
  const languageChanged = ui.setAvailableLanguages(clientConfig.langs);
  await ui.loadTranslations(ui.currentLanguage());
  if (languageChanged) {
    ui.applyLanguage();
  }

  if (clientConfig.remoteData !== remoteDataUrl) {
    remoteDataUrl = clientConfig.remoteData;
    remoteDataLoaded = false;
  }

  if (!clientConfig.remoteData) {
    applyPageData(clientConfig);
    return;
  }

  loadRemoteData(clientConfig.remoteData).then(remote => {
    if (seq !== remoteDataSeq) return;
    if (remote) {
      remoteDataLoaded = true;
      applyPageData(remote);
    } else if (!remoteDataLoaded) {
      applyPageData(clientConfig);
    }
  });
}

function loadServers() {
  const normalized = clientConfig.servers.map(normalizeServerEntry).filter(Boolean);
  baseServers = normalized.length > 0 ? normalized : fallbackServers;
  loadServerMetaCache();
  loadBookmarkedServers();
  rebuildServers();
}

function renderServers() {
  const { customApiEl, customPasswordEl, serverSelectEl } = ui.els;
  customApiEl.value = readStorage(storageKeys.customApi);
  customPasswordEl.value = readStorage(storageKeys.customPassword);
  serverSelectEl.textContent = "";

  servers.forEach((server, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = serverDisplayName(server);
    serverSelectEl.appendChild(option);
  });

  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = ui.tr("serverSelectCustomOption");
  serverSelectEl.appendChild(customOption);

  let saved = readStorage(storageKeys.server, "0") || "0";
  if (saved !== "custom" && (!/^\d+$/.test(saved) || Number(saved) >= servers.length)) saved = "0";
  serverSelectEl.value = saved;
  ui.updateCustomVisibility();
}

function selectedServer() {
  const { customApiEl, customPasswordEl, serverSelectEl } = ui.els;
  if (serverSelectEl.value === "custom") {
    return {
      name: ui.tr("serverSelectCustomOption"),
      description: ui.tr("customServerDescription"),
      apiBase: customApiEl.value,
      password: customPasswordEl.value
    };
  }
  return servers[Number(serverSelectEl.value)] || servers[0] || fallbackServers[0];
}

function customServerEntry() {
  const { customApiEl, customPasswordEl } = ui.els;
  return normalizeServerEntry({
    apiBase: customApiEl.value,
    password: customPasswordEl.value
  });
}

function saveSelectedServerValue() {
  writeStorage(storageKeys.server, ui.els.serverSelectEl.value);
}

function applyServerInfo(info, targetKey = currentServerKey()) {
  if (!info || typeof info !== "object" || targetKey !== currentServerKey()) return;

  const selected = selectedServer();
  const previous = serverMetaCache[targetKey] || {};
  const rawRtspBase = typeof info.rtsp_base === "string"
    ? info.rtsp_base
    : typeof info.rtspBase === "string"
      ? info.rtspBase
      : "";
  const meta = {
    name: typeof info.name === "string" ? info.name.trim() || previous.name || "" : previous.name || "",
    description: typeof info.description === "string" ? info.description.trim() : previous.description || "",
    rtspBase: safeRtspBaseForServer(selected, rawRtspBase) || safeRtspBaseForServer(selected, previous.rtspBase || ""),
    video: Boolean(info.video)
  };

  serverInfo = { key: targetKey, ...meta };
  serverMetaCache[targetKey] = meta;
  saveServerMetaCache();

  if (ui.els.serverSelectEl.value !== "custom") {
    const index = Number(ui.els.serverSelectEl.value);
    const server = servers[index];
    if (server) {
      if (meta.name) server.name = meta.name;
      server.description = meta.description;
      if (meta.rtspBase) server.rtspBase = meta.rtspBase;
      ui.updateServerOption(index, server);
    }
  } else {
    ui.updateCustomOption();
  }

  ui.updateCustomVisibility();
  ui.updateSourceControls();
  updateUrl();
}

async function connectSelectedServer() {
  saveSelectedServerValue();
  ui.setServerStatus("loading");
  ui.updateCustomVisibility();
  updateUrl();
  return await refreshStats();
}

async function connectCustomServer() {
  const entry = customServerEntry();
  if (!entry) return false;
  writeStorage(storageKeys.customApi, ui.els.customApiEl.value.trim());
  writeStorage(storageKeys.customPassword, ui.els.customPasswordEl.value);
  ui.els.serverSelectEl.value = "custom";
  if (!(await connectSelectedServer())) return false;
  saveCustomServer(entry);
  return true;
}

function saveCustomServer(entry) {
  entry.rtspBase = serverRtspBase(entry);
  const existing = servers.findIndex(server => sameServer(server, entry));

  if (existing >= 0) {
    servers[existing].password = entry.password;
    const bookmarked = bookmarkedServers.find(server => sameServer(server, entry));
    if (bookmarked) {
      bookmarked.password = entry.password;
      saveBookmarkedServers();
    }
    ui.els.serverSelectEl.value = String(existing);
  } else {
    bookmarkedServers.push(entry);
    saveBookmarkedServers();
    rebuildServers();
    renderServers();
    ui.els.serverSelectEl.value = String(servers.length - 1);
  }

  saveSelectedServerValue();
  ui.updateCustomVisibility();
  ui.updateServerHint();
  updateUrl();
}

function apiUrlFor(server, path) {
  const base = normalizeBase(server.apiBase, location.protocol === "https:" ? "https://" : "http://");
  if (!base) throw new Error("API server is not configured.");
  return new URL(String(path).replace(/^\/+/, ""), base + "/");
}

function wsUrlForCode(code, server = selectedServer()) {
  const url = apiUrlFor(server, `ingest?code=${encodeURIComponent(code)}`);
  if (server.password) url.searchParams.set("password", server.password);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error("API server must use http:// or https://.");
  return url.toString();
}

function mediaUrl(hash) {
  const base = normalizeBase(serverRtspBase(selectedServer()), "rtsp://");
  return base ? `${base}/${hash}` : "";
}

async function updateUrl() {
  const seq = ++urlSeq;
  if (!streamCode) {
    ui.setRtspUrl("");
    return;
  }
  const hash = await streamHashHex(streamCode);
  if (seq === urlSeq) ui.setRtspUrl(mediaUrl(hash));
}

function loadEncoderMode() {
  let saved = readStorage(storageKeys.encoderMode, "native192") || "native192";
  if (saved === "wasm190") saved = "wasm192";
  if (!encoderModes[saved]) saved = "native192";
  ui.els.encoderModeEl.value = saved;
}

function selectedEncoderMode() {
  return encoderModes[ui.els.encoderModeEl.value] || encoderModes.native192;
}

async function nativeEncoderSupported() {
  if (!window.Worker) return false;
  const mode = encoderModes.native192;
  return await new Promise(resolve => {
    const worker = new Worker(new URL("aac-worker.js", import.meta.url), { type: "module" });
    let done = false;
    const finish = supported => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { worker.postMessage({ type: "close" }); } catch (_) {}
      worker.terminate();
      resolve(supported);
    };
    const timer = setTimeout(() => finish(false), 4500);
    worker.onmessage = event => {
      const message = event.data;
      if (message.type === "ready") finish(message.name === "Native WebCodecs AAC");
      else if (message.type === "error") finish(false);
    };
    worker.onerror = () => finish(false);
    worker.postMessage({
      type: "init",
      sampleRate: config.sampleRate,
      channels: config.channels,
      bitrate: mode.bitrate,
      expectedAacConfigHex: config.expectedAacConfigHex,
      nativeAacBitrates: mode.nativeAacBitrates,
      preferNative: true,
      allowWasmFallback: false
    });
  });
}

async function selectWasmWhenNativeUnsupported() {
  nativeAacAvailable = await nativeEncoderSupported();
  ui.setNativeAacAvailable(nativeAacAvailable);
}

async function refreshStats() {
  const server = selectedServer();
  const key = serverKey(server);
  try {
    const response = await fetch(apiUrlFor(server, "stats"), { cache: "no-store" });
    if (!response.ok) throw new Error(`stats ${response.status}`);
    const stats = await response.json();
    if (key !== currentServerKey()) return false;
    applyServerInfo(stats, key);
    ui.setServerStatus("online", Number(stats.active_streams) || 0, Number(stats.active_listeners) || 0);
    return true;
  } catch (_) {
    if (key === currentServerKey()) ui.setServerStatus("offline");
    return false;
  }
}

function listenerCountFromMessage(message) {
  const value = Number(message.listeners);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function handleStreamerMessage(event, key, setStreamListeners) {
  if (typeof event.data !== "string") return;
  let message = null;
  try {
    message = JSON.parse(event.data);
  } catch (_) {
    return;
  }

  if (message.type === "hello") {
    applyServerInfo(message, key);
    const listeners = listenerCountFromMessage(message);
    if (listeners !== null) setStreamListeners(listeners);
  } else if (message.type === "listeners") {
    const listeners = listenerCountFromMessage(message);
    if (listeners !== null) setStreamListeners(listeners);
  }
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), 10000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket closed before streaming started"));
    };
  });
}

async function copyUrl() {
  const url = ui.els.rtspUrlEl.value;
  if (!url) return;
  try {
    if (!navigator.clipboard) throw new Error("Clipboard API is unavailable.");
    await navigator.clipboard.writeText(url);
  } catch (_) {
    ui.els.rtspUrlEl.focus();
    ui.els.rtspUrlEl.select();
    document.execCommand("copy");
    ui.els.rtspUrlEl.setSelectionRange(url.length, url.length);
  }
  ui.setRtspHint(ui.tr("streamUrlCopiedHint"));
  ui.showRtspHint();
  ui.resetCopiedHint();
}

async function newLink() {
  if (sourceRequestInFlight || linkRestartInFlight) return;
  linkRestartInFlight = true;
  ui.els.newLinkBtn.disabled = true;
  ui.updateSourceControls();
  try {
    rotateCode();
    await updateUrl();
    await streamer.restartActiveWithCurrentSources();
  } finally {
    linkRestartInFlight = false;
    ui.els.newLinkBtn.disabled = false;
    ui.updateSourceControls();
  }
}

function bindEvents() {
  const els = ui.els;
  els.rtspUrlEl.onclick = copyUrl;
  els.rtspUrlEl.addEventListener("mouseenter", ui.showRtspHint);
  els.rtspUrlEl.addEventListener("mouseleave", ui.hideRtspHint);
  els.rtspUrlEl.addEventListener("focusin", ui.showRtspHint);
  els.rtspUrlEl.addEventListener("focusout", ui.hideRtspHint);
  els.newLinkBtn.onclick = newLink;
  els.micBtn.onclick = () => streamer.start("mic");
  els.screenBtn.onclick = () => streamer.start("screen");
  els.videoSourceBtn.onclick = () => streamer.start("video");
  els.stopBtn.onclick = streamer.stop;

  for (const [button, kind] of [[els.screenBtn, "screen"], [els.videoSourceBtn, "video"]]) {
    button.addEventListener("mouseenter", () => ui.showSystemSourceHint(kind));
    button.addEventListener("mouseleave", ui.hideSystemSourceHint);
    button.addEventListener("focusin", () => ui.showSystemSourceHint(kind));
    button.addEventListener("focusout", ui.hideSystemSourceHint);
  }

  els.streamInfoWrapEl.addEventListener("mouseenter", ui.showStreamInfoHint);
  els.streamInfoWrapEl.addEventListener("mouseleave", ui.hideStreamInfoHint);
  els.streamInfoWrapEl.addEventListener("focusin", ui.showStreamInfoHint);
  els.streamInfoWrapEl.addEventListener("focusout", ui.hideStreamInfoHint);

  els.micDeviceEl.onchange = () => {
    ui.saveMicDeviceSelection();
    if (active) streamer.addOrReplaceSource("mic");
  };

  els.serverSelectEl.onchange = () => {
    if (active) streamer.stop();
    if (els.serverSelectEl.value === "custom") {
      saveSelectedServerValue();
      ui.setServerStatus("loading");
      ui.updateCustomVisibility();
      updateUrl();
      return;
    }
    connectSelectedServer();
  };

  els.customConnectBtn.onclick = connectCustomServer;
  els.customApiEl.addEventListener("input", () => {
    writeStorage(storageKeys.customApi, els.customApiEl.value);
    ui.updateCustomOption();
    ui.updateServerHint();
  });
  els.customPasswordEl.addEventListener("input", () => {
    writeStorage(storageKeys.customPassword, els.customPasswordEl.value);
  });

  els.encoderModeEl.onchange = () => {
    writeStorage(storageKeys.encoderMode, els.encoderModeEl.value);
    if (!active || sourceRequestInFlight || linkRestartInFlight) return;
    linkRestartInFlight = true;
    ui.updateSourceControls();
    streamer.restartActiveWithCurrentSources().finally(() => {
      linkRestartInFlight = false;
      ui.updateSourceControls();
    });
  };

  els.languageSelectEl.onchange = async () => {
    await ui.loadTranslations(els.languageSelectEl.value);
    ui.setLanguage(els.languageSelectEl.value);
    ui.applyLanguage();
    ui.refreshMicDevices().catch(() => {});
  };

  document.addEventListener("visibilitychange", streamer.refreshScreenWakeLock);
  window.addEventListener("resize", () => {
    ui.fitRtspUrlText();
    ui.positionRtspHint();
    ui.positionStreamInfoHint();
  });
  window.addEventListener("scroll", () => {
    ui.positionRtspHint();
    ui.positionStreamInfoHint();
  }, { passive: true });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      ui.refreshMicDevices().catch(() => {});
    });
  }
}

async function init() {
  resetStorageIfVersionChanged();
  streamCode = loadCode();
  await loadClientConfig();
  await ui.loadLanguage();
  ui.applyLanguage();
  loadServers();
  renderServers();
  loadEncoderMode();
  await selectWasmWhenNativeUnsupported();
  try { await ui.refreshMicDevices(ui.savedMicDeviceId()); } catch (_) {}
  ui.setStreamingControls(false);
  updateUrl();
  refreshStats();
  setInterval(loadClientConfig, config.configRefreshMs);
  setInterval(refreshStats, config.statsRefreshMs);
  bindEvents();
}

init();
