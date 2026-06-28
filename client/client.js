const $ = id => document.getElementById(id);
const mainEl = document.querySelector("main");
const serverSelectEl = $("serverSelect");
const serverHintEl = $("serverHint");
const customServerEl = $("customServer");
const customApiLabelEl = $("customApiLabel");
const customApiEl = $("customApi");
const customRtspLabelEl = $("customRtspLabel");
const customRtspEl = $("customRtsp");
const customPasswordLabelEl = $("customPasswordLabel");
const customPasswordEl = $("customPassword");
const customConnectBtn = $("customConnect");
const customBookmarkBtn = $("customBookmark");
const rtspUrlEl = $("rtspUrl");
const rtspHintEl = $("rtspHint");
const encoderModeEl = $("encoderMode");
const micDeviceEl = $("micDevice");
const micDeviceLabelEl = $("micDeviceLabel");
const sourcesEl = $("sources");
const addSourcesEl = $("addSources");
const firstSourceSelectionEl = $("firstSourceSelection");
const startTitleEl = $("startTitle");
const startTipEl = $("startTip");
const screenLabelEl = $("screenLabel");
const streamPanelEl = $("streamPanel");
const streamToTitleEl = $("streamToTitle");
const streamInfoWrapEl = $("streamInfoWrap");
const streamInfoEl = $("streamInfo");
const streamInfoHintEl = $("streamInfoHint");
const statusEl = $("status");
const statsEl = $("stats");
const pasteHintEl = $("pasteHint");
const newLinkBtn = $("newLink");
const micBtn = $("mic");
const screenBtn = $("screen");
const stopBtn = $("stop");
const sourceCodeLinkEl = $("sourceCodeLink");
const contactAdminLinkEl = $("contactAdminLink");
const languageSelectEl = $("languageSelect");
const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~";
const codeStorageKey = "vrc-audio-streamer-code";
const serverStorageKey = "vrc-audio-streamer-server";
const customApiStorageKey = "vrc-audio-streamer-custom-api";
const customRtspStorageKey = "vrc-audio-streamer-custom-rtsp";
const customPasswordStorageKey = "vrc-audio-streamer-custom-password";
const bookmarkedServersStorageKey = "vrc-audio-streamer-bookmarked-servers";
const serverMetaStorageKey = "vrc-audio-streamer-server-meta";
const encoderModeStorageKey = "vrc-audio-streamer-encoder-mode";
const micDeviceStorageKey = "vrc-audio-streamer-mic-device";
const languageStorageKey = "vrc-audio-streamer-language";
const sourceSettingsStorageKey = "vrc-audio-streamer-source-settings";
const sampleRate = 48000;
const channels = 2;
const framesPerChunk = 1024;
const bitrate = 320000;
const expectedEncodedFps = sampleRate / framesPerChunk;
const expectedEncodedFpsLabel = expectedEncodedFps.toFixed(1);
const redEncodedFps = 42;
const native192Bitrates = [192000];
const expectedAacConfigHex = "1190";
const statsRefreshMs = 15000;
const monitorOutputGain = 0.0001;
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

let urlSeq = 0;
let active = null;
let streamCode = "";
let baseServers = fallbackServers;
let bookmarkedServers = [];
let servers = fallbackServers;
let serverMetaCache = Object.create(null);
let serverInfo = null;
let micDeviceSelectionReady = false;
let sourceRequestInFlight = false;
let linkRestartInFlight = false;
let rtspHintResetTimer = 0;

const encoderModes = {
  native192: {
    bitrate: 192000,
    nativeAacBitrates: native192Bitrates,
    preferNative: true,
    allowWasmFallback: false
  },
  wasm320: {
    bitrate,
    nativeAacBitrates: [],
    preferNative: false,
    allowWasmFallback: true
  }
};

const translations = {
  en: {
    api: "API",
    bookmark: "Bookmark",
    clickToCopy: "Click to Copy",
    connect: "Connect",
    contactAdmin: "Contact Admin",
    copied: "Copied!",
    customOption: "Custom Server",
    customServerHint: "Use your own API and RTSP server addresses.",
    generateNewLink: "Generate Another Link",
    micInput: "Mic/Input Device",
    mono: "Mono",
    mute: "Mute",
    nativeEncoder: "🔊 Native AAC 192 kbps",
    or: "or",
    password: "Password",
    pasteVideoHint: "Paste this link into video player",
    rtsp: "RTSP",
    sourceCode: "Source Code",
    stopStreaming: "Stop Streaming",
    startTip: "Tip: You can mute browser tabs by right-clicking them, so you do not get annoyed by echo while streaming into VRChat.",
    streamAudioFrom: "Stream Audio From",
    streamingTo: "Streaming To",
    tabSystem: "Tab/System",
    addMicInput: "Add Mic/Input Device Audio",
    addTabSystem: "Add Tab/System Audio",
    wasmEncoder: "🔊 WASM AAC 320 kbps"
  },
  ja: {
    api: "API",
    bookmark: "ブックマーク",
    clickToCopy: "クリックでコピー",
    connect: "接続",
    contactAdmin: "管理者に連絡",
    copied: "コピーしました",
    customOption: "カスタムサーバー",
    customServerHint: "独自の API と RTSP サーバーアドレスを使います。",
    generateNewLink: "別のリンクを生成",
    micInput: "マイク/入力デバイス",
    mono: "モノラル",
    mute: "ミュート",
    nativeEncoder: "🔊 Native AAC 192 kbps",
    or: "または",
    password: "パスワード",
    pasteVideoHint: "このリンクをビデオプレイヤーに貼り付け",
    rtsp: "RTSP",
    sourceCode: "ソースコード",
    stopStreaming: "配信を停止",
    startTip: "ヒント: ブラウザのタブは右クリックでミュートできます。VRChat に配信中の音の二重再生を防げます。",
    streamAudioFrom: "音声の配信元",
    streamingTo: "配信先",
    tabSystem: "タブ/システム",
    addMicInput: "マイク/入力デバイス音声を追加",
    addTabSystem: "タブ/システム音声を追加",
    wasmEncoder: "🔊 WASM AAC 320 kbps"
  },
  ru: {
    api: "API",
    bookmark: "Сохранить",
    clickToCopy: "Нажми, чтобы скопировать",
    connect: "Подключить",
    contactAdmin: "Связаться с администратором",
    copied: "Скопировано!",
    customOption: "Свой сервер",
    customServerHint: "Использовать свои адреса API и RTSP сервера.",
    generateNewLink: "Сгенерировать другую ссылку",
    micInput: "Микрофона/Устройства ввода",
    mono: "Моно",
    mute: "Заглушить",
    nativeEncoder: "🔊 Native AAC 192 kbps",
    or: "или",
    password: "Пароль",
    pasteVideoHint: "Вставь эту ссылку в видеоплеер",
    rtsp: "RTSP",
    sourceCode: "Исходный код",
    stopStreaming: "Остановить стрим",
    startTip: "Совет: Ты можешь выключить звук из вкладки, нажав по ней правой кнопкой мыши. Так у тебя не будет двоиться звук при стриме в VRChat.",
    streamAudioFrom: "Транслировать звук из",
    streamingTo: "Транслируется на",
    tabSystem: "Вкладки/системы",
    addMicInput: "Добавить звук из микрофона/устройства ввода",
    addTabSystem: "Добавить звук из вкладки/системы",
    wasmEncoder: "🔊 WASM AAC 320 kbps"
  }
};

let currentLanguage = "en";

function tr(key) {
  return (translations[currentLanguage] && translations[currentLanguage][key])
    || translations.en[key]
    || key;
}

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

function setElementText(el, key) {
  if (el) el.textContent = tr(key);
}

function micDeviceLabel() {
  return tr("micInput");
}

function preferredBrowserLanguage() {
  const languages = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || ""];
  for (const language of languages) {
    const code = String(language).toLowerCase();
    if (code.startsWith("ru")) return "ru";
    if (code.startsWith("ja")) return "ja";
    if (code.startsWith("en")) return "en";
  }
  return "en";
}

function loadLanguage() {
  const saved = readStorage(languageStorageKey);
  currentLanguage = translations[saved] ? saved : preferredBrowserLanguage();
  languageSelectEl.value = currentLanguage;
}

function updateEncoderLabels() {
  const nativeOption = encoderModeEl.querySelector('option[value="native192"]');
  const wasmOption = encoderModeEl.querySelector('option[value="wasm320"]');
  if (nativeOption) nativeOption.textContent = tr("nativeEncoder");
  if (wasmOption) wasmOption.textContent = tr("wasmEncoder");
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage === "ja" ? "ja" : currentLanguage === "ru" ? "ru" : "en";
  setElementText(startTitleEl, "streamAudioFrom");
  setElementText(startTipEl, "startTip");
  setElementText(screenLabelEl, "tabSystem");
  setElementText(streamToTitleEl, "streamingTo");
  setElementText(customApiLabelEl, "api");
  setElementText(customRtspLabelEl, "rtsp");
  setElementText(customPasswordLabelEl, "password");
  setElementText(sourceCodeLinkEl, "sourceCode");
  setElementText(contactAdminLinkEl, "contactAdmin");
  micDeviceLabelEl.textContent = micDeviceLabel();
  customConnectBtn.textContent = tr("connect");
  customBookmarkBtn.textContent = tr("bookmark");
  pasteHintEl.textContent = tr("pasteVideoHint");
  newLinkBtn.textContent = tr("generateNewLink");
  stopBtn.textContent = `⏹ ${tr("stopStreaming")}`;
  updateEncoderLabels();
  if (rtspHintEl.textContent && rtspHintEl.textContent !== tr("copied")) setRtspHint(tr("clickToCopy"));
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
  updateCustomOption();
  updateServerHint();
  renderAddSourceButtons();
}

function setStatus(text) {
  statusEl.textContent = text;
}

function positionSideHint(anchorEl, hintEl) {
  if (hintEl.hidden || !hintEl.classList.contains("is-visible")) return;
  const gap = 7;
  const mainRect = mainEl.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();
  const preferredWidth = 288;
  let left = mainRect.right + gap;
  let available = window.innerWidth - left - gap;
  if (available < 160) {
    left = Math.max(gap, window.innerWidth - preferredWidth - gap);
    available = window.innerWidth - left - gap;
  }
  hintEl.style.left = `${left}px`;
  hintEl.style.maxWidth = `${Math.max(160, Math.min(preferredWidth, available))}px`;

  const height = hintEl.offsetHeight;
  const maxTop = window.innerHeight - height - gap;
  const top = maxTop >= gap ? Math.min(anchorRect.top, maxTop) : gap;
  hintEl.style.top = `${Math.max(gap, top)}px`;
}

function setStreamInfo(text) {
  streamInfoEl.textContent = text;
}

function setStreamInfoHint(text) {
  streamInfoHintEl.textContent = text;
  streamInfoHintEl.hidden = !text;
  if (!text) hideStreamInfoHint();
  else if (streamInfoHintEl.classList.contains("is-visible")) positionStreamInfoHint();
}

function positionStreamInfoHint() {
  positionSideHint(streamInfoWrapEl, streamInfoHintEl);
}

function showStreamInfoHint() {
  if (streamInfoHintEl.hidden || !streamInfoHintEl.textContent) return;
  streamInfoHintEl.classList.add("is-visible");
  positionStreamInfoHint();
  requestAnimationFrame(positionStreamInfoHint);
}

function hideStreamInfoHint() {
  streamInfoHintEl.classList.remove("is-visible");
}

function setRtspHint(text) {
  rtspHintEl.textContent = text;
  rtspHintEl.hidden = !text;
  if (rtspHintEl.classList.contains("is-visible")) positionRtspHint();
}

function positionRtspHint() {
  positionSideHint(rtspUrlEl, rtspHintEl);
}

function showRtspHint() {
  if (!rtspHintEl.textContent) setRtspHint(tr("clickToCopy"));
  rtspHintEl.hidden = false;
  rtspHintEl.classList.add("is-visible");
  positionRtspHint();
  requestAnimationFrame(positionRtspHint);
}

function hideRtspHint() {
  rtspHintEl.classList.remove("is-visible");
}

function setStats(text) {
  statsEl.textContent = text;
}

function randomCode(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += charset[byte % charset.length];
  return out;
}

function validStoredCode(code) {
  return typeof code === "string" && code.length >= 8 && code.length <= 128 && /^[\x21-\x7e]+$/.test(code);
}

function loadCode() {
  const saved = readStorage(codeStorageKey);
  if (validStoredCode(saved)) return saved;
  return rotateCode();
}

function saveCode(code) {
  streamCode = code;
  writeStorage(codeStorageKey, code);
}

function rotateCode() {
  const code = randomCode();
  saveCode(code);
  return code;
}

async function streamHashHex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < 16; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function normalizeServerEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const apiBase = entry.apiBase || entry.api || entry.http || "";
  const rtspBase = entry.rtspBase || entry.rtsp || entry.media || "";
  if (typeof apiBase !== "string" || typeof rtspBase !== "string") return null;
  if (!apiBase.trim() || !rtspBase.trim()) return null;
  return {
    name: String(entry.name || entry.label || "").trim(),
    description: String(entry.description || "").trim(),
    apiBase: apiBase.trim(),
    rtspBase: rtspBase.trim()
  };
}

function hostLabel(value) {
  try {
    return new URL(normalizeBase(value, "https://")).host;
  } catch (_) {
    return String(value || "").trim() || "Server";
  }
}

function sameServer(left, right) {
  return normalizeBase(left.apiBase, "https://") === normalizeBase(right.apiBase, "https://")
    && normalizeBase(left.rtspBase, "rtsp://") === normalizeBase(right.rtspBase, "rtsp://");
}

function serverKey(server) {
  const apiDefault = location.protocol === "https:" ? "https://" : "http://";
  return `${normalizeBase(server.apiBase, apiDefault)}|${normalizeBase(server.rtspBase, "rtsp://")}`;
}

function normalizeServerMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  return {
    name: String(meta.name || "").trim(),
    description: String(meta.description || "").trim(),
    video: Boolean(meta.video)
  };
}

function loadServerMetaCache() {
  serverMetaCache = Object.create(null);
  const saved = readJsonStorage(serverMetaStorageKey, {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  for (const [key, value] of Object.entries(saved)) {
    const meta = normalizeServerMeta(value);
    if (meta && (meta.name || meta.description)) serverMetaCache[key] = meta;
  }
}

function saveServerMetaCache() {
  writeJsonStorage(serverMetaStorageKey, serverMetaCache);
}

function savedServerMeta(server) {
  return serverMetaCache[serverKey(server)] || null;
}

function serverDisplayName(server) {
  const meta = savedServerMeta(server);
  return (meta && meta.name) || server.name || hostLabel(server.apiBase);
}

function serverDescription(server) {
  const meta = savedServerMeta(server);
  return (meta && meta.description) || server.description || "";
}

function customOptionText() {
  const entry = customServerEntry();
  const meta = entry && savedServerMeta(entry);
  return meta && meta.name ? `${tr("customOption")}: ${meta.name}` : tr("customOption");
}

function updateCustomOption() {
  for (const option of serverSelectEl.options) {
    if (option.value !== "custom") continue;
    option.textContent = customOptionText();
    return;
  }
}

function updateServerHint() {
  const info = currentServerInfo();
  const server = selectedServer();
  const hint = (info && info.description) || serverDescription(server) || "";
  serverHintEl.textContent = hint;
  serverHintEl.hidden = !hint;
}

function updateServerOption(index, server) {
  const option = serverSelectEl.options[index];
  if (!option) return;
  option.textContent = serverDisplayName(server);
}

function loadBookmarkedServers() {
  const saved = readJsonStorage(bookmarkedServersStorageKey, []);
  bookmarkedServers = Array.isArray(saved)
    ? saved.map(normalizeServerEntry).filter(Boolean)
    : [];
}

function saveBookmarkedServers() {
  writeJsonStorage(bookmarkedServersStorageKey, bookmarkedServers);
}

function rebuildServers() {
  servers = baseServers.concat(bookmarkedServers);
}

async function loadServers() {
  try {
    const response = await fetch(new URL("servers.json", location.href), { cache: "no-store" });
    if (!response.ok) throw new Error(`servers.json ${response.status}`);
    const loaded = await response.json();
    if (!Array.isArray(loaded)) throw new Error("servers.json must be an array");
    const normalized = loaded.map(normalizeServerEntry).filter(Boolean);
    baseServers = normalized.length > 0 ? normalized : fallbackServers;
  } catch (_) {
    baseServers = fallbackServers;
  }
  loadServerMetaCache();
  loadBookmarkedServers();
  rebuildServers();
}

function renderServers() {
  customApiEl.value = readStorage(customApiStorageKey) || "http://127.0.0.1:8081";
  customRtspEl.value = readStorage(customRtspStorageKey) || "rtsp://127.0.0.1";
  customPasswordEl.value = readStorage(customPasswordStorageKey);

  serverSelectEl.textContent = "";
  servers.forEach((server, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = serverDisplayName(server);
    serverSelectEl.appendChild(option);
  });

  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = customOptionText();
  serverSelectEl.appendChild(customOption);

  let saved = readStorage(serverStorageKey, "0") || "0";
  if (saved !== "custom" && (!/^\d+$/.test(saved) || Number(saved) >= servers.length)) saved = "0";
  serverSelectEl.value = saved;
  updateCustomVisibility();
}

function loadEncoderMode() {
  let saved = readStorage(encoderModeStorageKey, "native192") || "native192";
  if (!encoderModes[saved]) saved = "native192";
  encoderModeEl.value = saved;
}

async function nativeEncoderSupported() {
  if (!window.Worker) return false;
  const mode = encoderModes.native192;
  return await new Promise(resolve => {
    const worker = new Worker(new URL("aac-worker.js", location.href), { type: "module" });
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
      sampleRate,
      channels,
      bitrate: mode.bitrate,
      expectedAacConfigHex,
      nativeAacBitrates: mode.nativeAacBitrates,
      preferNative: true,
      allowWasmFallback: false
    });
  });
}

async function selectWasmWhenNativeUnsupported() {
  if (encoderModeEl.value !== "native192") return;
  const supported = await nativeEncoderSupported();
  if (supported || encoderModeEl.value !== "native192") return;
  encoderModeEl.value = "wasm320";
  writeStorage(encoderModeStorageKey, encoderModeEl.value);
}

function selectedEncoderMode() {
  return encoderModes[encoderModeEl.value] || encoderModes.native192;
}

function updateCustomVisibility() {
  const custom = serverSelectEl.value === "custom";
  const locked = Boolean(active);
  customServerEl.hidden = !custom || locked;
  customApiEl.disabled = locked || !custom;
  customRtspEl.disabled = locked || !custom;
  customPasswordEl.disabled = locked || !custom;
  customConnectBtn.disabled = locked || !custom;
  customBookmarkBtn.disabled = locked || !custom;
  updateCustomOption();
  updateServerHint();
}

function selectedServer() {
  if (serverSelectEl.value === "custom") {
    return {
      name: tr("customOption"),
      description: tr("customServerHint"),
      apiBase: customApiEl.value,
      rtspBase: customRtspEl.value,
      password: customPasswordEl.value
    };
  }
  return servers[Number(serverSelectEl.value)] || servers[0] || fallbackServers[0];
}

function customServerEntry() {
  return normalizeServerEntry({
    apiBase: customApiEl.value,
    rtspBase: customRtspEl.value
  });
}

function saveSelectedServerValue() {
  writeStorage(serverStorageKey, serverSelectEl.value);
}

function connectSelectedServer() {
  saveSelectedServerValue();
  updateCustomVisibility();
  updateUrl();
  refreshStats();
}

function connectCustomServer() {
  if (!customServerEntry()) {
    setStatus("Custom server API and RTSP are required.");
    return;
  }
  serverSelectEl.value = "custom";
  connectSelectedServer();
}

function bookmarkCustomServer() {
  const entry = customServerEntry();
  if (!entry) {
    setStatus("Custom server API and RTSP are required.");
    return;
  }

  const existing = servers.findIndex(server => sameServer(server, entry));
  if (existing >= 0) {
    serverSelectEl.value = String(existing);
  } else {
    bookmarkedServers.push(entry);
    saveBookmarkedServers();
    rebuildServers();
    renderServers();
    serverSelectEl.value = String(servers.length - 1);
  }

  connectSelectedServer();
}

function currentServerKey() {
  return serverKey(selectedServer());
}

function currentServerInfo() {
  return serverInfo && serverInfo.key === currentServerKey() ? serverInfo : null;
}

function applyServerInfo(info) {
  if (!info || typeof info !== "object") return;

  const name = typeof info.name === "string" ? info.name.trim() : "";
  const description = typeof info.description === "string" ? info.description.trim() : "";
  const key = currentServerKey();
  const previous = serverMetaCache[key] || {};
  const meta = {
    name: name || previous.name || "",
    description: description || previous.description || "",
    video: Boolean(info.video)
  };
  serverInfo = { key, ...meta };
  if (meta.name || meta.description) {
    serverMetaCache[key] = meta;
    saveServerMetaCache();
  }

  if (serverSelectEl.value !== "custom") {
    const index = Number(serverSelectEl.value);
    const server = servers[index];
    if (server) {
      if (meta.name) server.name = meta.name;
      server.description = meta.description;
      updateServerOption(index, server);
    }
  } else {
    updateCustomOption();
  }

  updateCustomVisibility();
}

function normalizeBase(value, defaultProtocol) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = defaultProtocol + text;
  return text.replace(/\/+$/, "");
}

function apiUrl(path) {
  const base = normalizeBase(selectedServer().apiBase, location.protocol === "https:" ? "https://" : "http://");
  if (!base) throw new Error("API server is not configured.");
  return new URL(String(path).replace(/^\/+/, ""), base + "/");
}

function mediaUrl(hash) {
  const base = normalizeBase(selectedServer().rtspBase, "rtsp://");
  if (!base) return "";
  return `${base}/${hash}`;
}

function fitRtspUrlText() {
  const value = rtspUrlEl.value || "";
  if (!value) {
    rtspUrlEl.style.fontSize = "";
    rtspUrlEl.style.height = "";
    rtspUrlEl.style.lineHeight = "";
    return;
  }

  const style = getComputedStyle(rtspUrlEl);
  const horizontal = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth) + 2;
  const available = rtspUrlEl.clientWidth - horizontal;
  if (available <= 0) return;

  const canvas = fitRtspUrlText.canvas || (fitRtspUrlText.canvas = document.createElement("canvas"));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const baseSize = 16;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${baseSize}px ${style.fontFamily}`;
  const measured = ctx.measureText(value).width || 1;
  const size = Math.max(7, Math.min(16, Math.floor((available / measured) * baseSize * 100) / 100));
  const height = Math.max(22, Math.ceil(size * 2.05));
  rtspUrlEl.style.fontSize = `${size}px`;
  rtspUrlEl.style.height = `${height}px`;
  rtspUrlEl.style.lineHeight = `${Math.max(12, Math.ceil(size * 1.2))}px`;
}

function setRtspUrl(value) {
  rtspUrlEl.value = value;
  fitRtspUrlText();
  requestAnimationFrame(fitRtspUrlText);
}

async function updateUrl() {
  const seq = ++urlSeq;
  const code = streamCode;
  if (!code) {
    setRtspUrl("");
    return;
  }
  const hash = await streamHashHex(code);
  if (seq !== urlSeq) return;
  setRtspUrl(mediaUrl(hash));
}

function hasSource(state, kind) {
  return Boolean(state && state.sources && state.sources[kind]);
}

function sourceSummary(state = active) {
  const names = [];
  if (hasSource(state, "mic")) names.push(state.sources.mic.name);
  if (hasSource(state, "screen")) names.push(state.sources.screen.name);
  return names.join(" + ") || "none";
}

function sourceSettings(source) {
  return {
    gain: sourceGain(source),
    mute: Boolean(source.muteEl.checked),
    forceMono: Boolean(source.monoEl.checked)
  };
}

function defaultSourceSettings(kind) {
  return {
    gain: 1,
    forceMono: kind === "mic"
  };
}

function normalizeRuntimeSourceSettings(kind, value) {
  const defaults = defaultSourceSettings(kind);
  const rawGain = Number(value && value.gain);
  const gain = Number.isFinite(rawGain) ? Math.min(1.5, Math.max(0, rawGain)) : defaults.gain;
  return {
    gain,
    mute: Boolean(value && value.mute),
    forceMono: typeof (value && value.forceMono) === "boolean" ? value.forceMono : defaults.forceMono
  };
}

function normalizeStoredSourceSettings(kind, value) {
  const settings = normalizeRuntimeSourceSettings(kind, value);
  return {
    gain: Math.min(1, settings.gain),
    forceMono: settings.forceMono
  };
}

function readStoredSourceSettings() {
  const value = readJsonStorage(sourceSettingsStorageKey, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function loadSourceSettings(kind) {
  return normalizeStoredSourceSettings(kind, readStoredSourceSettings()[kind]);
}

function saveSourceSettings(source) {
  const stored = readStoredSourceSettings();
  stored[source.kind] = normalizeStoredSourceSettings(source.kind, {
    gain: sourceGain(source),
    forceMono: Boolean(source.monoEl.checked)
  });
  writeJsonStorage(sourceSettingsStorageKey, stored);
}

function activeSourceSpecs() {
  if (!active) return [];
  const specs = [];
  for (const kind of ["mic", "screen"]) {
    const source = active.sources[kind];
    if (!source) continue;
    specs.push({
      kind,
      deviceId: source.deviceId || "",
      mediaStream: source.mediaStream,
      settings: sourceSettings(source)
    });
  }
  return specs;
}

function addSourceLabel(kind) {
  return kind === "mic" ? tr("addMicInput") : tr("addTabSystem");
}

function createAddMicSourceSelect() {
  const select = document.createElement("select");
  const placeholder = document.createElement("option");
  placeholder.value = "__add_mic";
  placeholder.textContent = addSourceLabel("mic");
  select.className = "add-source-select";
  select.disabled = sourceRequestInFlight;
  select.appendChild(placeholder);

  if (micDeviceSelectionReady) {
    for (const option of micDeviceEl.options) {
      const copy = option.cloneNode(true);
      if (!copy.textContent.trim()) copy.textContent = micDeviceLabel();
      select.appendChild(copy);
    }
  }

  select.value = placeholder.value;
  select.onpointerdown = event => {
    if (micDeviceSelectionReady || sourceRequestInFlight) return;
    event.preventDefault();
    addOrReplaceSource("mic");
  };
  select.onchange = () => {
    const deviceId = select.value;
    select.value = placeholder.value;
    if (deviceId === placeholder.value || sourceRequestInFlight) return;
    saveMicDeviceSelection(deviceId);
    addOrReplaceSource("mic", deviceId);
  };
  return select;
}

function renderAddSourceButtons() {
  addSourcesEl.textContent = "";
  if (!active) return;

  const missing = [];
  if (!active.sources.screen) missing.push("screen");
  if (!active.sources.mic) missing.push("mic");

  missing.forEach((kind, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.textContent = tr("or");
      addSourcesEl.appendChild(separator);
    }
    if (kind === "mic") {
      addSourcesEl.appendChild(createAddMicSourceSelect());
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = addSourceLabel(kind);
      button.disabled = sourceRequestInFlight;
      button.onclick = () => addOrReplaceSource(kind);
      addSourcesEl.appendChild(button);
    }
  });
}

function updateSourceControls() {
  const streaming = Boolean(active);
  micBtn.disabled = sourceRequestInFlight;
  screenBtn.disabled = sourceRequestInFlight;
  micDeviceEl.disabled = sourceRequestInFlight || !micDeviceSelectionReady;
  stopBtn.disabled = !streaming;
  renderAddSourceButtons();
}

function setMicDeviceSelectionReady(ready) {
  micDeviceSelectionReady = ready;
  micDeviceEl.hidden = !ready;
  micDeviceLabelEl.hidden = ready;
}

function setSourceRequestBusy(busy) {
  sourceRequestInFlight = busy;
  updateSourceControls();
}

function browserThrottleWarning() {
  return document.hidden ? "\nBrowser tab is hidden/minimized; Chrome may throttle realtime encoding." : "";
}

async function requestScreenWakeLock() {
  if (!("wakeLock" in navigator)) return null;
  try {
    const wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      if (active && active.wakeLock === wakeLock) active.wakeLock = null;
    });
    return wakeLock;
  } catch (_) {
    return null;
  }
}

async function refreshScreenWakeLock() {
  if (!active || document.visibilityState !== "visible") return;
  if (active.wakeLock && !active.wakeLock.released) return;
  const wakeLock = await requestScreenWakeLock();
  if (active && wakeLock) active.wakeLock = wakeLock;
}

function setMediaSessionPlaying(playing) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = playing ? "playing" : "none";
  } catch (_) {}
}

function savedMicDeviceId() {
  return readStorage(micDeviceStorageKey);
}

function saveMicDeviceSelection(value = micDeviceEl.value) {
  micDeviceEl.value = value || "";
  writeStorage(micDeviceStorageKey, micDeviceEl.value);
}

async function refreshMicDevices(preferredId = micDeviceEl.value || savedMicDeviceId()) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    setMicDeviceSelectionReady(false);
    updateSourceControls();
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(device => device.kind === "audioinput");
  setMicDeviceSelectionReady(inputs.some(device => device.label));
  micDeviceEl.textContent = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = micDeviceLabel();
  micDeviceEl.appendChild(defaultOption);

  if (!micDeviceSelectionReady) {
    micDeviceEl.value = "";
    updateSourceControls();
    return;
  }

  inputs.forEach((device, index) => {
    if (!device.deviceId) return;
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `${micDeviceLabel()} ${index + 1}`;
    micDeviceEl.appendChild(option);
  });

  if (preferredId && ![...micDeviceEl.options].some(option => option.value === preferredId)) {
    const savedOption = document.createElement("option");
    savedOption.value = preferredId;
    savedOption.textContent = micDeviceLabel();
    micDeviceEl.appendChild(savedOption);
  }
  if ([...micDeviceEl.options].some(option => option.value === preferredId)) {
    micDeviceEl.value = preferredId;
  }
  updateSourceControls();
}

function wsUrlForCode(code) {
  const url = apiUrl(`ingest?code=${encodeURIComponent(code)}`);
  const password = selectedServer().password || "";
  if (password) url.searchParams.set("password", password);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error("API server must use http:// or https://.");
  return url.toString();
}

async function refreshStats() {
  try {
    const response = await fetch(apiUrl("stats"), { cache: "no-store" });
    if (!response.ok) throw new Error(`stats ${response.status}`);
    const stats = await response.json();
    applyServerInfo(stats);
    setStats(`🟢 Online 📡${stats.active_streams} 👥${stats.active_listeners}`);
  } catch (_) {
    setStats("🔴 Offline 📡- 👥-");
  }
}

function listenerCountFromMessage(message) {
  const value = Number(message.listeners);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function handlePublisherMessage(event, setStreamListeners) {
  if (typeof event.data !== "string") return;

  let message = null;
  try {
    message = JSON.parse(event.data);
  } catch (_) {
    return;
  }

  if (message.type === "hello") {
    applyServerInfo(message);
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

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function captureAudio(kind, deviceIdOverride = null) {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    sampleRate
  };
  if (kind === "screen") {
    return await navigator.mediaDevices.getDisplayMedia({ video: true, audio });
  }
  const deviceId = deviceIdOverride ?? micDeviceEl.value;
  if (deviceId) audio.deviceId = { exact: deviceId };
  return await navigator.mediaDevices.getUserMedia({ video: false, audio });
}

function captureProcessorSource() {
  return `
class SourceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gain = 1;
    this.mute = false;
    this.forceMono = false;
    this.levelPeak = 0;
    this.levelFrames = 0;
    this.levelInterval = ${Math.round(sampleRate / 15)};
    this.port.onmessage = event => {
      if (event.data && event.data.type === "settings") {
        const gain = Number(event.data.gain);
        this.gain = Number.isFinite(gain) ? Math.min(4, Math.max(0, gain)) : 1;
        this.mute = Boolean(event.data.mute);
        this.forceMono = Boolean(event.data.forceMono);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const leftOut = output && output[0] ? output[0] : null;
    const rightOut = output && output[1] ? output[1] : leftOut;
    if (!leftOut) return true;

    const leftIn = input && input[0] ? input[0] : null;
    if (!leftIn || this.mute) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);
      this.levelFrames += leftOut.length;
      if (this.levelFrames >= this.levelInterval) {
        this.port.postMessage({ type: "level", peak: 0 });
        this.levelFrames = 0;
        this.levelPeak = 0;
      }
      return true;
    }
    const rightIn = input[1] || leftIn;
    const gain = this.gain;
    let blockPeak = 0;

    for (let i = 0; i < leftOut.length; i++) {
      let left;
      let right;
      if (this.forceMono) {
        const mono = (leftIn[i] + rightIn[i]) * 0.5 * gain;
        left = mono;
        right = mono;
      } else {
        left = leftIn[i] * gain;
        right = rightIn[i] * gain;
      }
      if (left > 1) left = 1;
      else if (left < -1) left = -1;
      if (right > 1) right = 1;
      else if (right < -1) right = -1;
      leftOut[i] = left;
      if (rightOut !== leftOut) rightOut[i] = right;
      const absLeft = left < 0 ? -left : left;
      const absRight = right < 0 ? -right : right;
      const peak = absLeft > absRight ? absLeft : absRight;
      if (peak > blockPeak) blockPeak = peak;
    }
    if (blockPeak > this.levelPeak) this.levelPeak = blockPeak;
    this.levelFrames += leftOut.length;
    if (this.levelFrames >= this.levelInterval) {
      this.port.postMessage({ type: "level", peak: this.levelPeak });
      this.levelFrames = 0;
      this.levelPeak = 0;
    }
    return true;
  }
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = ${framesPerChunk};
    this.channels = ${channels};
    this.pcm = new Float32Array(this.frames * this.channels);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const monitorOut = output && output[0] ? output[0] : null;

    const input = inputs[0];
    const leftIn = input && input[0] ? input[0] : null;
    const rightIn = input && input[1] ? input[1] : leftIn;
    const frameCount = leftIn ? leftIn.length : (monitorOut ? monitorOut.length : 128);

    let sourceOffset = 0;
    while (sourceOffset < frameCount) {
      const take = Math.min(this.frames - this.offset, frameCount - sourceOffset);
      for (let i = 0; i < take; i++) {
        const dst = (this.offset + i) * this.channels;
        const src = sourceOffset + i;
        let left = leftIn ? leftIn[src] : 0;
        let right = rightIn ? rightIn[src] : left;
        if (left > 1) left = 1;
        else if (left < -1) left = -1;
        if (right > 1) right = 1;
        else if (right < -1) right = -1;
        this.pcm[dst] = left;
        this.pcm[dst + 1] = right;
        if (monitorOut) monitorOut[src] = (left + right) * 0.5;
      }
      this.offset += take;
      sourceOffset += take;

      if (this.offset === this.frames) {
        const pcm = this.pcm;
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.pcm = new Float32Array(this.frames * this.channels);
        this.offset = 0;
      }
    }

    return true;
  }
}
registerProcessor("source-processor", SourceProcessor);
registerProcessor("capture-processor", CaptureProcessor);
`;
}

async function createCaptureNode(audioContext, onBlock) {
  const blob = new Blob([captureProcessorSource()], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await audioContext.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const node = new AudioWorkletNode(audioContext, "capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });
  node.port.onmessage = event => onBlock(event.data);
  return node;
}

function createAacEncoder(onPacket, onError) {
  const worker = new Worker(new URL("aac-worker.js", location.href), { type: "module" });
  const encoderMode = selectedEncoderMode();
  let readySettled = false;
  let pcmBlocks = 0;
  let encodedFrames = 0;
  let encodedBytes = 0;
  let firstPacketAt = 0;
  let name = "Loading AAC";
  let detail = "";
  let fallbackReason = "";

  const ready = new Promise((resolve, reject) => {
    worker.onmessage = event => {
      const message = event.data;
      if (message.type === "ready") {
        name = message.name || name;
        detail = message.detail || "";
        fallbackReason = message.fallbackReason || "";
        readySettled = true;
        resolve({ name, detail, fallbackReason });
      } else if (message.type === "packet") {
        if (firstPacketAt === 0) firstPacketAt = performance.now();
        encodedFrames++;
        encodedBytes += message.bytes;
        onPacket(message.packet);
      } else if (message.type === "error") {
        const error = new Error(message.message || "AAC worker failed.");
        if (!readySettled) {
          readySettled = true;
          reject(error);
        }
        onError(error);
      }
    };
    worker.onerror = event => {
      const error = new Error(event.message || "AAC worker failed.");
      if (!readySettled) {
        readySettled = true;
        reject(error);
      }
      onError(error);
    };
    worker.postMessage({
      type: "init",
      sampleRate,
      channels,
      bitrate: encoderMode.bitrate,
      expectedAacConfigHex,
      nativeAacBitrates: encoderMode.nativeAacBitrates,
      preferNative: encoderMode.preferNative,
      allowWasmFallback: encoderMode.allowWasmFallback
    });
  });

  return {
    ready,
    encode(buffer) {
      pcmBlocks++;
      worker.postMessage({ type: "encode", pcm: buffer }, [buffer]);
    },
    close() {
      try { worker.postMessage({ type: "close" }); } catch (_) {}
      worker.terminate();
    },
    lagFrames() {
      return pcmBlocks - encodedFrames;
    },
    stats() {
      const elapsed = firstPacketAt === 0
        ? 0.001
        : Math.max((performance.now() - firstPacketAt) / 1000, 0.001);
      return {
        name,
        detail,
        fallbackReason,
        pcmBlocks,
        encodedFrames,
        encodedBytes,
        encodedFps: encodedFrames / elapsed,
        encodedKbps: (encodedBytes * 8 / 1000) / elapsed,
        queue: pcmBlocks - encodedFrames
      };
    }
  };
}

function encoderStatusLine(info) {
  let line = `Encoder: ${info.name}`;
  if (info.detail) line += ` (${info.detail})`;
  if (info.fallbackReason) line += `\nNative AAC fallback: ${info.fallbackReason}`;
  return line;
}

function setStreamingControls(streaming) {
  firstSourceSelectionEl.hidden = streaming;
  streamPanelEl.hidden = !streaming;
  if (!streaming) {
    setStreamInfo("");
    setStreamInfoHint("");
  } else {
    requestAnimationFrame(fitRtspUrlText);
  }
  stopBtn.disabled = !streaming;
  newLinkBtn.disabled = linkRestartInFlight;
  serverSelectEl.disabled = false;
  encoderModeEl.disabled = streaming;
  updateCustomVisibility();
  updateSourceControls();
}

function streamStatusText(info) {
  if (!active) return encoderStatusLine(info);

  let text = `${encoderStatusLine(info)}${browserThrottleWarning()}\nListeners: ${active.streamListeners}\nSources: ${sourceSummary(active)}`;
  if ("encodedFrames" in info) {
    text += `\nEncoded AAC frames: ${info.encodedFrames}\nEncoded fps: ${info.encodedFps.toFixed(1)}/${expectedEncodedFpsLabel}\nAAC kbps: ${info.encodedKbps.toFixed(0)}\nEncoder queue: ${info.queue}`;
  }
  return text;
}

function streamHintText(info) {
  if (!active) return encoderStatusLine(info);

  let text = `${encoderStatusLine(info)}${browserThrottleWarning()}`;
  if ("encodedFrames" in info) {
    text += `\nEncoded AAC frames: ${info.encodedFrames}\nEncoder queue: ${info.queue}`;
  }
  return text;
}

function encodedFpsClass(value) {
  if (!Number.isFinite(value)) return "";
  const shown = Number(value.toFixed(1));
  if (shown < redEncodedFps) return "fps-bad";
  return shown < Number(expectedEncodedFpsLabel) ? "fps-warn" : "";
}

function renderStreamInfo(kbps, fps, listeners) {
  const fpsText = Number.isFinite(fps) ? fps.toFixed(1) : "-";
  const fpsEl = document.createElement("span");
  fpsEl.textContent = `${fpsText}/${expectedEncodedFpsLabel} fps`;
  const className = encodedFpsClass(fps);
  if (className) fpsEl.className = className;
  streamInfoEl.replaceChildren(`👥${listeners} ${kbps} kbps `, fpsEl);
}

function updateStreamStatus(info) {
  if (!active) return;
  const current = info || active.encoder.stats();
  setStatus(streamStatusText(current));
  const kbps = Number.isFinite(current.encodedKbps)
    ? Math.round(current.encodedKbps)
    : Math.round(selectedEncoderMode().bitrate / 1000);
  renderStreamInfo(kbps, current.encodedFps, active.streamListeners);
  setStreamInfoHint(streamHintText(current));
}

function stopMediaStream(mediaStream) {
  if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
}

function fallbackSourceName(kind) {
  return kind === "mic" ? tr("micInput") : tr("tabSystem");
}

function sourceDisplayName(kind, mediaStream) {
  const label = mediaStream.getAudioTracks()[0]?.label?.trim() || "";
  return label
    ? label.replace(/^(Mic\/Input Device|Tab\/System Audio|Tab\/System|Микрофон\/устройство ввода|Вкладка\/система|マイク\/入力デバイス|タブ\/システム)\s*:?\s*/i, "") || fallbackSourceName(kind)
    : fallbackSourceName(kind);
}

function sourceGain(source) {
  const value = Number(source.gainEl.value);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1.5, Math.max(0, value));
}

function updateGainValue(source) {
  if (source.gainValueEl) source.gainValueEl.textContent = `${Math.round(sourceGain(source) * 100)}%`;
}

function updateSourceLevel(source, peak) {
  const value = Number(peak);
  const safePeak = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const db = safePeak > 0 ? 20 * Math.log10(safePeak) : -60;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const previous = source.levelPct || 0;
  const next = pct >= previous ? pct : previous * 0.78 + pct * 0.22;
  source.levelPct = next < 0.5 ? 0 : next;
  if (source.block) source.block.style.setProperty("--source-level", `${source.levelPct.toFixed(1)}%`);
}

function updateMuteState(source) {
  if (source.block) source.block.classList.toggle("is-muted", Boolean(source.muteEl.checked));
}

function applyAudioSourceSettings(source) {
  updateGainValue(source);
  updateMuteState(source);
  source.processor.port.postMessage({
    type: "settings",
    gain: sourceGain(source),
    mute: source.muteEl.checked,
    forceMono: source.monoEl.checked
  });
}

function sourceThemeHue(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

function applySourceTheme(block, source) {
  const hue = sourceThemeHue(`${source.kind}:${source.name}`);
  block.style.setProperty("--source-bg-a", `hsl(${hue} 28% 12%)`);
  block.style.setProperty("--source-bg-b", `hsl(${(hue + 42) % 360} 24% 9%)`);
  block.style.setProperty("--source-icon-bg", `hsl(${hue} 24% 14%)`);
  block.style.setProperty("--source-fg", `hsl(${hue} 58% 72%)`);
  block.style.setProperty("--source-soft", `hsl(${hue} 34% 48%)`);
  block.style.setProperty("--source-accent", `hsl(${hue} 62% 60%)`);
}

function createMicSourceSelect(source) {
  const select = document.createElement("select");
  let selectedOption = null;

  for (const option of micDeviceEl.options) {
    const copy = option.cloneNode(true);
    if (copy.value === (source.deviceId || "")) selectedOption = copy;
    select.appendChild(copy);
  }

  if (!selectedOption) {
    selectedOption = document.createElement("option");
    selectedOption.value = source.deviceId || "";
    select.appendChild(selectedOption);
  }

  selectedOption.textContent = source.name;
  select.value = source.deviceId || "";
  return select;
}

function createSourceBlock(source) {
  const block = document.createElement("div");
  const iconWrap = document.createElement("button");
  const body = document.createElement("div");
  const head = document.createElement("div");
  const settings = document.createElement("div");
  const icon = document.createElement("span");
  const iconHint = document.createElement("span");
  const sourceControl = source.kind === "mic" ? createMicSourceSelect(source) : document.createElement("button");
  const gainLabel = document.createElement("label");
  const gainMeter = document.createElement("span");
  const gain = document.createElement("input");
  const gainValue = document.createElement("span");
  const mute = document.createElement("input");
  const monoLabel = document.createElement("label");
  const monoText = document.createElement("span");
  const mono = document.createElement("input");
  const remove = document.createElement("button");

  block.className = "source-card";
  applySourceTheme(block, source);
  block.style.setProperty("--source-level", "0%");
  iconWrap.type = "button";
  iconWrap.className = "source-icon";
  iconWrap.setAttribute("aria-label", "Toggle mute");
  body.className = "source-body";
  head.className = "source-head";
  settings.className = "source-settings";
  icon.className = "source-icon-img";
  icon.setAttribute("aria-hidden", "true");
  iconHint.className = "source-icon-hint";
  iconHint.dataset.i18n = "mute";
  iconHint.textContent = tr("mute");
  const iconMask = `url("${source.kind === "mic" ? "static/mic.webp" : "static/tab.webp"}") center / contain no-repeat`;
  icon.style.setProperty("-webkit-mask", iconMask);
  icon.style.mask = iconMask;
  gainLabel.className = "source-gain";
  gainMeter.className = "source-gain-meter";
  gainValue.className = "source-gain-value";
  sourceControl.className = "source-control";

  if (source.kind !== "mic") {
    sourceControl.type = "button";
    sourceControl.textContent = source.name;
  }

  gain.type = "range";
  gain.min = "0";
  gain.max = "1.5";
  gain.step = "0.01";
  gain.value = "1";
  gainMeter.append(gain);
  gainLabel.append(gainMeter, gainValue);

  mute.type = "checkbox";

  mono.type = "checkbox";
  mono.checked = source.kind === "mic";
  monoText.dataset.i18n = "mono";
  monoText.textContent = tr("mono");
  monoLabel.className = "source-mono";
  monoLabel.append(monoText, mono);

  remove.type = "button";
  remove.className = "source-remove";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Delete source");

  iconWrap.append(icon, iconHint);
  head.append(sourceControl, remove);
  settings.append(gainLabel, monoLabel);
  body.append(head, settings);
  block.append(iconWrap, body);

  source.block = block;
  source.deviceEl = source.kind === "mic" ? sourceControl : null;
  source.gainEl = gain;
  source.gainMeterEl = gainMeter;
  source.gainValueEl = gainValue;
  source.muteEl = mute;
  source.monoEl = mono;
  source.removeBtn = remove;

  iconWrap.onclick = () => {
    source.muteEl.checked = !source.muteEl.checked;
    applyAudioSourceSettings(source);
    updateStreamStatus();
  };

  if (source.kind === "mic") {
    sourceControl.onchange = () => {
      const deviceId = source.deviceEl.value;
      saveMicDeviceSelection(deviceId);
      addOrReplaceSource(source.kind, deviceId, sourceSettings(source));
    };
  } else {
    sourceControl.onclick = () => addOrReplaceSource(source.kind, null, sourceSettings(source));
  }
  gain.addEventListener("input", () => {
    applyAudioSourceSettings(source);
    updateStreamStatus();
  });
  gain.addEventListener("change", () => {
    saveSourceSettings(source);
  });
  mute.addEventListener("change", () => {
    applyAudioSourceSettings(source);
    updateStreamStatus();
  });
  mono.addEventListener("change", () => {
    applyAudioSourceSettings(source);
    saveSourceSettings(source);
    updateStreamStatus();
  });
  remove.onclick = () => removeAudioSource(source.kind, source);

  return block;
}

function disposeAudioSource(source, stopStream = true) {
  if (!source) return;
  try { source.node.disconnect(); } catch (_) {}
  try { source.processor.disconnect(); } catch (_) {}
  try { source.processor.port.close(); } catch (_) {}
  if (source.block) source.block.remove();
  if (stopStream) stopMediaStream(source.mediaStream);
}

function removeAudioSource(kind, source) {
  if (!active || active.sources[kind] !== source) return;
  active.sources[kind] = null;
  disposeAudioSource(source);
  updateSourceControls();
  updateStreamStatus();
}

function installAudioSource(kind, mediaStream, deviceId = kind === "mic" ? micDeviceEl.value : "", settings = null) {
  if (!active) {
    stopMediaStream(mediaStream);
    return;
  }

  const node = active.audioContext.createMediaStreamSource(mediaStream);
  const processor = new AudioWorkletNode(active.audioContext, "source-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  const next = {
    kind,
    name: sourceDisplayName(kind, mediaStream),
    deviceId,
    mediaStream,
    node,
    processor
  };
  createSourceBlock(next);
  processor.port.onmessage = event => {
    const message = event.data;
    if (message && message.type === "level") updateSourceLevel(next, message.peak);
  };
  const initialSettings = settings
    ? normalizeRuntimeSourceSettings(kind, settings)
    : normalizeRuntimeSourceSettings(kind, loadSourceSettings(kind));
  next.gainEl.value = String(initialSettings.gain);
  next.muteEl.checked = Boolean(initialSettings.mute);
  next.monoEl.checked = Boolean(initialSettings.forceMono);
  applyAudioSourceSettings(next);
  saveSourceSettings(next);

  const previous = active.sources[kind];
  active.sources[kind] = next;

  node.connect(processor);
  processor.connect(active.mixer);
  if (previous && previous.block && previous.block.parentNode) {
    previous.block.replaceWith(next.block);
  } else {
    sourcesEl.appendChild(next.block);
  }
  if (previous) disposeAudioSource(previous);

  mediaStream.getAudioTracks().forEach(track => {
    track.addEventListener("ended", () => removeAudioSource(kind, next), { once: true });
  });

  updateSourceControls();
  updateStreamStatus();
}

async function requestAudioSource(kind, deviceId = null) {
  setStatus(kind === "screen"
    ? "Choose a screen/tab and enable audio sharing in the browser prompt..."
    : "Allow microphone access in the browser prompt...");
  const mediaStream = await withTimeout(
    captureAudio(kind, deviceId),
    45000,
    "Timed out waiting for browser audio permission/selection."
  );
  if (mediaStream.getAudioTracks().length === 0) {
    stopMediaStream(mediaStream);
    throw new Error("No audio track selected");
  }
  if (kind === "mic") {
    try { await refreshMicDevices(micDeviceEl.value); } catch (_) {}
  }
  return mediaStream;
}

async function addOrReplaceSource(kind, deviceId = null, settings = null, mediaStreamOverride = null) {
  if (!active || sourceRequestInFlight) return;

  let mediaStream = mediaStreamOverride;
  setSourceRequestBusy(true);
  try {
    if (!mediaStream) mediaStream = await requestAudioSource(kind, deviceId);
    if (!active) {
      stopMediaStream(mediaStream);
      return;
    }
    installAudioSource(kind, mediaStream, deviceId ?? undefined, settings);
    mediaStream = null;
    updateStreamStatus();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    stopMediaStream(mediaStream);
    setSourceRequestBusy(false);
  }
}

async function start(kind, deviceId = null, settings = null, mediaStreamOverride = null) {
  if (active) {
    await addOrReplaceSource(kind, deviceId, settings, mediaStreamOverride);
    return;
  }
  if (sourceRequestInFlight) return;

  const code = streamCode;
  if (code.length < 8) {
    setStatus("Stream code is not ready.");
    return;
  }

  let mediaStream = mediaStreamOverride;
  let audioContext = null;
  let ws = null;
  let encoder = null;
  let pendingStreamListeners = 0;
  setSourceRequestBusy(true);
  try {
    if (!mediaStream) mediaStream = await requestAudioSource(kind, deviceId);

    setStatus("Preparing browser AAC encoder...");
    encoder = createAacEncoder(
      packet => {
        if (!active || active.encoder !== encoder || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 256 * 1024) {
          failActive("Network queue is too slow; stopped.");
          return;
        }
        ws.send(packet);
      },
      error => {
        if (active && active.encoder === encoder) failActive(error.message || String(error));
      }
    );
    let encoderReadyError = null;
    const encoderReady = encoder.ready.catch(error => {
      encoderReadyError = error;
      return null;
    });
    const encoderInfo = await encoderReady;
    if (encoderReadyError) throw encoderReadyError;

    setStatus("Connecting to relay server...");
    ws = new WebSocket(wsUrlForCode(code));
    ws.binaryType = "arraybuffer";
    ws.onmessage = event => handlePublisherMessage(event, listeners => {
      pendingStreamListeners = listeners;
      if (active && active.ws === ws) {
        active.streamListeners = listeners;
        updateStreamStatus();
      }
    });
    await waitForOpen(ws);

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: "interactive", sampleRate });
    if (audioContext.sampleRate !== sampleRate) {
      throw new Error(`AudioContext returned ${audioContext.sampleRate} Hz, expected ${sampleRate} Hz.`);
    }

    const captureNode = await createCaptureNode(audioContext, buffer => {
      if (!active || active.encoder !== encoder) return;
      if (encoder.lagFrames() > 128) {
        failActive("AAC encoder queue is too slow; stopped.");
        return;
      }
      encoder.encode(buffer);
    });
    const mixer = audioContext.createGain();
    mixer.channelCount = channels;
    mixer.channelCountMode = "explicit";
    mixer.channelInterpretation = "speakers";
    const monitor = audioContext.createGain();
    monitor.gain.value = monitorOutputGain;
    const wakeLock = await requestScreenWakeLock();
    setMediaSessionPlaying(true);

    active = {
      audioContext,
      ws,
      encoder,
      mixer,
      captureNode,
      monitor,
      wakeLock,
      statusTimer: null,
      sources: { mic: null, screen: null },
      streamListeners: pendingStreamListeners
    };

    installAudioSource(kind, mediaStream, deviceId ?? undefined, settings);
    mediaStream = null;
    mixer.connect(captureNode);
    captureNode.connect(monitor);
    monitor.connect(audioContext.destination);
    await audioContext.resume();

    setStreamingControls(true);

    ws.onclose = () => {
      if (active && active.ws === ws) {
        cleanup();
        setStatus("Stopped.");
      }
    };
    ws.onerror = () => {
      if (active && active.ws === ws) failActive("WebSocket error.");
    };

    updateStreamStatus(encoderInfo);
    active.statusTimer = setInterval(() => {
      if (!active || active.ws !== ws) return;
      updateStreamStatus(encoder.stats());
    }, 1000);
  } catch (error) {
    if (encoder) encoder.close();
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1011, "start failed");
    if (audioContext) {
      try { audioContext.close(); } catch (_) {}
    }
    stopMediaStream(mediaStream);
    cleanup();
    setStatus(error.message || String(error));
  } finally {
    setSourceRequestBusy(false);
  }
}

function failActive(message) {
  cleanup();
  setStatus(message);
}

function stop() {
  cleanup();
  setStatus("Stopped.");
}

function cleanup({ stopStreams = true, updateControls = true } = {}) {
  const current = active;
  active = null;
  if (updateControls) setStreamingControls(false);
  if (!current) return;

  if (current.statusTimer) clearInterval(current.statusTimer);
  try { current.captureNode.disconnect(); } catch (_) {}
  try { current.mixer.disconnect(); } catch (_) {}
  try { current.monitor.disconnect(); } catch (_) {}
  disposeAudioSource(current.sources.mic, stopStreams);
  disposeAudioSource(current.sources.screen, stopStreams);
  current.encoder.close();
  if (current.wakeLock) {
    try { current.wakeLock.release(); } catch (_) {}
  }
  setMediaSessionPlaying(false);
  if (current.ws.readyState === WebSocket.OPEN || current.ws.readyState === WebSocket.CONNECTING) {
    current.ws.close(1000, "stop");
  }
  current.audioContext.close();
}

async function copyUrl() {
  const url = rtspUrlEl.value;
  if (!url) return;

  try {
    if (!navigator.clipboard) throw new Error("Clipboard API is unavailable.");
    await navigator.clipboard.writeText(url);
  } catch (_) {
    rtspUrlEl.focus();
    rtspUrlEl.select();
    document.execCommand("copy");
    rtspUrlEl.setSelectionRange(rtspUrlEl.value.length, rtspUrlEl.value.length);
  }

  setRtspHint(tr("copied"));
  showRtspHint();
  clearTimeout(rtspHintResetTimer);
  rtspHintResetTimer = setTimeout(() => setRtspHint(tr("clickToCopy")), 900);
}

async function newLink() {
  if (sourceRequestInFlight || linkRestartInFlight) return;
  const sources = activeSourceSpecs();
  linkRestartInFlight = true;
  newLinkBtn.disabled = true;

  try {
    rotateCode();
    await updateUrl();
    if (!active || sources.length === 0) return;

    cleanup({ stopStreams: false, updateControls: false });
    const first = sources[0];
    await start(first.kind, first.deviceId, first.settings, first.mediaStream);
    if (!active) {
      for (let i = 1; i < sources.length; i++) stopMediaStream(sources[i].mediaStream);
      return;
    }
    for (let i = 1; i < sources.length && active; i++) {
      const source = sources[i];
      await addOrReplaceSource(source.kind, source.deviceId, source.settings, source.mediaStream);
    }
  } finally {
    linkRestartInFlight = false;
    newLinkBtn.disabled = false;
  }
}

rtspUrlEl.onclick = copyUrl;
rtspUrlEl.addEventListener("mouseenter", showRtspHint);
rtspUrlEl.addEventListener("mouseleave", hideRtspHint);
rtspUrlEl.addEventListener("focusin", showRtspHint);
rtspUrlEl.addEventListener("focusout", hideRtspHint);
newLinkBtn.onclick = newLink;
micBtn.onclick = () => start("mic");
screenBtn.onclick = () => start("screen");
stopBtn.onclick = stop;
streamInfoWrapEl.addEventListener("mouseenter", showStreamInfoHint);
streamInfoWrapEl.addEventListener("mouseleave", hideStreamInfoHint);
streamInfoWrapEl.addEventListener("focusin", showStreamInfoHint);
streamInfoWrapEl.addEventListener("focusout", hideStreamInfoHint);
micDeviceEl.onchange = () => {
  saveMicDeviceSelection();
  if (active) addOrReplaceSource("mic");
};
serverSelectEl.onchange = () => {
  if (active) stop();
  if (serverSelectEl.value === "custom") {
    saveSelectedServerValue();
    updateCustomVisibility();
    updateUrl();
    return;
  }
  connectSelectedServer();
};
customConnectBtn.onclick = connectCustomServer;
customBookmarkBtn.onclick = bookmarkCustomServer;
encoderModeEl.onchange = () => {
  writeStorage(encoderModeStorageKey, encoderModeEl.value);
};
customApiEl.addEventListener("input", () => {
  writeStorage(customApiStorageKey, customApiEl.value);
  updateCustomOption();
  updateServerHint();
});
customRtspEl.addEventListener("input", () => {
  writeStorage(customRtspStorageKey, customRtspEl.value);
  updateCustomOption();
  updateServerHint();
});
customPasswordEl.addEventListener("input", () => {
  writeStorage(customPasswordStorageKey, customPasswordEl.value);
});
languageSelectEl.onchange = () => {
  currentLanguage = translations[languageSelectEl.value] ? languageSelectEl.value : "en";
  writeStorage(languageStorageKey, currentLanguage);
  applyLanguage();
  refreshMicDevices().catch(() => {});
};
document.addEventListener("visibilitychange", refreshScreenWakeLock);
window.addEventListener("resize", () => {
  fitRtspUrlText();
  positionRtspHint();
  positionStreamInfoHint();
});
window.addEventListener("scroll", () => {
  positionRtspHint();
  positionStreamInfoHint();
}, { passive: true });
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    refreshMicDevices().catch(() => {});
  });
}

async function init() {
  streamCode = loadCode();
  loadLanguage();
  applyLanguage();
  await loadServers();
  renderServers();
  loadEncoderMode();
  await selectWasmWhenNativeUnsupported();
  try { await refreshMicDevices(savedMicDeviceId()); } catch (_) {}
  setStreamingControls(false);
  updateUrl();
  refreshStats();
  setInterval(refreshStats, statsRefreshMs);
}

init().catch(error => setStatus(error.message || String(error)));
