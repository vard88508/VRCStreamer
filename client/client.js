const $ = id => document.getElementById(id);
const mainEl = document.querySelector("main");
const serverSelectEl = $("serverSelect");
const serverHintEl = $("serverHint");
const messageBoxEl = $("messageBox");
const patronsEl = $("patrons");
const customServerEl = $("customServer");
const customApiEl = $("customApi");
const customPasswordEl = $("customPassword");
const customConnectBtn = $("customConnect");
const rtspUrlEl = $("rtspUrl");
const rtspHintEl = $("rtspHint");
const encoderModeEl = $("encoderMode");
const micDeviceEl = $("micDevice");
const micDeviceWrapEl = $("micDeviceWrap");
const micDeviceSelectedLabelEl = $("micDeviceSelectedLabel");
const micDeviceLabelEl = $("micDeviceLabel");
const sourcesEl = $("sources");
const addSourcesEl = $("addSources");
const firstSourceSelectionEl = $("firstSourceSelection");
const startTitleEl = $("startTitle");
const startTipEl = $("startTip");
const screenLabelEl = $("screenLabel");
const tabAudioHintEl = $("tabAudioHint");
const videoChoiceEl = $("videoChoice");
const videoSourceBtn = $("videoSource");
const videoSourceLabelEl = $("videoSourceLabel");
const streamPanelEl = $("streamPanel");
const streamToTitleEl = $("streamToTitle");
const streamInfoWrapEl = $("streamInfoWrap");
const streamInfoEl = $("streamInfo");
const streamInfoHintEl = $("streamInfoHint");
const statsEl = $("stats");
const pasteHintEl = $("pasteHint");
const newLinkBtn = $("newLink");
const micBtn = $("mic");
const screenBtn = $("screen");
const stopBtn = $("stop");
const sourceCodeLinkEl = $("sourceCodeLink");
const reportBugLinkEl = $("reportBugLink");
const languageSelectEl = $("languageSelect");
const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~";
const streamCodeLength = 32;
const storagePrefix = "vrc-audio-streamer-";
const storageVersion = "2";
const storageVersionKey = `${storagePrefix}storage-version`;
const codeStorageKey = "vrc-audio-streamer-code";
const serverStorageKey = "vrc-audio-streamer-server";
const customApiStorageKey = "vrc-audio-streamer-custom-api";
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
const wasm192Bitrate = 192000;
const wasm320Bitrate = 320000;
const expectedEncodedFps = sampleRate / framesPerChunk;
const expectedEncodedFpsLabel = expectedEncodedFps.toFixed(1);
const native192Bitrates = [192000];
const expectedAacConfigHex = "1190";
const statsRefreshMs = 15000;
const messageRefreshMs = 60000;
const monitorOutputGain = 0.0001;
const videoWidth = 1280;
const videoHeight = 720;
const videoFps = 30;
const videoCaptureFps = 30;
const videoBitrate = 2500000;
const videoKeyframeInterval = videoFps * 2;
const videoFramePeriodUs = Math.round(1000000 / videoFps);
const videoPlaceholderHoldMs = 15000;
const maxAudioWsBufferedBytes = 256 * 1024;
const maxVideoWsBufferedBytes = 1024 * 1024;
const isFirefoxBased = /\b(Firefox|FxiOS|Waterfox|LibreWolf|Iceweasel)\b/i.test(navigator.userAgent);
const patronTiers = [
  { key: "Tier4", className: "tier4" },
  { key: "Tier3", className: "tier3" },
  { key: "Tier2", className: "tier2" },
  { key: "Tier1", className: "tier1" }
];
const fallbackServers = [
  {
    name: "Local 554",
    description: "Local test server on default RTSP port 554.",
    apiBase: "http://127.0.0.1:8081",
    rtspBase: "rtspt://127.0.0.1"
  },
  {
    name: "Local 8554",
    description: "Local test server on RTSP port 8554.",
    apiBase: "http://127.0.0.1:8081",
    rtspBase: "rtspt://127.0.0.1:8554"
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
let messagePayload = null;
let patronTiersPayload = [];
let nativeAacAvailable = true;
let serverStatus = { state: "loading", streams: 0, listeners: 0 };

const encoderModes = {
  native192: {
    bitrate: 192000,
    nativeAacBitrates: native192Bitrates,
    preferNative: true,
    allowWasmFallback: false
  },
  wasm192: {
    bitrate: wasm192Bitrate,
    nativeAacBitrates: [],
    preferNative: false,
    allowWasmFallback: true
  },
  wasm320: {
    bitrate: wasm320Bitrate,
    nativeAacBitrates: [],
    preferNative: false,
    allowWasmFallback: true
  }
};

const translations = {
  en: {
    api: "HTTP API Address",
    clickToCopy: "Click to Copy",
    connect: "Connect",
    copied: "Copied!",
    customOption: "Custom Server",
    customServerHint: "Use your own API server address.",
    generateNewLink: "Generate Another Link",
    micInput: "Mic/Input Device",
    mono: "Mono",
    mute: "Mute",
    hideMuteVideo: "Hide+Mute Video",
    nativeEncoder: "🔊 Native AAC 192 kbps",
    password: "Password (optional)",
    pasteVideoHint: "Paste this link into video player",
    sourceCode: "Source Code",
    reportBug: "Report a bug",
    statusLoading: "Loading",
    statusOffline: "Offline",
    statusOnline: "Online",
    thankYou: "Thank you for your support",
    stopStreaming: "Stop Streaming",
    startTip: "Tip: You can mute browser tabs by right-clicking them, so you do not get annoyed by echo while streaming into VRChat.",
    streamAudioFrom: "Stream Audio From",
    streamFrom: "Stream From",
    streamingTo: "Streaming To",
    tabSystem: "Tab/System Audio",
    tabAudioHint: "Make sure \"Share Audio\" is enabled in the browser picker.",
    chromiumRequired: "Requires Chromium-based browser.",
    tabSystemCard: "Tab/System Audio",
    tabVideoCard: "Tab/System Video",
    tabVideoAudioCard: "Tab/System Video + Audio",
    videoSource: "Tab/System Video",
    addMicInput: "Mic/Input Device Audio",
    addTabSystem: "Tab/System Audio",
    addVideoSource: "Tab/System Video",
    wasm192Encoder: "🔊 WASM AAC 192 kbps",
    wasmEncoder: "🔊 WASM AAC 320 kbps"
  },
  ja: {
    api: "HTTP API アドレス",
    clickToCopy: "クリックでコピー",
    connect: "接続",
    copied: "コピーしました",
    customOption: "カスタムサーバー",
    customServerHint: "独自の API サーバーアドレスを使います。",
    generateNewLink: "別のリンクを生成",
    micInput: "マイク/入力デバイス",
    mono: "モノラル",
    mute: "ミュート",
    hideMuteVideo: "映像を隠す+ミュート",
    nativeEncoder: "🔊 Native AAC 192 kbps",
    password: "パスワード（任意）",
    pasteVideoHint: "このリンクをビデオプレイヤーに貼り付け",
    sourceCode: "ソースコード",
    reportBug: "バグを報告",
    statusLoading: "読み込み中",
    statusOffline: "オフライン",
    statusOnline: "オンライン",
    thankYou: "ご支援ありがとうございます",
    stopStreaming: "配信を停止",
    startTip: "ヒント: ブラウザのタブは右クリックでミュートできます。VRChat に配信中の音の二重再生を防げます。",
    streamAudioFrom: "音声の配信元",
    streamFrom: "配信元",
    streamingTo: "配信先",
    tabSystem: "タブ/システム音声",
    tabAudioHint: "ブラウザの選択画面で「音声を共有」を有効にしてください。",
    chromiumRequired: "Chromium 系ブラウザが必要です。",
    tabSystemCard: "タブ/システム音声",
    tabVideoCard: "タブ/システム映像",
    tabVideoAudioCard: "タブ/システム映像 + 音声",
    videoSource: "タブ/システム映像",
    addMicInput: "マイク/入力デバイス音声",
    addTabSystem: "タブ/システム音声",
    addVideoSource: "タブ/システム映像",
    wasm192Encoder: "🔊 WASM AAC 192 kbps",
    wasmEncoder: "🔊 WASM AAC 320 kbps"
  },
  ru: {
    api: "HTTP API адрес",
    clickToCopy: "Нажми, чтобы скопировать",
    connect: "Подключить",
    copied: "Скопировано!",
    customOption: "Свой сервер",
    customServerHint: "Использовать свой адрес API сервера.",
    generateNewLink: "Сгенерировать другую ссылку",
    micInput: "Микрофона/Устройства ввода",
    mono: "Моно",
    mute: "Заглушить",
    hideMuteVideo: "Скрыть+заглушить видео",
    nativeEncoder: "🔊 Native AAC 192 kbps",
    password: "Пароль (необязательно)",
    pasteVideoHint: "Вставь эту ссылку в видеоплеер",
    sourceCode: "Исходный код",
    reportBug: "Зарепортить баг",
    statusLoading: "Загрузка",
    statusOffline: "Не в сети",
    statusOnline: "В сети",
    thankYou: "Спасибо за поддержку",
    stopStreaming: "Остановить стрим",
    startTip: "Совет: Ты можешь выключить звук из вкладки, нажав по ней правой кнопкой мыши. Так у тебя не будет двоиться звук при стриме в VRChat.",
    streamAudioFrom: "Транслировать звук из",
    streamFrom: "Транслировать из",
    streamingTo: "Транслируется на",
    tabSystem: "Вкладки/системы аудио",
    tabAudioHint: "Убедись, что в окне выбора вкладки включено «Поделиться аудио».",
    chromiumRequired: "Требуется Chromium-based браузер.",
    tabSystemCard: "Вкладка/система аудио",
    tabVideoCard: "Вкладка/система видео",
    tabVideoAudioCard: "Вкладка/система видео + аудио",
    videoSource: "Вкладки/системы видео",
    addMicInput: "Звук из микрофона/устройства ввода",
    addTabSystem: "Звук из вкладки/системы",
    addVideoSource: "Видео из вкладки/системы",
    wasm192Encoder: "🔊 WASM AAC 192 kbps",
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

function resetStorageIfVersionChanged() {
  try {
    if (localStorage.getItem(storageVersionKey) === storageVersion) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(storagePrefix) && key !== bookmarkedServersStorageKey) keys.push(key);
    }
    keys.forEach(key => localStorage.removeItem(key));
    localStorage.setItem(storageVersionKey, storageVersion);
  } catch (_) {}
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

resetStorageIfVersionChanged();

function setElementText(el, key) {
  if (el) el.textContent = tr(key);
}

function micDeviceLabel() {
  return tr("micInput");
}

function micDeviceStartLabel() {
  return `▾ ${micDeviceLabel()}`;
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
  const wasm192Option = encoderModeEl.querySelector('option[value="wasm192"]');
  const wasmOption = encoderModeEl.querySelector('option[value="wasm320"]');
  if (nativeOption) nativeOption.textContent = tr("nativeEncoder");
  if (wasm192Option) wasm192Option.textContent = tr("wasm192Encoder");
  if (wasmOption) wasmOption.textContent = tr("wasmEncoder");
  updateNativeEncoderOption();
}

function updateNativeEncoderOption() {
  const nativeOption = encoderModeEl.querySelector('option[value="native192"]');
  if (nativeOption) nativeOption.hidden = !nativeAacAvailable;
  if (!nativeAacAvailable && encoderModeEl.value === "native192") {
    encoderModeEl.value = "wasm192";
    writeStorage(encoderModeStorageKey, encoderModeEl.value);
  }
}

function normalizeMessageText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function localizedMessageText(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const direct = normalizeMessageText(message[currentLanguage]);
  if (direct) return direct;
  const english = normalizeMessageText(message.en);
  if (english) return english;
  for (const value of Object.values(message)) {
    const text = normalizeMessageText(value);
    if (text) return text;
  }
  return "";
}

function renderMessage() {
  const text = localizedMessageText(messagePayload);
  messageBoxEl.textContent = text;
  messageBoxEl.hidden = !text;
}

async function refreshMessage() {
  const url = new URL("message.json", location.href);
  url.searchParams.set("t", String(Date.now()));
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`message.json ${response.status}`);
    messagePayload = await response.json();
  } catch (_) {
    messagePayload = null;
  }
  renderMessage();
}

function tierPayloadValue(payload, key) {
  return payload[key] || payload[key.toLowerCase()] || payload[key.toUpperCase()];
}

function patronName(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && typeof value.name === "string") return value.name.trim();
  return "";
}

function normalizePatronTiers(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return patronTiers
    .map(tier => {
      const value = tierPayloadValue(payload, tier.key);
      return {
        ...tier,
        names: Array.isArray(value) ? value.map(patronName).filter(Boolean) : []
      };
    })
    .filter(tier => tier.names.length > 0);
}

function renderPatrons(tiers) {
  patronTiersPayload = Array.isArray(tiers) ? tiers : [];
  patronsEl.textContent = "";
  const hasPatrons = patronTiersPayload.some(tier => tier.names.length > 0);
  patronsEl.hidden = !hasPatrons;
  if (!hasPatrons) return;

  const header = document.createElement("div");
  header.className = "patrons-header";
  const title = document.createElement("span");
  title.textContent = tr("thankYou");
  const heart = document.createElement("span");
  heart.className = "patrons-heart";
  heart.textContent = "♥";
  header.append(title, " ", heart);
  patronsEl.appendChild(header);

  patronTiersPayload.forEach(tier => {
    const row = document.createElement("div");
    row.className = `patron-tier patron-${tier.className}`;
    tier.names.forEach(name => {
      const item = document.createElement("span");
      item.className = "patron-name";
      item.textContent = name;
      row.appendChild(item);
    });
    patronsEl.appendChild(row);
  });
}

async function refreshPatrons() {
  try {
    const response = await fetch(new URL("patrons.json", location.href), { cache: "no-store" });
    if (!response.ok) throw new Error(`patrons.json ${response.status}`);
    renderPatrons(normalizePatronTiers(await response.json()));
  } catch (_) {
    renderPatrons([]);
  }
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage === "ja" ? "ja" : currentLanguage === "ru" ? "ru" : "en";
  updateStartTitle();
  setElementText(startTipEl, "startTip");
  setElementText(screenLabelEl, "tabSystem");
  tabAudioHintEl.textContent = tr("tabAudioHint");
  setElementText(videoSourceLabelEl, "videoSource");
  setElementText(streamToTitleEl, "streamingTo");
  customApiEl.placeholder = tr("api");
  customPasswordEl.placeholder = tr("password");
  setElementText(sourceCodeLinkEl, "sourceCode");
  setElementText(reportBugLinkEl, "reportBug");
  micDeviceLabelEl.textContent = micDeviceStartLabel();
  updateMicDeviceDisplay();
  updateActiveSourceLabels();
  customConnectBtn.textContent = tr("connect");
  pasteHintEl.textContent = tr("pasteVideoHint");
  newLinkBtn.textContent = tr("generateNewLink");
  stopBtn.textContent = `⏹ ${tr("stopStreaming")}`;
  updateEncoderLabels();
  if (rtspHintEl.textContent && rtspHintEl.textContent !== tr("copied")) setRtspHint(tr("clickToCopy"));
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
  renderMessage();
  renderServerStatus();
  renderPatrons(patronTiersPayload);
  updateCustomOption();
  updateServerHint();
  renderAddSourceButtons();
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

function systemCaptureDisabled() {
  return isFirefoxBased;
}

function showSystemSourceHint(kind) {
  if (systemCaptureDisabled()) {
    tabAudioHintEl.textContent = tr("chromiumRequired");
  } else if (kind === "screen") {
    tabAudioHintEl.textContent = tr("tabAudioHint");
  } else {
    return;
  }
  tabAudioHintEl.classList.add("is-visible");
}

function hideSystemSourceHint() {
  tabAudioHintEl.classList.remove("is-visible");
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

function renderServerStatus() {
  if (serverStatus.state === "online") {
    setStats(`🟢 ${tr("statusOnline")} 📡${serverStatus.streams} 👥${serverStatus.listeners}`);
  } else if (serverStatus.state === "offline") {
    setStats(`🔴 ${tr("statusOffline")}`);
  } else {
    setStats(`🟡 ${tr("statusLoading")}`);
  }
}

function setServerStatus(state, streams = 0, listeners = 0) {
  serverStatus = { state, streams, listeners };
  renderServerStatus();
}

function randomCode() {
  const bytes = new Uint8Array(streamCodeLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += charset[byte % charset.length];
  return out;
}

function validStoredCode(code) {
  return typeof code === "string" && code.length === streamCodeLength && /^[\x21-\x7e]+$/.test(code);
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
  const base = normalizeBase(value, "rtspt://");
  if (!base) return "";
  return !isLoopbackBase(server.apiBase, "https://") && isLoopbackBase(base, "rtspt://")
    ? ""
    : base;
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
  const saved = readJsonStorage(serverMetaStorageKey, {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  for (const [key, value] of Object.entries(saved)) {
    const meta = normalizeServerMeta(value);
    if (meta && (meta.name || meta.description || meta.rtspBase || meta.video)) serverMetaCache[key] = meta;
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

function customOptionText() {
  return tr("customOption");
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
  customApiEl.value = readStorage(customApiStorageKey);
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
  if (saved === "wasm190") saved = "wasm192";
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
  nativeAacAvailable = await nativeEncoderSupported();
  updateNativeEncoderOption();
}

function selectedEncoderMode() {
  return encoderModes[encoderModeEl.value] || encoderModes.native192;
}

function updateCustomVisibility() {
  const custom = serverSelectEl.value === "custom";
  const locked = Boolean(active);
  customServerEl.hidden = !custom || locked;
  customApiEl.disabled = locked || !custom;
  customPasswordEl.disabled = locked || !custom;
  customConnectBtn.disabled = locked || !custom;
  updateCustomOption();
  updateServerHint();
}

function selectedServer() {
  if (serverSelectEl.value === "custom") {
    return {
      name: tr("customOption"),
      description: tr("customServerHint"),
      apiBase: customApiEl.value,
      password: customPasswordEl.value
    };
  }
  return servers[Number(serverSelectEl.value)] || servers[0] || fallbackServers[0];
}

function customServerEntry() {
  return normalizeServerEntry({
    apiBase: customApiEl.value,
    password: customPasswordEl.value
  });
}

function saveSelectedServerValue() {
  writeStorage(serverStorageKey, serverSelectEl.value);
}

async function connectSelectedServer() {
  saveSelectedServerValue();
  setServerStatus("loading");
  updateCustomVisibility();
  updateUrl();
  return await refreshStats();
}

async function connectCustomServer() {
  const entry = customServerEntry();
  if (!entry) {
    return;
  }
  serverSelectEl.value = "custom";
  const connected = await connectSelectedServer();
  if (connected) saveCustomServer(entry);
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

function serverVideoEnabled() {
  const info = currentServerInfo();
  if (info) return Boolean(info.video);
  const meta = savedServerMeta(selectedServer());
  return Boolean(meta && meta.video);
}

function updateStartTitle() {
  startTitleEl.textContent = tr(serverVideoEnabled() ? "streamFrom" : "streamAudioFrom");
}

function applyServerInfo(info, targetKey = currentServerKey()) {
  if (!info || typeof info !== "object") return;
  if (targetKey !== currentServerKey()) return;

  const name = typeof info.name === "string" ? info.name.trim() : "";
  const description = typeof info.description === "string" ? info.description.trim() : "";
  const rtspBase = typeof info.rtsp_base === "string"
    ? info.rtsp_base.trim()
    : typeof info.rtspBase === "string"
      ? info.rtspBase.trim()
      : "";
  const previous = serverMetaCache[targetKey] || {};
  const selected = selectedServer();
  const currentRtspBase = safeRtspBaseForServer(selected, rtspBase);
  const previousRtspBase = safeRtspBaseForServer(selected, previous.rtspBase || "");
  const meta = {
    name: name || previous.name || "",
    description: description || previous.description || "",
    rtspBase: currentRtspBase || previousRtspBase || "",
    video: Boolean(info.video)
  };
  serverInfo = { key: targetKey, ...meta };
  if (meta.name || meta.description || meta.rtspBase || "video" in info) {
    serverMetaCache[targetKey] = meta;
    saveServerMetaCache();
  }

  if (serverSelectEl.value !== "custom") {
    const index = Number(serverSelectEl.value);
    const server = servers[index];
    if (server) {
      if (meta.name) server.name = meta.name;
      server.description = meta.description;
      if (meta.rtspBase) server.rtspBase = meta.rtspBase;
      updateServerOption(index, server);
    }
  } else {
    updateCustomOption();
  }

  updateCustomVisibility();
  updateSourceControls();
  updateUrl();
}

function normalizeBase(value, defaultProtocol) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = defaultProtocol + text;
  return text.replace(/\/+$/, "");
}

function apiUrlFor(server, path) {
  const base = normalizeBase(server.apiBase, location.protocol === "https:" ? "https://" : "http://");
  if (!base) throw new Error("API server is not configured.");
  return new URL(String(path).replace(/^\/+/, ""), base + "/");
}

function mediaUrl(hash) {
  const base = normalizeBase(serverRtspBase(selectedServer()), "rtspt://");
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

function sourceSettings(source) {
  return {
    gain: sourceGain(source),
    mute: Boolean(source.muteEl && source.muteEl.checked),
    forceMono: Boolean(source.monoEl && source.monoEl.checked)
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
  if (!source.gainEl) return;
  const stored = readStoredSourceSettings();
  stored[source.kind] = normalizeStoredSourceSettings(source.kind, {
    gain: sourceGain(source),
    forceMono: Boolean(source.monoEl && source.monoEl.checked)
  });
  writeJsonStorage(sourceSettingsStorageKey, stored);
}

function activeSourceSpecs() {
  if (!active) return [];
  const specs = [];
  for (const kind of ["mic", "screen", "video"]) {
    const source = active.sources[kind];
    if (!source) continue;
    specs.push({
      kind,
      deviceId: source.deviceId || "",
      mediaStream: source.mediaStream,
      settings: source.gainEl ? sourceSettings(source) : null
    });
  }
  return specs;
}

function addSourceLabel(kind) {
  if (kind === "mic") return tr("addMicInput");
  if (kind === "video") return tr("addVideoSource");
  return tr("addTabSystem");
}

function addSourceIcon(kind) {
  if (kind === "mic") return "🎙️";
  if (kind === "video") return "📺";
  return "🔊";
}

function addSourceButtonLabel(kind) {
  return `＋ ${addSourceLabel(kind)} ${addSourceIcon(kind)}`;
}

function createAddMicSourceControl() {
  const wrap = document.createElement("span");
  const button = document.createElement("button");
  const select = document.createElement("select");
  const placeholder = document.createElement("option");
  placeholder.value = "__add_mic";
  placeholder.textContent = addSourceButtonLabel("mic");
  wrap.className = "add-source-mic";
  button.type = "button";
  button.textContent = placeholder.textContent;
  button.disabled = sourceRequestInFlight;
  select.className = "add-source-hidden-select";
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
  button.onclick = () => {
    if (sourceRequestInFlight) return;
    if (!micDeviceSelectionReady) {
      addOrReplaceSource("mic");
      return;
    }
    if (typeof select.showPicker === "function") {
      try {
        select.showPicker();
        return;
      } catch (_) {}
    }
    select.focus();
    select.click();
  };
  select.onchange = () => {
    const deviceId = select.value;
    select.value = placeholder.value;
    if (deviceId === placeholder.value || sourceRequestInFlight) return;
    saveMicDeviceSelection(deviceId);
    addOrReplaceSource("mic", deviceId);
  };
  wrap.append(button, select);
  return wrap;
}

function renderAddSourceButtons() {
  addSourcesEl.textContent = "";
  if (!active) {
    stopBtn.remove();
    return;
  }

  const missing = [];
  const systemDisabled = systemCaptureDisabled();
  if (!systemDisabled && (!active.sources.screen || active.sources.video)) missing.push("screen");
  if (!active.sources.mic) missing.push("mic");
  if (!systemDisabled && serverVideoEnabled() && (!active.sources.video || active.sources.screen)) missing.push("video");

  missing.forEach(kind => {
    if (kind === "mic") {
      addSourcesEl.appendChild(createAddMicSourceControl());
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = addSourceButtonLabel(kind);
    button.disabled = sourceRequestInFlight;
    button.onclick = () => addOrReplaceSource(kind);
    addSourcesEl.appendChild(button);
  });
  addSourcesEl.appendChild(stopBtn);
}

function updateSourceControls() {
  const streaming = Boolean(active);
  const videoEnabled = serverVideoEnabled();
  const systemDisabled = systemCaptureDisabled();
  micBtn.disabled = sourceRequestInFlight;
  screenBtn.disabled = sourceRequestInFlight;
  videoChoiceEl.hidden = !videoEnabled;
  videoSourceBtn.disabled = sourceRequestInFlight || !videoEnabled;
  screenBtn.classList.toggle("is-browser-disabled", systemDisabled);
  videoSourceBtn.classList.toggle("is-browser-disabled", systemDisabled);
  screenBtn.setAttribute("aria-disabled", String(systemDisabled));
  videoSourceBtn.setAttribute("aria-disabled", String(systemDisabled));
  micDeviceEl.disabled = sourceRequestInFlight || !micDeviceSelectionReady;
  encoderModeEl.disabled = false;
  newLinkBtn.disabled = linkRestartInFlight;
  stopBtn.disabled = !streaming;
  updateStartTitle();
  if (active && !videoEnabled && active.sources.video) removeVideoSource(active.sources.video);
  renderAddSourceButtons();
}

function setMicDeviceSelectionReady(ready) {
  micDeviceSelectionReady = ready;
  micDeviceWrapEl.hidden = !ready;
  micDeviceLabelEl.hidden = ready;
  updateMicDeviceDisplay();
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
  updateMicDeviceDisplay();
}

function selectedMicDeviceText() {
  const option = micDeviceEl.selectedOptions && micDeviceEl.selectedOptions[0];
  return (option && option.textContent.trim()) || micDeviceLabel();
}

function updateMicDeviceDisplay() {
  micDeviceSelectedLabelEl.textContent = selectedMicDeviceText();
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
    updateMicDeviceDisplay();
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
  updateMicDeviceDisplay();
  updateSourceControls();
}

function wsUrlForCode(code, server = selectedServer()) {
  const url = apiUrlFor(server, `ingest?code=${encodeURIComponent(code)}`);
  const password = server.password || "";
  if (password) url.searchParams.set("password", password);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error("API server must use http:// or https://.");
  return url.toString();
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
    setServerStatus("online", stats.active_streams, stats.active_listeners);
    return true;
  } catch (_) {
    if (key !== currentServerKey()) return false;
    setServerStatus("offline");
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

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function isDisplayMediaConstraintError(error) {
  const name = error && error.name ? error.name : "";
  const message = error && error.message ? error.message : String(error || "");
  return name === "TypeError"
    || name === "NotSupportedError"
    || name === "OverconstrainedError"
    || /not supported|constraint|parameter|operation/i.test(message);
}

async function getDisplayMediaCompat(primary, fallbacks = []) {
  try {
    return await navigator.mediaDevices.getDisplayMedia(primary);
  } catch (error) {
    if (!isDisplayMediaConstraintError(error)) throw error;
    let lastError = error;
    for (const constraints of fallbacks) {
      try {
        return await navigator.mediaDevices.getDisplayMedia(constraints);
      } catch (fallbackError) {
        if (!isDisplayMediaConstraintError(fallbackError)) throw fallbackError;
        lastError = fallbackError;
      }
    }
    throw lastError;
  }
}

function isMissingAudioDeviceError(error) {
  const name = error && error.name;
  return name === "OverconstrainedError"
    || name === "NotFoundError"
    || name === "DevicesNotFoundError"
    || name === "ConstraintNotSatisfiedError";
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
    const video = {
      width: { ideal: videoWidth },
      height: { ideal: videoHeight },
      frameRate: { ideal: videoCaptureFps, max: videoCaptureFps }
    };
    return await getDisplayMediaCompat({
      video,
      audio
    }, [
      { video, audio: true },
      { video: true, audio: true }
    ]);
  }
  const deviceId = deviceIdOverride ?? micDeviceEl.value;
  if (!deviceId) return await navigator.mediaDevices.getUserMedia({ video: false, audio });

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { ...audio, deviceId: { exact: deviceId } }
    });
  } catch (error) {
    if (!isMissingAudioDeviceError(error)) throw error;
    saveMicDeviceSelection("");
    return await navigator.mediaDevices.getUserMedia({ video: false, audio });
  }
}

async function captureVideo() {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    sampleRate
  };
  const video = {
    width: { ideal: videoWidth },
    height: { ideal: videoHeight },
    frameRate: { ideal: videoCaptureFps, max: videoCaptureFps }
  };
  return await getDisplayMediaCompat({
    video,
    audio
  }, [
    { video, audio: true },
    { video: true, audio: true },
    { video: true, audio: false }
  ]);
}

function removeVideoTracks(mediaStream) {
  for (const track of mediaStream.getVideoTracks()) {
    mediaStream.removeTrack(track);
    track.stop();
  }
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
  let statsAt = performance.now();
  let statsFrames = 0;
  let statsBytes = 0;
  let currentEncodedFps = 0;
  let currentEncodedKbps = 0;
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
      const now = performance.now();
      const elapsed = Math.max((now - statsAt) / 1000, 0.001);
      if (elapsed >= 0.25) {
        currentEncodedFps = (encodedFrames - statsFrames) / elapsed;
        currentEncodedKbps = ((encodedBytes - statsBytes) * 8 / 1000) / elapsed;
        statsAt = now;
        statsFrames = encodedFrames;
        statsBytes = encodedBytes;
      }
      return {
        name,
        detail,
        fallbackReason,
        pcmBlocks,
        encodedFrames,
        encodedBytes,
        encodedFps: currentEncodedFps,
        encodedKbps: currentEncodedKbps,
        queue: pcmBlocks - encodedFrames
      };
    }
  };
}

function createVideoWorker(ws, onError) {
  const worker = new Worker(new URL("video-worker.js", location.href));
  let closed = false;
  let framePending = false;
  let readySettled = false;
  let latestStats = {
    submitted: 0,
    encoded: 0,
    dropped: 0,
    sourceFrames: 0,
    fps: 0,
    sourceFps: 0,
    kbps: 0,
    queue: 0
  };

  const ready = new Promise((resolve, reject) => {
    const failReady = error => {
      if (!readySettled) {
        readySettled = true;
        reject(error);
      } else if (!closed) {
        closed = true;
        try { worker.postMessage({ type: "close" }); } catch (_) {}
        worker.terminate();
        onError(error);
      }
    };
    worker.onmessage = event => {
      const message = event.data || {};
      if (message.type === "ready") {
        readySettled = true;
        resolve();
      } else if (message.type === "packet") {
        if (closed || !active || active.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > maxVideoWsBufferedBytes) {
          failReady(new Error("Network video queue is too slow; stopped video."));
          return;
        }
        ws.send(message.packet);
      } else if (message.type === "stats") {
        latestStats = message.stats || latestStats;
      } else if (message.type === "frame") {
        framePending = false;
      } else if (message.type === "error") {
        failReady(new Error(message.message || "Video worker failed."));
      }
    };
    worker.onerror = event => {
      failReady(new Error(event.message || "Video worker failed."));
    };
  });

  return {
    ready,
    init(message, transfer = []) {
      worker.postMessage({
        type: "init",
        width: videoWidth,
        height: videoHeight,
        fps: videoFps,
        bitrate: videoBitrate,
        keyframeInterval: videoKeyframeInterval,
        framePeriodUs: videoFramePeriodUs,
        placeholderUrl: new URL("static/live-placeholder.webp", location.href).href,
        ...message
      }, transfer);
    },
    frame(frame) {
      if (framePending) {
        frame.close();
        return false;
      }
      try {
        framePending = true;
        worker.postMessage({ type: "frame", frame }, [frame]);
        return true;
      } catch (error) {
        framePending = false;
        frame.close();
        throw error;
      }
    },
    setTrack(track) {
      worker.postMessage({ type: "track", track }, [track]);
    },
    placeholder() {
      worker.postMessage({ type: "placeholder" });
    },
    close() {
      closed = true;
      try { worker.postMessage({ type: "close" }); } catch (_) {}
      worker.terminate();
    },
    stats() {
      return {
        ...latestStats,
        wsKBytes: ws.bufferedAmount / 1024
      };
    }
  };
}

function videoTrackFrameRate(track) {
  try {
    const value = Number(track && track.getSettings && track.getSettings().frameRate);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (_) {
    return 0;
  }
}

function videoStats(worker, mode, track, captureFps = 0) {
  const stats = worker.stats();
  return {
    ...stats,
    mode,
    captureFps: captureFps || stats.sourceFps,
    trackFps: videoTrackFrameRate(track),
    workerInputFps: stats.sourceFps
  };
}

async function createTrackVideoStreamer(source, ws, onError) {
  const worker = createVideoWorker(ws, onError);
  let currentSource = source;
  let api = null;
  const clearStopTimer = () => {
    if (!api) return;
    clearTimeout(api.stopTimer);
    api.stopTimer = 0;
  };
  const sourceTrack = nextSource => {
    const track = nextSource && nextSource.mediaStream.getVideoTracks()[0];
    if (!track) throw new Error("Selected source has no video track.");
    return track;
  };
  api = {
    source,
    stopTimer: 0,
    setSource(nextSource) {
      clearStopTimer();
      const nextWorkerTrack = sourceTrack(nextSource).clone();
      worker.setTrack(nextWorkerTrack);
      currentSource = nextSource;
      api.source = nextSource;
    },
    placeholder() {
      clearStopTimer();
      worker.placeholder();
      currentSource = null;
      api.source = null;
    },
    close() {
      clearStopTimer();
      worker.close();
    },
    stats() {
      const currentTrack = currentSource && currentSource.mediaStream.getVideoTracks()[0];
      return videoStats(worker, "track", currentTrack);
    }
  };
  let workerTrack = null;
  try {
    if (source) {
      workerTrack = sourceTrack(source).clone();
      worker.init({ track: workerTrack }, [workerTrack]);
      workerTrack = null;
    } else {
      worker.init({});
    }
    await worker.ready;
    return api;
  } catch (error) {
    worker.close();
    try { workerTrack && workerTrack.stop(); } catch (_) {}
    throw error;
  }
}

async function createProcessorVideoStreamer(source, ws, onError) {
  if (!("MediaStreamTrackProcessor" in window)) {
    throw new Error("MediaStreamTrackProcessor is not available on main thread.");
  }
  const worker = createVideoWorker(ws, onError);
  let closed = false;
  let currentSource = null;
  let workerTrack = null;
  let reader = null;
  let readToken = 0;
  let api = null;
  let captureFrames = 0;
  let captureFps = 0;
  let captureStatsAt = performance.now();

  const clearStopTimer = () => {
    if (!api) return;
    clearTimeout(api.stopTimer);
    api.stopTimer = 0;
  };

  const closeReader = () => {
    readToken++;
    if (reader) {
      try { reader.cancel(); } catch (_) {}
      try { reader.releaseLock(); } catch (_) {}
      reader = null;
    }
    if (workerTrack) {
      try { workerTrack.stop(); } catch (_) {}
      workerTrack = null;
    }
  };

  const readFrames = async token => {
    try {
      while (!closed) {
        if (token !== readToken) break;
        const { done, value } = await reader.read();
        if (token !== readToken) {
          if (value) value.close();
          break;
        }
        if (done || !value) break;
        captureFrames++;
        const now = performance.now();
        const elapsed = now - captureStatsAt;
        if (elapsed >= 1000) {
          captureFps = (captureFrames * 1000) / elapsed;
          captureFrames = 0;
          captureStatsAt = now;
        }
        worker.frame(value);
      }
    } catch (error) {
      if (!closed && token === readToken) onError(error);
    }
  };

  const setSource = nextSource => {
    const track = nextSource.mediaStream.getVideoTracks()[0];
    if (!track) throw new Error("Selected source has no video track.");
    clearStopTimer();
    closeReader();
    currentSource = nextSource;
    worker.placeholder();
    workerTrack = track.clone();
    const processor = new MediaStreamTrackProcessor({ track: workerTrack });
    reader = processor.readable.getReader();
    readFrames(++readToken);
  };

  try {
    worker.init({});
    await worker.ready;
    setSource(source);
    api = {
      source,
      stopTimer: 0,
      setSource(nextSource) {
        setSource(nextSource);
        api.source = nextSource;
      },
      placeholder() {
        clearStopTimer();
        closeReader();
        currentSource = null;
        api.source = null;
        worker.placeholder();
      },
      close() {
        clearStopTimer();
        closed = true;
        closeReader();
        worker.close();
      },
      stats() {
        const currentTrack = currentSource && currentSource.mediaStream.getVideoTracks()[0];
        return videoStats(worker, "processor", currentTrack, captureFps);
      }
    };
    return api;
  } catch (error) {
    closed = true;
    closeReader();
    worker.close();
    throw error;
  }
}

async function createVideoStreamer(source, ws, onError) {
  if (!window.Worker) throw new Error("Video workers are not available.");
  if (!source || !source.mediaStream.getVideoTracks()[0]) {
    throw new Error("Selected source has no video track.");
  }

  try {
    return await createTrackVideoStreamer(source, ws, onError);
  } catch (trackError) {
    try {
      return await createProcessorVideoStreamer(source, ws, onError);
    } catch (processorError) {
      throw new Error(`Video worker failed: ${processorError.message || processorError}. Track path: ${trackError.message || trackError}`);
    }
  }
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
    streamInfoEl.textContent = "";
    setStreamInfoHint("");
  } else {
    requestAnimationFrame(fitRtspUrlText);
  }
  stopBtn.disabled = !streaming;
  newLinkBtn.disabled = linkRestartInFlight;
  serverSelectEl.disabled = false;
  encoderModeEl.disabled = false;
  updateCustomVisibility();
  updateSourceControls();
}

function videoFpsLabel(value) {
  return Number.isFinite(value) && value > 0 ? value.toFixed(1) : "-";
}

function videoStatusLines(video) {
  return `Video: H.264 ${videoWidth}x${videoHeight}@${videoFps}`
    + `\nVideo mode: ${video.mode || "worker"}`
    + `\nVideo fps: ${videoFpsLabel(video.fps)}`
    + `\nCapture target fps: ${videoCaptureFps}`
    + `\nBrowser capture fps: ${videoFpsLabel(video.captureFps)}`
    + `\nTrack setting fps: ${videoFpsLabel(video.trackFps)}`
    + `\nWorker input fps: ${videoFpsLabel(video.workerInputFps || video.sourceFps)}`
    + `\nVideo kbps: ${video.kbps.toFixed(0)}`
    + `\nVideo queue: ${video.queue}`
    + `\nWebSocket queue: ${video.wsKBytes.toFixed(0)} KB`
    + `\nVideo dropped: ${video.dropped}`;
}

function streamHintText(info, video = null) {
  if (!active) return encoderStatusLine(info);

  let text = `${encoderStatusLine(info)}${browserThrottleWarning()}`;
  if ("encodedFrames" in info) {
    text += `\nEncoded AAC frames: ${info.encodedFrames}\nEncoded fps: ${info.encodedFps.toFixed(1)}/${expectedEncodedFpsLabel}\nEncoder queue: ${info.queue}`;
  }
  if (video) text += `\n${videoStatusLines(video)}`;
  return text;
}

function renderStreamInfo(kbps, listeners) {
  streamInfoEl.textContent = `${kbps} kbps 👥${listeners}`;
}

function updateStreamStatus(info) {
  if (!active) return;
  const current = info || active.encoder.stats();
  const audioKbps = Number.isFinite(current.encodedKbps)
    ? Math.round(current.encodedKbps)
    : Math.round(selectedEncoderMode().bitrate / 1000);
  const video = active.video ? active.video.stats() : null;
  const videoKbps = video && Number.isFinite(video.kbps) ? Math.round(video.kbps) : 0;
  const kbps = audioKbps + videoKbps;
  renderStreamInfo(kbps, active.streamListeners);
  setStreamInfoHint(streamHintText(current, video));
}

function stopMediaStream(mediaStream) {
  if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
}

function fallbackSourceName(kind) {
  if (kind === "mic") return tr("micInput");
  if (kind === "video") return tr("tabVideoCard");
  return tr("tabSystemCard");
}

function sourceDisplayName(kind, mediaStream) {
  if (kind === "video") {
    return mediaStream.getAudioTracks().length > 0 ? tr("tabVideoAudioCard") : tr("tabVideoCard");
  }
  if (kind === "screen") return tr("tabSystemCard");
  const track = kind === "video" ? mediaStream.getVideoTracks()[0] : mediaStream.getAudioTracks()[0];
  const label = track?.label?.trim() || "";
  return label
    ? label.replace(/^(Mic\/Input Device|Tab\/System Audio|Tab\/System|Video|Микрофон\/устройство ввода|Вкладка\/система|Видео|マイク\/入力デバイス|タブ\/システム|映像)\s*:?\s*/i, "") || fallbackSourceName(kind)
    : fallbackSourceName(kind);
}

function localizedSourceName(source) {
  if (!source) return "";
  if (source.kind === "screen") return tr("tabSystemCard");
  if (source.kind === "video") return source.hasAudio ? tr("tabVideoAudioCard") : tr("tabVideoCard");
  return source.name;
}

function updateSourceLabel(source) {
  if (!source) return;
  const name = localizedSourceName(source);
  if (name && name !== source.name) {
    source.name = name;
    if (source.block) applySourceTheme(source.block, source);
  }
  if (source.controlEl && source.kind !== "mic") source.controlEl.textContent = `▾ ${source.name}`;
}

function updateActiveSourceLabels() {
  if (!active) return;
  updateSourceLabel(active.sources.screen);
  updateSourceLabel(active.sources.video);
  updateStreamStatus();
}

function sourceGain(source) {
  const value = Number(source.gainEl && source.gainEl.value);
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
  const muted = Boolean(source.videoHidden) || Boolean(source.muteEl && source.muteEl.checked);
  if (source.block) source.block.classList.toggle("is-muted", muted);
}

function applyAudioSourceSettings(source) {
  updateMuteState(source);
  if (!source.processor || !source.muteEl) return;
  updateGainValue(source);
  source.processor.port.postMessage({
    type: "settings",
    gain: sourceGain(source),
    mute: Boolean(source.videoHidden) || source.muteEl.checked,
    forceMono: Boolean(source.monoEl && source.monoEl.checked)
  });
}

function setVideoSourceHidden(source, hidden) {
  if (!source || source.kind !== "video") return;
  source.videoHidden = Boolean(hidden);
  if (source.muteEl) source.muteEl.checked = source.videoHidden;
  applyAudioSourceSettings(source);
  if (active && active.video && active.sources.video === source) {
    if (source.videoHidden) {
      active.video.placeholder();
      active.video.source = source;
    } else {
      active.video.setSource(source);
    }
  }
  updateStreamStatus();
}

function toggleVideoSourceHidden(source) {
  setVideoSourceHidden(source, !source.videoHidden);
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

function updateSourceVideoPreview(source) {
  if (!source.previewEl) return;
  const track = source.mediaStream.getVideoTracks()[0];
  const enabled = source.kind === "video" && Boolean(track);
  source.previewEl.hidden = !enabled;
  if (!enabled) {
    source.previewEl.pause();
    source.previewEl.srcObject = null;
    return;
  }
  if (!source.previewEl.srcObject) {
    source.previewEl.srcObject = new MediaStream([track]);
  }
  source.previewEl.play().catch(() => {});
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

  selectedOption.textContent = `▾ ${source.name}`;
  select.value = source.deviceId || "";
  return select;
}

function createSourceBlock(source) {
  const hasAudioControls = source.kind !== "video" || source.hasAudio;
  const hasMonoControl = hasAudioControls && source.kind !== "video";
  const hasPreview = source.kind === "video";
  const block = document.createElement("div");
  const iconWrap = document.createElement("button");
  const body = document.createElement("div");
  const head = document.createElement("div");
  const settings = hasAudioControls ? document.createElement("div") : null;
  const icon = document.createElement("span");
  const iconHint = document.createElement("span");
  const sourceControl = source.kind === "mic" ? createMicSourceSelect(source) : document.createElement("button");
  const gainLabel = hasAudioControls ? document.createElement("label") : null;
  const gainMeter = hasAudioControls ? document.createElement("span") : null;
  const gain = hasAudioControls ? document.createElement("input") : null;
  const gainValue = hasAudioControls ? document.createElement("span") : null;
  const mute = hasAudioControls ? document.createElement("input") : null;
  const monoLabel = hasMonoControl ? document.createElement("label") : null;
  const monoText = hasMonoControl ? document.createElement("span") : null;
  const mono = hasMonoControl ? document.createElement("input") : null;
  const preview = hasPreview ? document.createElement("video") : null;
  const remove = document.createElement("button");

  block.className = "source-card";
  applySourceTheme(block, source);
  block.style.setProperty("--source-level", "0%");
  iconWrap.type = "button";
  iconWrap.className = "source-icon";
  iconWrap.setAttribute("aria-label", source.kind === "video" ? tr("hideMuteVideo") : hasAudioControls ? "Toggle mute" : source.name);
  body.className = "source-body";
  head.className = "source-head";
  if (settings) settings.className = "source-settings";
  icon.className = "source-icon-img";
  icon.setAttribute("aria-hidden", "true");
  iconHint.className = "source-icon-hint";
  iconHint.dataset.i18n = source.kind === "video" ? "hideMuteVideo" : "mute";
  iconHint.textContent = tr(iconHint.dataset.i18n);
  const iconUrl = source.kind === "mic" ? "static/mic.webp" : source.kind === "video" ? "static/video.webp" : "static/audio.webp";
  const iconMask = `url("${iconUrl}") center / contain no-repeat`;
  icon.style.setProperty("-webkit-mask", iconMask);
  icon.style.mask = iconMask;
  sourceControl.className = "source-control";

  if (source.kind !== "mic") {
    sourceControl.type = "button";
    sourceControl.textContent = `▾ ${source.name}`;
  }

  if (preview) {
    preview.className = "source-preview";
    preview.muted = true;
    preview.playsInline = true;
  }

  remove.type = "button";
  remove.className = "source-remove";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Delete source");

  iconWrap.append(icon);
  iconWrap.append(iconHint);
  head.append(sourceControl, remove);
  if (hasAudioControls) {
    gainLabel.className = "source-gain";
    gainMeter.className = "source-gain-meter";
    gainValue.className = "source-gain-value";
    gain.type = "range";
    gain.min = "0";
    gain.max = "1.5";
    gain.step = "0.01";
    gain.value = "1";
    gainMeter.append(gain);
    gainLabel.append(gainMeter, gainValue);

    mute.type = "checkbox";
    if (hasMonoControl) {
      mono.type = "checkbox";
      mono.checked = source.kind === "mic";
      monoText.dataset.i18n = "mono";
      monoText.textContent = tr("mono");
      monoLabel.className = "source-mono";
      monoLabel.append(monoText, mono);
      settings.append(gainLabel, monoLabel);
    } else {
      settings.append(gainLabel);
    }
  }
  body.append(head);
  if (settings) body.append(settings);
  if (preview) body.append(preview);
  block.append(iconWrap, body);

  source.block = block;
  source.controlEl = sourceControl;
  source.deviceEl = source.kind === "mic" ? sourceControl : null;
  source.gainEl = gain;
  source.gainMeterEl = gainMeter;
  source.gainValueEl = gainValue;
  source.muteEl = mute;
  source.monoEl = mono;
  source.previewEl = preview;
  source.removeBtn = remove;

  iconWrap.onclick = () => {
    if (source.kind === "video") {
      toggleVideoSourceHidden(source);
      return;
    }
    if (!hasAudioControls) return;
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
  } else if (source.kind === "video") {
    sourceControl.onclick = () => addOrReplaceSource("video", null, sourceSettings(source));
  } else {
    sourceControl.onclick = () => addOrReplaceSource(source.kind, null, sourceSettings(source));
  }
  if (hasAudioControls) {
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
    if (hasMonoControl) {
      mono.addEventListener("change", () => {
        applyAudioSourceSettings(source);
        saveSourceSettings(source);
        updateStreamStatus();
      });
    }
  }
  remove.onclick = () => {
    if (source.kind === "video") removeVideoSource(source);
    else removeAudioSource(source.kind, source);
  };

  return block;
}

function sendStreamerCommand(command) {
  if (!active || active.ws.readyState !== WebSocket.OPEN) return;
  try { active.ws.send(command); } catch (_) {}
}

function stopActiveVideo(source = null) {
  if (!active || !active.video) return;
  if (source && active.video.source !== source) return;
  clearTimeout(active.video.stopTimer);
  active.video.close();
  active.video = null;
  sendStreamerCommand("video_stop");
}

function showActiveVideoPlaceholder(source = null) {
  if (!active || !active.video) return;
  if (source && active.video.source !== source) return;
  const video = active.video;
  clearTimeout(video.stopTimer);
  video.placeholder();
  video.stopTimer = setTimeout(() => {
    if (!active || active.video !== video || active.sources.video) return;
    stopActiveVideo();
    updateStreamStatus();
  }, videoPlaceholderHoldMs);
}

function disposeVideoSource(source, stopStream = true, holdVideo = true) {
  if (!source) return;
  if (active && active.video && active.video.source === source) {
    if (holdVideo) showActiveVideoPlaceholder(source);
    else stopActiveVideo(source);
  }
  try { source.node && source.node.disconnect(); } catch (_) {}
  try { source.processor && source.processor.disconnect(); } catch (_) {}
  try { source.processor && source.processor.port.close(); } catch (_) {}
  if (source.previewEl) {
    source.previewEl.pause();
    source.previewEl.srcObject = null;
  }
  if (source.block) source.block.remove();
  if (stopStream) stopMediaStream(source.mediaStream);
}

function removeVideoSource(source) {
  if (!active || active.sources.video !== source) return;
  active.sources.video = null;
  disposeVideoSource(source);
  updateSourceControls();
  updateStreamStatus();
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
  const replacedVideo = kind === "screen" ? active.sources.video : null;
  if (replacedVideo) active.sources.video = null;

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
  } else if (replacedVideo && replacedVideo.block && replacedVideo.block.parentNode) {
    replacedVideo.block.replaceWith(next.block);
  } else {
    sourcesEl.appendChild(next.block);
  }
  if (previous) disposeAudioSource(previous);
  if (replacedVideo) disposeVideoSource(replacedVideo);

  mediaStream.getAudioTracks().forEach(track => {
    track.addEventListener("ended", () => removeAudioSource(kind, next), { once: true });
  });

  updateSourceControls();
  updateStreamStatus();
}

async function requestAudioSource(kind, deviceId = null) {
  const mediaStream = await withTimeout(
    captureAudio(kind, deviceId),
    45000,
    "Timed out waiting for browser audio permission/selection."
  );
  if (kind === "screen") removeVideoTracks(mediaStream);
  if (mediaStream.getAudioTracks().length === 0) {
    stopMediaStream(mediaStream);
    throw new Error("No audio track selected");
  }
  if (kind === "mic") {
    try { await refreshMicDevices(micDeviceEl.value); } catch (_) {}
  }
  return mediaStream;
}

async function requestVideoSource() {
  if (!serverVideoEnabled()) throw new Error("Video is disabled on this server.");
  const mediaStream = await withTimeout(
    captureVideo(),
    45000,
    "Timed out waiting for browser video selection."
  );
  if (mediaStream.getVideoTracks().length === 0) {
    stopMediaStream(mediaStream);
    throw new Error("No video track selected");
  }
  return mediaStream;
}

async function installVideoSource(mediaStream, settings = null) {
  if (!active) {
    stopMediaStream(mediaStream);
    return;
  }
  if (!serverVideoEnabled()) {
    stopMediaStream(mediaStream);
    throw new Error("Video is disabled on this server.");
  }
  const hasAudio = mediaStream.getAudioTracks().length > 0;

  const next = {
    kind: "video",
    name: sourceDisplayName("video", mediaStream),
    mediaStream,
    hasAudio,
    videoHidden: false,
    node: null,
    processor: null
  };
  if (hasAudio) {
    next.node = active.audioContext.createMediaStreamSource(mediaStream);
    next.processor = new AudioWorkletNode(active.audioContext, "source-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
  }
  createSourceBlock(next);
  if (hasAudio) {
    next.processor.port.onmessage = event => {
      const message = event.data;
      if (message && message.type === "level") updateSourceLevel(next, message.peak);
    };
    const initialSettings = settings
      ? normalizeRuntimeSourceSettings("video", settings)
      : normalizeRuntimeSourceSettings("video", loadSourceSettings("video"));
    next.gainEl.value = String(initialSettings.gain);
    next.muteEl.checked = Boolean(initialSettings.mute);
  }
  updateSourceVideoPreview(next);
  applyAudioSourceSettings(next);
  saveSourceSettings(next);

  const replacedScreen = active.sources.screen;
  if (replacedScreen) active.sources.screen = null;
  const previous = active.sources.video;
  active.sources.video = next;
  if (hasAudio) {
    next.node.connect(next.processor);
    next.processor.connect(active.mixer);
  }
  if (previous && previous.block && previous.block.parentNode) {
    previous.block.replaceWith(next.block);
  } else if (replacedScreen && replacedScreen.block && replacedScreen.block.parentNode) {
    replacedScreen.block.replaceWith(next.block);
  } else {
    sourcesEl.appendChild(next.block);
  }
  let videoStartSent = false;
  try {
    if (active.video) {
      active.video.setSource(next);
    } else {
      sendStreamerCommand("video_start");
      videoStartSent = true;
      active.video = await createVideoStreamer(next, active.ws, error => {
        if (!active) return;
        removeVideoSource(next);
      });
    }
  } catch (error) {
    if (videoStartSent) sendStreamerCommand("video_stop");
    if (active && active.sources.video === next) active.sources.video = null;
    disposeVideoSource(next, true, false);
    throw error;
  }

  if (previous) disposeVideoSource(previous, true, false);
  if (replacedScreen) disposeAudioSource(replacedScreen);

  mediaStream.getTracks().forEach(track => {
    track.addEventListener("ended", () => removeVideoSource(next), { once: true });
  });

  updateSourceControls();
  updateStreamStatus();
}

async function addOrReplaceSource(kind, deviceId = null, settings = null, mediaStreamOverride = null) {
  if (!active || sourceRequestInFlight) return;
  if ((kind === "screen" || kind === "video") && systemCaptureDisabled()) {
    showSystemSourceHint(kind);
    return;
  }

  let mediaStream = mediaStreamOverride;
  setSourceRequestBusy(true);
  try {
    if (!mediaStream) {
      mediaStream = kind === "video"
        ? await requestVideoSource()
        : await requestAudioSource(kind, deviceId);
    }
    if (!active) {
      stopMediaStream(mediaStream);
      return;
    }
    if (kind === "video") {
      await installVideoSource(mediaStream, settings);
    } else {
      installAudioSource(kind, mediaStream, deviceId ?? undefined, settings);
    }
    mediaStream = null;
    updateStreamStatus();
  } catch {
  } finally {
    stopMediaStream(mediaStream);
    setSourceRequestBusy(false);
  }
}

async function start(kind, deviceId = null, settings = null, mediaStreamOverride = null) {
  if ((kind === "screen" || kind === "video") && systemCaptureDisabled()) {
    showSystemSourceHint(kind);
    return;
  }
  if (active) {
    await addOrReplaceSource(kind, deviceId, settings, mediaStreamOverride);
    return;
  }
  if (sourceRequestInFlight) return;

  const code = streamCode;
  if (code.length !== streamCodeLength) {
    return;
  }

  let mediaStream = mediaStreamOverride;
  let audioContext = null;
  let ws = null;
  let encoder = null;
  let pendingStreamListeners = 0;
  setSourceRequestBusy(true);
  try {
    if (!mediaStream) {
      mediaStream = kind === "video"
        ? await requestVideoSource()
        : await requestAudioSource(kind, deviceId);
    }

    encoder = createAacEncoder(
      packet => {
        if (!active || active.encoder !== encoder || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > maxAudioWsBufferedBytes) {
          failActive();
          return;
        }
        ws.send(packet);
      },
      () => {
        if (active && active.encoder === encoder) failActive();
      }
    );
    let encoderReadyError = null;
    const encoderReady = encoder.ready.catch(error => {
      encoderReadyError = error;
      return null;
    });
    const encoderInfo = await encoderReady;
    if (encoderReadyError) throw encoderReadyError;

    const server = selectedServer();
    const serverInfoKey = serverKey(server);
    ws = new WebSocket(wsUrlForCode(code, server));
    ws.binaryType = "arraybuffer";
    ws.onmessage = event => handleStreamerMessage(event, serverInfoKey, listeners => {
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
        failActive();
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
      video: null,
      mixer,
      captureNode,
      monitor,
      wakeLock,
      statsTimer: null,
      sources: { mic: null, screen: null, video: null },
      streamListeners: pendingStreamListeners
    };

    if (kind === "video") {
      await installVideoSource(mediaStream, settings);
    } else {
      installAudioSource(kind, mediaStream, deviceId ?? undefined, settings);
    }
    mediaStream = null;
    mixer.connect(captureNode);
    captureNode.connect(monitor);
    monitor.connect(audioContext.destination);
    await audioContext.resume();

    setStreamingControls(true);

    ws.onclose = () => {
      if (active && active.ws === ws) {
        cleanup();
      }
    };
    ws.onerror = () => {
      if (active && active.ws === ws) failActive();
    };

    updateStreamStatus(encoderInfo);
    active.statsTimer = setInterval(() => {
      if (!active || active.ws !== ws) return;
      updateStreamStatus(encoder.stats());
    }, 1000);
  } catch {
    if (encoder) encoder.close();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(3000, "start failed"); } catch (_) {
        try { ws.close(); } catch (_) {}
      }
    }
    if (audioContext) {
      try { audioContext.close(); } catch (_) {}
    }
    stopMediaStream(mediaStream);
    cleanup();
  } finally {
    setSourceRequestBusy(false);
  }
}

function failActive() {
  cleanup();
}

function stop() {
  cleanup();
}

function forceResync() {
  if (!active || active.ws.readyState !== WebSocket.OPEN) return false;
  active.ws.send("force_resync");
  return true;
}

function cleanup({ stopStreams = true, updateControls = true } = {}) {
  const current = active;
  active = null;
  if (updateControls) setStreamingControls(false);
  if (!current) return;

  if (current.statsTimer) clearInterval(current.statsTimer);
  try { current.captureNode.disconnect(); } catch (_) {}
  try { current.mixer.disconnect(); } catch (_) {}
  try { current.monitor.disconnect(); } catch (_) {}
  disposeAudioSource(current.sources.mic, stopStreams);
  disposeAudioSource(current.sources.screen, stopStreams);
  disposeVideoSource(current.sources.video, stopStreams);
  try { current.video && current.video.close(); } catch (_) {}
  try { current.encoder.close(); } catch (_) {}
  if (current.wakeLock) {
    try { current.wakeLock.release(); } catch (_) {}
  }
  setMediaSessionPlaying(false);
  if (current.ws.readyState === WebSocket.OPEN || current.ws.readyState === WebSocket.CONNECTING) {
    try { current.ws.close(1000, "stop"); } catch (_) {}
  }
  try { current.audioContext.close(); } catch (_) {}
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
  linkRestartInFlight = true;
  newLinkBtn.disabled = true;

  try {
    rotateCode();
    await updateUrl();
    await restartActiveWithCurrentSources();
  } finally {
    linkRestartInFlight = false;
    newLinkBtn.disabled = false;
  }
}

async function restartActiveWithCurrentSources() {
  const sources = activeSourceSpecs();
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
}

rtspUrlEl.onclick = copyUrl;
rtspUrlEl.addEventListener("mouseenter", showRtspHint);
rtspUrlEl.addEventListener("mouseleave", hideRtspHint);
rtspUrlEl.addEventListener("focusin", showRtspHint);
rtspUrlEl.addEventListener("focusout", hideRtspHint);
newLinkBtn.onclick = newLink;
micBtn.onclick = () => start("mic");
screenBtn.onclick = () => start("screen");
screenBtn.addEventListener("mouseenter", () => showSystemSourceHint("screen"));
screenBtn.addEventListener("mouseleave", hideSystemSourceHint);
screenBtn.addEventListener("focusin", () => showSystemSourceHint("screen"));
screenBtn.addEventListener("focusout", hideSystemSourceHint);
videoSourceBtn.onclick = () => start("video");
videoSourceBtn.addEventListener("mouseenter", () => showSystemSourceHint("video"));
videoSourceBtn.addEventListener("mouseleave", hideSystemSourceHint);
videoSourceBtn.addEventListener("focusin", () => showSystemSourceHint("video"));
videoSourceBtn.addEventListener("focusout", hideSystemSourceHint);
stopBtn.onclick = stop;
window.force_resync = forceResync;
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
    setServerStatus("loading");
    updateCustomVisibility();
    updateUrl();
    return;
  }
  connectSelectedServer();
};
customConnectBtn.onclick = connectCustomServer;
encoderModeEl.onchange = () => {
  writeStorage(encoderModeStorageKey, encoderModeEl.value);
  if (active && !sourceRequestInFlight && !linkRestartInFlight) {
    linkRestartInFlight = true;
    updateSourceControls();
    restartActiveWithCurrentSources()
      .finally(() => {
        linkRestartInFlight = false;
        updateSourceControls();
      });
  }
};
customApiEl.addEventListener("input", () => {
  writeStorage(customApiStorageKey, customApiEl.value);
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
  refreshMessage();
  refreshPatrons();
  refreshStats();
  setInterval(refreshMessage, messageRefreshMs);
  setInterval(refreshStats, statsRefreshMs);
}

init();
