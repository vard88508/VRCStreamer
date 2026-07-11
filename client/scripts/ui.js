const $ = id => document.getElementById(id);
const mainEl = document.querySelector("main");
const serverSelectEl = $("serverSelect");
const serverSelectDisplayEl = $("serverSelectDisplay");
const serverHintEl = $("serverHint");
const motdEl = $("motd");
const patronsEl = $("patrons");
const customServerFormEl = $("customServerForm");
const customApiEl = $("customApi");
const customPasswordEl = $("customPassword");
const customConnectBtn = $("customConnect");
const rtspUrlEl = $("rtspUrl");
const rtspHintEl = $("rtspHint");
const encoderModeEl = $("encoderMode");
const encoderModeWrapEl = $("encoderModeWrap");
const encoderModeDisplayEl = $("encoderModeDisplay");
const videoQualityEl = $("videoQuality");
const videoQualityWrapEl = $("videoQualityWrap");
const videoQualityDisplayEl = $("videoQualityDisplay");
const micDeviceEl = $("micDevice");
const micDeviceWrapEl = $("micDeviceWrap");
const micDeviceSelectedLabelEl = $("micDeviceSelectedLabel");
const micDeviceLabelEl = $("micDeviceLabel");
const sourcesEl = $("sources");
const addSourcesEl = $("addSources");
const firstSourceSelectionEl = $("firstSourceSelection");
const startTitleEl = $("startTitle");
const startTipEl = $("startTip");
const displayAudioLabelEl = $("displayAudioLabel");
const tabAudioHintEl = $("tabAudioHint");
const videoChoiceEl = $("videoChoice");
const displayVideoBtn = $("displayVideo");
const displayVideoLabelEl = $("displayVideoLabel");
const streamPanelEl = $("streamPanel");
const streamToTitleEl = $("streamToTitle");
const streamInfoWrapEl = $("streamInfoWrap");
const streamInfoEl = $("streamInfo");
const streamInfoHintEl = $("streamInfoHint");
const serverStatsEl = $("serverStats");
const pasteHintEl = $("pasteHint");
const newLinkBtn = $("newLink");
const micBtn = $("mic");
const displayAudioBtn = $("displayAudio");
const stopBtn = $("stop");
const sourceCodeLinkEl = $("sourceCodeLink");
const reportBugLinkEl = $("reportBugLink");
const languageSelectEl = $("languageSelect");
const languageSelectDisplayEl = $("languageSelectDisplay");

let currentLanguage = "en";
let languageOptions = { en: "English" };
let translations = Object.create(null);
let motdPayload = null;
let motdPayloadSignature = "";
let patronTiersPayload = [];
let patronTiersSignature = "";
let serverStatus = { state: "loading", streams: 0, listeners: 0 };
let rtspHintResetTimer = 0;
let micDeviceSelectionReady = false;

export function createUi(app) {
  const selectDisplays = new Map([
    [serverSelectEl, serverSelectDisplayEl],
    [encoderModeEl, encoderModeDisplayEl],
    [videoQualityEl, videoQualityDisplayEl],
    [micDeviceEl, micDeviceSelectedLabelEl],
    [languageSelectEl, languageSelectDisplayEl]
  ]);

  function updateSelectDisplay(select, display = selectDisplays.get(select)) {
    if (!display) return;
    const option = select.selectedOptions[0];
    const text = option ? option.textContent.trim() : "";
    display.textContent = text ? `${display.dataset.prefix || ""}${text}` : "";
  }

  for (const select of selectDisplays.keys()) {
    select.addEventListener("change", () => updateSelectDisplay(select));
  }

  function languageCodes() {
    return Object.keys(languageOptions);
  }

  function fallbackLanguage() {
    return languageOptions.en ? "en" : languageCodes()[0] || "en";
  }

  function isSupportedLanguage(language) {
    return Object.prototype.hasOwnProperty.call(languageOptions, language);
  }

  function normalizeLanguageOptions(langs) {
    if (!langs || typeof langs !== "object" || Array.isArray(langs)) return { en: "English" };
    const normalized = {};
    for (const [code, label] of Object.entries(langs)) {
      const key = String(code || "").trim();
      const value = String(label || "").trim();
      if (/^[a-z0-9-]{2,16}$/i.test(key) && value) normalized[key] = value;
    }
    return Object.keys(normalized).length ? normalized : { en: "English" };
  }

  function renderLanguageOptions() {
    const fragment = document.createDocumentFragment();
    for (const [code, label] of Object.entries(languageOptions)) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = label;
      fragment.appendChild(option);
    }
    languageSelectEl.replaceChildren(fragment);
    languageSelectEl.value = currentLanguage;
    updateSelectDisplay(languageSelectEl);
  }

  function setAvailableLanguages(langs) {
    languageOptions = normalizeLanguageOptions(langs);
    const previous = currentLanguage;
    if (!isSupportedLanguage(currentLanguage)) currentLanguage = fallbackLanguage();
    renderLanguageOptions();
    return currentLanguage !== previous;
  }

  async function loadTranslations(language) {
    const normalized = isSupportedLanguage(language) ? language : fallbackLanguage();
    const needed = new Set(["en", normalized]);
    await Promise.all([...needed].map(async code => {
      if (translations[code]) return;
      try {
        const response = await fetch(new URL("lang/" + code + ".json", location.href), { cache: "no-store" });
        if (!response.ok) throw new Error("lang/" + code + ".json " + response.status);
        translations[code] = await response.json();
      } catch (_) {
        translations[code] = {};
      }
    }));
  }

function tr(key) {
  return (translations[currentLanguage] && translations[currentLanguage][key])
    || (translations.en && translations.en[key])
    || key;
}

function setElementText(el, key) {
  if (el) el.textContent = tr(key);
}

function micDeviceLabel() {
  return tr("sourceMicInputDevice");
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
    for (const available of languageCodes()) {
      const normalized = available.toLowerCase();
      if (code === normalized || code.startsWith(normalized + "-") || normalized.startsWith(code + "-")) {
        return available;
      }
    }
  }
  return fallbackLanguage();
}

async function loadLanguage() {
  const saved = app.readStorage(app.storageKeys.language);
  const preferred = saved || preferredBrowserLanguage();
  currentLanguage = isSupportedLanguage(preferred) ? preferred : preferredBrowserLanguage();
  await loadTranslations(currentLanguage);
  renderLanguageOptions();
  languageSelectEl.value = currentLanguage;
  updateSelectDisplay(languageSelectEl);
}

function updateEncoderLabels() {
  const nativeOption = encoderModeEl.querySelector('option[value="native192"]');
  const wasm192Option = encoderModeEl.querySelector('option[value="wasm192"]');
  const wasmOption = encoderModeEl.querySelector('option[value="wasm320"]');
  if (nativeOption) nativeOption.textContent = "Native 192 kbps";
  if (wasm192Option) wasm192Option.textContent = "WASM 192 kbps";
  if (wasmOption) wasmOption.textContent = "WASM 320 kbps";
  updateNativeEncoderOption();
  updateSelectDisplay(encoderModeEl);
}

function setVideoQualities(qualities, selectedId) {
  const fragment = document.createDocumentFragment();
  for (const quality of qualities) {
    const option = document.createElement("option");
    option.value = quality.id;
    option.textContent = `${quality.width}×${quality.height} · ${quality.fps} FPS · ${quality.bitrateKbps} kbps`;
    fragment.appendChild(option);
  }
  videoQualityEl.replaceChildren(fragment);
  if (selectedId) videoQualityEl.value = selectedId;
  updateSelectDisplay(videoQualityEl);
  updateSourceControls();
}

function updateNativeEncoderOption() {
  const nativeOption = encoderModeEl.querySelector('option[value="native192"]');
  if (nativeOption) nativeOption.hidden = !app.nativeAacAvailable;
  if (!app.nativeAacAvailable && encoderModeEl.value === "native192") {
    encoderModeEl.value = "wasm192";
    app.writeStorage(app.storageKeys.encoderMode, encoderModeEl.value);
  }
  updateSelectDisplay(encoderModeEl);
}

function updateStartTitle() {
  startTitleEl.textContent = tr(app.serverVideoEnabled() ? "firstSourceTitle" : "firstSourceAudioOnlyTitle");
}

function normalizeMotdText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stableSignature(value) {
  if (value == null || typeof value !== "object") {
    const scalar = JSON.stringify(value);
    return scalar === undefined ? "null" : scalar;
  }
  if (Array.isArray(value)) return `[${value.map(stableSignature).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSignature(value[key])}`).join(",")}}`;
}

function localizedMotdText(motd) {
  if (!motd || typeof motd !== "object" || Array.isArray(motd)) return "";
  const direct = normalizeMotdText(motd[currentLanguage]);
  if (direct) return direct;
  const english = normalizeMotdText(motd.en);
  if (english) return english;
  for (const value of Object.values(motd)) {
    const text = normalizeMotdText(value);
    if (text) return text;
  }
  return "";
}

function renderMotd() {
  const text = localizedMotdText(motdPayload);
  motdEl.textContent = text;
  motdEl.hidden = !text;
}

function setMotdPayload(payload) {
  const nextPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  const nextSignature = stableSignature(nextPayload);
  if (nextSignature === motdPayloadSignature) return;
  motdPayloadSignature = nextSignature;
  motdPayload = nextPayload;
  renderMotd();
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
  return app.config.patronTiers
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
  const hasPatrons = patronTiersPayload.some(tier => tier.names.length > 0);
  patronsEl.hidden = !hasPatrons;
  if (!hasPatrons) {
    patronsEl.replaceChildren();
    return;
  }

  const header = document.createElement("div");
  header.className = "patrons-header";
  header.textContent = `${tr("patronsThankYouTitle")} <3`;
  const list = document.createElement("div");
  list.className = "patrons-list";
  const fragment = document.createDocumentFragment();

  patronTiersPayload.forEach(tier => {
    tier.names.forEach(name => {
      const item = document.createElement("span");
      item.className = `patron-name patron-${tier.className}`;
      item.textContent = name;
      list.appendChild(item);
    });
  });
  const link = document.createElement("a");
  link.className = "patrons-link";
  link.href = "https://patreon.com/vard";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "patreon.com/vard";
  fragment.append(header, list, link);
  patronsEl.replaceChildren(fragment);
}

function setPatronsPayload(payload) {
  const tiers = normalizePatronTiers(payload);
  const nextSignature = stableSignature(tiers);
  if (nextSignature === patronTiersSignature) return;
  patronTiersSignature = nextSignature;
  renderPatrons(tiers);
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage === "ja" ? "ja" : currentLanguage === "ru" ? "ru" : "en";
  updateStartTitle();
  setElementText(startTipEl, "firstSourceTip");
  setElementText(displayAudioLabelEl, "firstSourceTabWindowSystemAudio");
  tabAudioHintEl.textContent = tr("firstSourceTabAudioHint");
  setElementText(displayVideoLabelEl, "firstSourceTabWindowDisplayVideo");
  setElementText(streamToTitleEl, "streamDestinationTitle");
  customApiEl.placeholder = tr("customServerApiPlaceholder");
  customPasswordEl.placeholder = tr("customServerPasswordPlaceholder");
  setElementText(sourceCodeLinkEl, "footerSourceCodeLink");
  setElementText(reportBugLinkEl, "footerReportBugLink");
  micDeviceLabelEl.textContent = micDeviceStartLabel();
  updateMicDeviceDisplay();
  updateActiveSourceLabels();
  customConnectBtn.textContent = tr("customServerConnectButton");
  pasteHintEl.textContent = tr("streamUrlPasteHint");
  newLinkBtn.textContent = tr("streamGenerateNewLinkButton");
  stopBtn.textContent = `⏹ ${tr("streamStopButton")}`;
  updateEncoderLabels();
  if (rtspHintEl.textContent && rtspHintEl.textContent !== tr("streamUrlCopiedHint")) setRtspHint(tr("streamUrlCopyHint"));
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
  renderMotd();
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

function positionHints() {
  positionRtspHint();
  positionStreamInfoHint();
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
  return app.config.isFirefoxBased;
}

function showSystemSourceHint(kind) {
  if (systemCaptureDisabled()) {
    tabAudioHintEl.textContent = tr("firstSourceChromiumRequiredHint");
  } else if (kind === "screen") {
    tabAudioHintEl.textContent = tr("firstSourceTabAudioHint");
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
  if (!rtspHintEl.textContent) setRtspHint(tr("streamUrlCopyHint"));
  rtspHintEl.hidden = false;
  rtspHintEl.classList.add("is-visible");
  positionRtspHint();
  requestAnimationFrame(positionRtspHint);
}

function hideRtspHint() {
  rtspHintEl.classList.remove("is-visible");
}

function setServerStatsText(text) {
  serverStatsEl.textContent = text;
}

function renderServerStatus() {
  if (serverStatus.state === "online") {
    setServerStatsText(`🟢 ${tr("serverStatusOnline")} 📡${serverStatus.streams} 👥${serverStatus.listeners}`);
  } else if (serverStatus.state === "offline") {
    setServerStatsText(`🔴 ${tr("serverStatusOffline")}`);
  } else {
    setServerStatsText(`🟡 ${tr("serverStatusLoading")}`);
  }
}

function setServerStatus(state, streams = 0, listeners = 0) {
  serverStatus = { state, streams, listeners };
  renderServerStatus();
}

function updateServerDisplay() {
  updateSelectDisplay(serverSelectEl);
}

function updateCustomOption() {
  for (const option of serverSelectEl.options) {
    if (option.value === "custom") option.textContent = tr("serverSelectCustomOption");
  }
  updateServerDisplay();
}

function updateServerHint() {
  const info = app.currentServerInfo();
  const server = app.selectedServer();
  const hint = (info && info.description) || app.serverDescription(server) || "";
  serverHintEl.textContent = hint;
  serverHintEl.hidden = !hint;
}

function updateServerOption(index, server) {
  const option = serverSelectEl.options[index];
  if (!option) return;
  option.textContent = app.serverDisplayName(server);
  if (option.selected) updateServerDisplay();
}

function updateCustomVisibility() {
  const custom = serverSelectEl.value === "custom";
  const locked = Boolean(app.active);
  customServerFormEl.hidden = !custom || locked;
  customApiEl.disabled = locked || !custom;
  customPasswordEl.disabled = locked || !custom;
  customConnectBtn.disabled = locked || !custom;
  updateCustomOption();
  updateServerHint();
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
  const value = app.readJsonStorage(app.storageKeys.sourceSettings, {});
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
  app.writeJsonStorage(app.storageKeys.sourceSettings, stored);
}

function activeSourceSpecs() {
  if (!app.active) return [];
  const specs = [];
  for (const kind of ["mic", "screen", "video"]) {
    const source = app.active.sources[kind];
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
  if (kind === "mic") return tr("addSourceMicInputAudio");
  if (kind === "video") return tr("addSourceTabWindowDisplayVideo");
  return tr("addSourceTabWindowSystemAudio");
}

function sourceIconUrl(kind) {
  if (kind === "mic") return "static/mic.webp";
  if (kind === "video") return "static/video.webp";
  return "static/audio.webp";
}

function setupAddSourceButton(button, kind) {
  const icon = document.createElement("img");
  const label = document.createElement("span");
  button.className = "add-source-button";
  icon.src = sourceIconUrl(kind);
  icon.alt = "";
  label.textContent = addSourceLabel(kind);
  button.append("＋", icon, label);
}

function createAddMicSourceControl() {
  const wrap = document.createElement("span");
  const button = document.createElement("button");
  const select = document.createElement("select");
  const placeholder = document.createElement("option");
  placeholder.value = "__add_mic";
  placeholder.textContent = addSourceLabel("mic");
  wrap.className = "add-source-mic";
  button.type = "button";
  setupAddSourceButton(button, "mic");
  button.disabled = app.sourceRequestInFlight;
  select.className = "add-source-hidden-select";
  select.disabled = app.sourceRequestInFlight;
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
    if (app.sourceRequestInFlight) return;
    if (!micDeviceSelectionReady) {
      app.streamer.addOrReplaceSource("mic");
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
    if (deviceId === placeholder.value || app.sourceRequestInFlight) return;
    saveMicDeviceSelection(deviceId);
    app.streamer.addOrReplaceSource("mic", deviceId);
  };
  wrap.append(button, select);
  return wrap;
}

function renderAddSourceButtons() {
  addSourcesEl.textContent = "";
  if (!app.active) {
    stopBtn.remove();
    return;
  }

  const missing = [];
  const systemDisabled = systemCaptureDisabled();
  if (!systemDisabled && (!app.active.sources.screen || app.active.sources.video)) missing.push("screen");
  if (!app.active.sources.mic) missing.push("mic");
  if (!systemDisabled && app.serverVideoEnabled() && (!app.active.sources.video || app.active.sources.screen)) missing.push("video");

  missing.forEach(kind => {
    if (kind === "mic") {
      addSourcesEl.appendChild(createAddMicSourceControl());
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    setupAddSourceButton(button, kind);
    button.disabled = app.sourceRequestInFlight;
    button.onclick = () => app.streamer.addOrReplaceSource(kind);
    addSourcesEl.appendChild(button);
  });
  addSourcesEl.appendChild(stopBtn);
}

function updateSourceControls() {
  const streaming = Boolean(app.active);
  const videoEnabled = app.serverVideoEnabled();
  const serverReady = app.serverConnectionReady();
  const systemDisabled = systemCaptureDisabled();
  const sources = app.active && app.active.sources;
  const hasAudioSource = Boolean(sources && (sources.mic || sources.screen || sources.video?.hasAudio));
  micBtn.disabled = app.sourceRequestInFlight || !serverReady;
  displayAudioBtn.disabled = app.sourceRequestInFlight || !serverReady;
  videoChoiceEl.hidden = !videoEnabled;
  displayVideoBtn.disabled = app.sourceRequestInFlight || !videoEnabled || !serverReady;
  displayAudioBtn.classList.toggle("is-browser-disabled", systemDisabled);
  displayVideoBtn.classList.toggle("is-browser-disabled", systemDisabled);
  displayAudioBtn.setAttribute("aria-disabled", String(systemDisabled));
  displayVideoBtn.setAttribute("aria-disabled", String(systemDisabled));
  micDeviceEl.disabled = app.sourceRequestInFlight || !micDeviceSelectionReady || !serverReady;
  encoderModeWrapEl.hidden = !streaming || !hasAudioSource;
  videoQualityWrapEl.hidden = !streaming
    || !videoEnabled
    || !app.active.sources.video
    || videoQualityEl.options.length === 0;
  newLinkBtn.disabled = app.linkRestartInFlight;
  stopBtn.disabled = !streaming;
  updateStartTitle();
  renderAddSourceButtons();
}

function setMicDeviceSelectionReady(ready) {
  micDeviceSelectionReady = ready;
  micDeviceWrapEl.hidden = !ready;
  micDeviceLabelEl.hidden = ready;
  updateMicDeviceDisplay();
}

function setSourceRequestBusy(busy) {
  app.sourceRequestInFlight = busy;
  updateSourceControls();
}

function savedMicDeviceId() {
  return app.readStorage(app.storageKeys.micDevice);
}

function saveMicDeviceSelection(value = micDeviceEl.value) {
  micDeviceEl.value = value || "";
  app.writeStorage(app.storageKeys.micDevice, micDeviceEl.value);
  updateMicDeviceDisplay();
}

function updateMicDeviceDisplay() {
  updateSelectDisplay(micDeviceEl);
  if (!micDeviceSelectedLabelEl.textContent) micDeviceSelectedLabelEl.textContent = micDeviceLabel();
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

  let hasPreferred = !preferredId;
  inputs.forEach((device, index) => {
    if (!device.deviceId) return;
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `${micDeviceLabel()} ${index + 1}`;
    micDeviceEl.appendChild(option);
    if (device.deviceId === preferredId) hasPreferred = true;
  });

  if (preferredId && !hasPreferred) {
    const savedOption = document.createElement("option");
    savedOption.value = preferredId;
    savedOption.textContent = micDeviceLabel();
    micDeviceEl.appendChild(savedOption);
    hasPreferred = true;
  }
  if (hasPreferred) micDeviceEl.value = preferredId || "";
  updateMicDeviceDisplay();
  updateSourceControls();
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
  newLinkBtn.disabled = app.linkRestartInFlight;
  serverSelectEl.disabled = false;
  updateCustomVisibility();
  updateSourceControls();
}

function videoFpsLabel(value) {
  return Number.isFinite(value) && value > 0 ? value.toFixed(1) : "-";
}

function statsSection(title, lines) {
  return `[${title}]\n${lines.join("\n")}`;
}

function audioStatsSection(info) {
  const lines = [`Encoder: ${info.name}`];
  if (info.detail) lines.push(`Configuration: ${info.detail}`);
  if (Number.isFinite(info.encodedKbps)) {
    lines.push(`Bitrate: ${info.encodedKbps.toFixed(0)} kbps`);
  }
  if ("encodedFrames" in info) {
    lines.push(
      `Frame rate: ${info.encodedFps.toFixed(1)} / ${app.config.expectedEncodedFpsLabel} FPS`,
      `Encoder queue: ${info.queue} frames`,
      `Encoded frames: ${info.encodedFrames}`
    );
  }
  if (info.fallbackReason) lines.push(`Native fallback: ${info.fallbackReason}`);
  return statsSection("AUDIO", lines);
}

function videoStatsSection(video) {
  const pipeline = video.mode === "processor" ? "MediaStreamTrackProcessor" : video.mode || "Worker";
  return statsSection("VIDEO", [
    "Codec: H.264",
    `Output: ${app.config.videoWidth}×${app.config.videoHeight} @ ${app.config.videoFps} FPS`,
    `Capture pipeline: ${pipeline}`,
    `Bitrate: ${video.kbps.toFixed(0)} kbps`,
    `Frame rate: ${videoFpsLabel(video.fps)} / ${app.config.videoFps.toFixed(1)} FPS`,
    `Captured frame rate: ${videoFpsLabel(video.captureFps)} FPS`,
    `Track-reported frame rate: ${videoFpsLabel(video.trackFps)} FPS`,
    `Encoder queue: ${video.queue} frames`,
    `Dropped frames: ${video.dropped}`
  ]);
}

function streamHintText(info, video = null) {
  const browserState = document.hidden
    ? "Hidden/minimized; encoding may be throttled"
    : "Visible";
  const general = statsSection("GENERAL", [
    `Browser tab: ${browserState}`,
    `WebSocket queue: ${(app.active.ws.bufferedAmount / 1024).toFixed(0)} KB`
  ]);
  const sections = [general, audioStatsSection(info)];
  if (video) sections.push(videoStatsSection(video));
  return sections.join("\n\n");
}

function renderStreamInfo(kbps, listeners) {
  streamInfoEl.textContent = `${kbps} kbps 👥${listeners}`;
}

function updateStreamStatus(info) {
  if (!app.active) return;
  const current = info || app.active.encoder.stats();
  const audioKbps = Number.isFinite(current.encodedKbps)
    ? Math.round(current.encodedKbps)
    : Math.round(app.selectedEncoderMode().bitrate / 1000);
  const video = app.active.video ? app.active.video.stats() : null;
  const videoKbps = video && Number.isFinite(video.kbps) ? Math.round(video.kbps) : 0;
  const kbps = audioKbps + videoKbps;
  renderStreamInfo(kbps, app.active.streamListeners);
  setStreamInfoHint(streamHintText(current, video));
}

function fallbackSourceName(kind) {
  if (kind === "mic") return tr("sourceMicInputDevice");
  if (kind === "video") return tr("sourceCardTabWindowDisplayVideoTitle");
  return tr("sourceCardTabWindowSystemAudioTitle");
}

function sourceDisplayName(kind, mediaStream) {
  if (kind === "video") {
    return mediaStream.getAudioTracks().length > 0
      ? tr("sourceCardTabWindowDisplayVideoAudioTitle")
      : tr("sourceCardTabWindowDisplayVideoTitle");
  }
  if (kind === "screen") return tr("sourceCardTabWindowSystemAudioTitle");
  const track = mediaStream.getAudioTracks()[0];
  const label = track?.label?.trim() || "";
  return label
    ? label.replace(/^Mic\s*\/\s*Input Device\s*:?\s*/i, "") || fallbackSourceName(kind)
    : fallbackSourceName(kind);
}

function localizedSourceName(source) {
  if (!source) return "";
  if (source.kind === "screen") return tr("sourceCardTabWindowSystemAudioTitle");
  if (source.kind === "video") {
    return source.hasAudio
      ? tr("sourceCardTabWindowDisplayVideoAudioTitle")
      : tr("sourceCardTabWindowDisplayVideoTitle");
  }
  return source.name;
}

function updateSourceLabel(source) {
  if (!source) return;
  const name = localizedSourceName(source);
  if (name && name !== source.name) {
    source.name = name;
  }
  if (source.controlEl && source.kind !== "mic") source.controlEl.textContent = `▾ ${source.name}`;
}

function updateActiveSourceLabels() {
  if (!app.active) return;
  updateSourceLabel(app.active.sources.screen);
  updateSourceLabel(app.active.sources.video);
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
  const wrap = document.createElement("span");
  const display = document.createElement("span");
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
  wrap.className = "text-select source-control";
  display.className = "text-select-display";
  display.textContent = source.name;
  display.setAttribute("aria-hidden", "true");
  wrap.append(display, select);
  return { wrap, display, select };
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
  const micControl = source.kind === "mic" ? createMicSourceSelect(source) : null;
  const sourceControl = micControl ? micControl.select : document.createElement("button");
  const sourceControlHost = micControl ? micControl.wrap : sourceControl;
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
  block.dataset.sourceKind = source.kind;
  block.style.setProperty("--source-level", "0%");
  iconWrap.type = "button";
  iconWrap.className = "source-icon";
  iconWrap.setAttribute("aria-label", source.kind === "video" ? tr("sourceVideoHideMuteHint") : hasAudioControls ? "Toggle mute" : source.name);
  body.className = "source-body";
  head.className = "source-head";
  if (settings) settings.className = "source-settings";
  icon.className = "source-icon-img";
  icon.setAttribute("aria-hidden", "true");
  iconHint.className = "source-icon-hint";
  iconHint.dataset.i18n = source.kind === "video" ? "sourceVideoHideMuteHint" : "sourceMuteHint";
  iconHint.textContent = tr(iconHint.dataset.i18n);
  const iconMask = `url("${sourceIconUrl(source.kind)}") center / contain no-repeat`;
  icon.style.setProperty("-webkit-mask", iconMask);
  icon.style.mask = iconMask;
  if (!micControl) sourceControl.className = "source-control";

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
  head.append(sourceControlHost, remove);
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
      monoText.dataset.i18n = "sourceMonoToggle";
      monoText.textContent = tr("sourceMonoToggle");
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
  source.controlDisplayEl = micControl ? micControl.display : null;
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
      app.streamer.toggleVideoSourceHidden(source);
      return;
    }
    if (!hasAudioControls) return;
    source.muteEl.checked = !source.muteEl.checked;
    app.streamer.applyAudioSourceSettings(source);
    updateStreamStatus();
  };

  if (source.kind === "mic") {
    sourceControl.onchange = () => {
      updateSelectDisplay(sourceControl, source.controlDisplayEl);
      const deviceId = source.deviceEl.value;
      saveMicDeviceSelection(deviceId);
      app.streamer.addOrReplaceSource(source.kind, deviceId, sourceSettings(source));
    };
  } else if (source.kind === "video") {
    sourceControl.onclick = () => app.streamer.addOrReplaceSource("video", null, sourceSettings(source));
  } else {
    sourceControl.onclick = () => app.streamer.addOrReplaceSource(source.kind, null, sourceSettings(source));
  }
  if (hasAudioControls) {
    gain.addEventListener("input", () => {
      app.streamer.applyAudioSourceSettings(source);
      updateStreamStatus();
    });
    gain.addEventListener("change", () => {
      saveSourceSettings(source);
    });
    mute.addEventListener("change", () => {
      app.streamer.applyAudioSourceSettings(source);
      updateStreamStatus();
    });
    if (hasMonoControl) {
      mono.addEventListener("change", () => {
        app.streamer.applyAudioSourceSettings(source);
        saveSourceSettings(source);
        updateStreamStatus();
      });
    }
  }
  remove.onclick = () => {
    if (source.kind === "video") app.streamer.removeVideoSource(source);
    else app.streamer.removeAudioSource(source.kind, source);
  };

  return block;
}

  function setNativeAacAvailable(value) {
    app.nativeAacAvailable = Boolean(value);
    updateNativeEncoderOption();
  }

  function resetCopiedHint() {
    clearTimeout(rtspHintResetTimer);
    rtspHintResetTimer = setTimeout(() => setRtspHint(tr("streamUrlCopyHint")), 900);
  }

  const api = {
    els: {
      serverSelectEl, customServerFormEl, customApiEl, customPasswordEl, rtspUrlEl,
      encoderModeEl, videoQualityEl, micDeviceEl, sourcesEl, streamInfoWrapEl,
      newLinkBtn, micBtn, displayAudioBtn, displayVideoBtn, stopBtn, languageSelectEl
    },
    tr,
    setAvailableLanguages,
    loadLanguage,
    applyLanguage,
    currentLanguage: () => currentLanguage,
    setLanguage(language) {
      currentLanguage = isSupportedLanguage(language) ? language : fallbackLanguage();
      languageSelectEl.value = currentLanguage;
      updateSelectDisplay(languageSelectEl);
      app.writeStorage(app.storageKeys.language, currentLanguage);
    },
    loadTranslations,
    setNativeAacAvailable,
    setVideoQualities,
    setMotdPayload,
    setPatronsPayload,
    positionHints,
    showRtspHint,
    hideRtspHint,
    showStreamInfoHint,
    hideStreamInfoHint,
    setRtspHint,
    resetCopiedHint,
    setServerStatus,
    updateCustomOption,
    updateServerHint,
    updateServerOption,
    updateCustomVisibility,
    setStreamingControls,
    updateSourceControls,
    setSourceRequestBusy,
    setRtspUrl,
    fitRtspUrlText,
    showSystemSourceHint,
    hideSystemSourceHint,
    refreshMicDevices,
    systemCaptureDisabled,
    savedMicDeviceId,
    saveMicDeviceSelection,
    updateSelectDisplay,
    normalizeRuntimeSourceSettings,
    loadSourceSettings,
    saveSourceSettings,
    sourceGain,
    updateGainValue,
    updateSourceLevel,
    updateMuteState,
    createSourceBlock,
    updateSourceVideoPreview,
    sourceDisplayName,
    activeSourceSpecs,
    updateStreamStatus
  };
  return api;
}
