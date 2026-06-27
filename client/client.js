const serverSelectEl = document.getElementById("serverSelect");
const serverDescriptionEl = document.getElementById("serverDescription");
const customServerEl = document.getElementById("customServer");
const customApiEl = document.getElementById("customApi");
const customRtspEl = document.getElementById("customRtsp");
const customPasswordEl = document.getElementById("customPassword");
const rtspUrlEl = document.getElementById("rtspUrl");
const encoderModeEl = document.getElementById("encoderMode");
const micDeviceEl = document.getElementById("micDevice");
const sourcesEl = document.getElementById("sources");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const copyUrlBtn = document.getElementById("copyUrl");
const newLinkBtn = document.getElementById("newLink");
const micBtn = document.getElementById("mic");
const screenBtn = document.getElementById("screen");
const stopBtn = document.getElementById("stop");
const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~";
const codeStorageKey = "vrc-audio-streamer-code";
const serverStorageKey = "vrc-audio-streamer-server";
const customApiStorageKey = "vrc-audio-streamer-custom-api";
const customRtspStorageKey = "vrc-audio-streamer-custom-rtsp";
const customPasswordStorageKey = "vrc-audio-streamer-custom-password";
const encoderModeStorageKey = "vrc-audio-streamer-encoder-mode";
const micDeviceStorageKey = "vrc-audio-streamer-mic-device";
const sampleRate = 48000;
const channels = 2;
const framesPerChunk = 1024;
const bitrate = 320000;
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
let servers = fallbackServers;
let serverInfo = null;
let sourceRequestInFlight = false;

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

function setStatus(text) {
  statusEl.textContent = text;
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
  try {
    const saved = localStorage.getItem(codeStorageKey);
    if (validStoredCode(saved)) return saved;
  } catch (_) {}
  return rotateCode();
}

function saveCode(code) {
  streamCode = code;
  try { localStorage.setItem(codeStorageKey, code); } catch (_) {}
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

function serverDisplayName(server) {
  return server.name || hostLabel(server.apiBase);
}

async function loadServers() {
  try {
    const response = await fetch(new URL("servers.json", location.href), { cache: "no-store" });
    if (!response.ok) throw new Error(`servers.json ${response.status}`);
    const loaded = await response.json();
    if (!Array.isArray(loaded)) throw new Error("servers.json must be an array");
    const normalized = loaded.map(normalizeServerEntry).filter(Boolean);
    if (normalized.length > 0) servers = normalized;
  } catch (_) {
    servers = fallbackServers;
  }
}

function renderServers() {
  serverSelectEl.textContent = "";
  servers.forEach((server, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = serverDisplayName(server);
    serverSelectEl.appendChild(option);
  });

  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = "Custom";
  serverSelectEl.appendChild(customOption);

  let saved = "0";
  try { saved = localStorage.getItem(serverStorageKey) || "0"; } catch (_) {}
  if (saved !== "custom" && (!/^\d+$/.test(saved) || Number(saved) >= servers.length)) saved = "0";
  serverSelectEl.value = saved;

  try {
    customApiEl.value = localStorage.getItem(customApiStorageKey) || "http://127.0.0.1:8081";
    customRtspEl.value = localStorage.getItem(customRtspStorageKey) || "rtsp://127.0.0.1";
    customPasswordEl.value = localStorage.getItem(customPasswordStorageKey) || "";
  } catch (_) {
    customApiEl.value = "http://127.0.0.1:8081";
    customRtspEl.value = "rtsp://127.0.0.1";
    customPasswordEl.value = "";
  }
  updateCustomVisibility();
}

function loadEncoderMode() {
  let saved = "native192";
  try { saved = localStorage.getItem(encoderModeStorageKey) || saved; } catch (_) {}
  if (!encoderModes[saved]) saved = "native192";
  encoderModeEl.value = saved;
}

function selectedEncoderMode() {
  return encoderModes[encoderModeEl.value] || encoderModes.native192;
}

function updateCustomVisibility() {
  const custom = serverSelectEl.value === "custom";
  customServerEl.hidden = !custom;
  customApiEl.disabled = Boolean(active) || !custom;
  customRtspEl.disabled = Boolean(active) || !custom;
  customPasswordEl.disabled = Boolean(active) || !custom;
  const info = currentServerInfo();
  if (info && (info.name || info.description)) {
    serverDescriptionEl.textContent = [info.name, info.description].filter(Boolean).join(" - ");
  } else {
    serverDescriptionEl.textContent = custom ? "Use your own API and RTSP server addresses." : selectedServer().description || "";
  }
}

function selectedServer() {
  if (serverSelectEl.value === "custom") {
    return {
      name: "Custom",
      description: "Use your own API and RTSP server addresses.",
      apiBase: customApiEl.value,
      rtspBase: customRtspEl.value,
      password: customPasswordEl.value
    };
  }
  return servers[Number(serverSelectEl.value)] || servers[0] || fallbackServers[0];
}

function currentServerKey() {
  const server = selectedServer();
  const apiDefault = location.protocol === "https:" ? "https://" : "http://";
  return `${normalizeBase(server.apiBase, apiDefault)}|${normalizeBase(server.rtspBase, "rtsp://")}`;
}

function currentServerInfo() {
  return serverInfo && serverInfo.key === currentServerKey() ? serverInfo : null;
}

function applyServerInfo(info) {
  if (!info || typeof info !== "object") return;

  const name = typeof info.name === "string" ? info.name.trim() : "";
  const description = typeof info.description === "string" ? info.description.trim() : "";
  serverInfo = { key: currentServerKey(), name, description, video: Boolean(info.video) };

  if (serverSelectEl.value !== "custom") {
    const index = Number(serverSelectEl.value);
    const server = servers[index];
    if (server) {
      if (name) server.name = name;
      server.description = description;
      const option = serverSelectEl.options[index];
      if (option) option.textContent = serverDisplayName(server);
    }
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

function setRtspUrl(value) {
  rtspUrlEl.value = value;
  copyUrlBtn.disabled = !value;
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

function updateSourceControls() {
  const streaming = Boolean(active);
  micBtn.disabled = sourceRequestInFlight;
  screenBtn.disabled = sourceRequestInFlight;
  micDeviceEl.disabled = sourceRequestInFlight;
  stopBtn.disabled = !streaming;
  micBtn.textContent = streaming
    ? (hasSource(active, "mic") ? "Change mic" : "Add mic")
    : "Add mic";
  screenBtn.textContent = streaming
    ? (hasSource(active, "screen") ? "Change tab/system audio" : "Add tab/system audio")
    : "Add tab/system audio";
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
  try { return localStorage.getItem(micDeviceStorageKey) || ""; } catch (_) {}
  return "";
}

async function refreshMicDevices(preferredId = micDeviceEl.value || savedMicDeviceId()) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(device => device.kind === "audioinput");
  micDeviceEl.textContent = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Default microphone";
  micDeviceEl.appendChild(defaultOption);

  inputs.forEach((device, index) => {
    if (!device.deviceId) return;
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    micDeviceEl.appendChild(option);
  });

  if (preferredId && ![...micDeviceEl.options].some(option => option.value === preferredId)) {
    const savedOption = document.createElement("option");
    savedOption.value = preferredId;
    savedOption.textContent = "Saved microphone";
    micDeviceEl.appendChild(savedOption);
  }
  if ([...micDeviceEl.options].some(option => option.value === preferredId)) {
    micDeviceEl.value = preferredId;
  }
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
    setStats(`Listeners: ${stats.active_listeners} Streams: ${stats.active_streams}`);
  } catch (_) {
    setStats("Listeners: - Streams: -");
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

async function captureAudio(kind) {
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
  const deviceId = micDeviceEl.value;
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
      return true;
    }
    const rightIn = input[1] || leftIn;
    const gain = this.gain;

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
  let line = `Streaming ${info.name}`;
  if (info.detail) line += ` (${info.detail})`;
  line += ".";
  if (info.fallbackReason) line += `\nNative AAC fallback: ${info.fallbackReason}`;
  return line;
}

function setStreamingControls(streaming) {
  stopBtn.disabled = !streaming;
  newLinkBtn.disabled = streaming;
  serverSelectEl.disabled = streaming;
  encoderModeEl.disabled = streaming;
  updateCustomVisibility();
  updateSourceControls();
}

function streamStatusText(info) {
  if (!active) return encoderStatusLine(info);

  let text = `${encoderStatusLine(info)}${browserThrottleWarning()}\nListeners: ${active.streamListeners}\nSources: ${sourceSummary(active)}`;
  if ("encodedFrames" in info) {
    text += `\nEncoded AAC frames: ${info.encodedFrames}\nEncoded fps: ${info.encodedFps.toFixed(1)} / 46.9\nAAC kbps: ${info.encodedKbps.toFixed(0)}\nEncoder queue: ${info.queue}`;
  }
  return text;
}

function updateStreamStatus(info) {
  if (active) setStatus(streamStatusText(info || active.encoder.stats()));
}

function stopMediaStream(mediaStream) {
  if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
}

function sourceBaseName(kind) {
  return kind === "mic" ? "Mic" : "Tab/system audio";
}

function sourceDisplayName(kind, mediaStream) {
  const label = mediaStream.getAudioTracks()[0]?.label?.trim() || "";
  return label ? `${sourceBaseName(kind)}: ${label}` : sourceBaseName(kind);
}

function sourceGain(source) {
  const value = Number(source.gainEl.value);
  if (!Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(0, value));
}

function applyAudioSourceSettings(source) {
  source.processor.port.postMessage({
    type: "settings",
    gain: sourceGain(source),
    mute: source.muteEl.checked,
    forceMono: source.monoEl.checked
  });
}

function createSourceBlock(source) {
  const block = document.createElement("div");
  const title = document.createElement("strong");
  const gainLabel = document.createElement("label");
  const gain = document.createElement("input");
  const muteLabel = document.createElement("label");
  const mute = document.createElement("input");
  const monoLabel = document.createElement("label");
  const mono = document.createElement("input");
  const stop = document.createElement("button");

  title.textContent = source.name;

  gain.type = "number";
  gain.min = "0";
  gain.max = "4";
  gain.step = "0.05";
  gain.value = "1";
  gainLabel.append(" Gain ", gain);

  mute.type = "checkbox";
  muteLabel.append(" ", mute, " Mute");

  mono.type = "checkbox";
  monoLabel.append(" ", mono, " Force Mono");

  stop.type = "button";
  stop.textContent = "Stop";

  block.append(title, gainLabel, muteLabel, monoLabel, " ", stop);

  source.block = block;
  source.gainEl = gain;
  source.muteEl = mute;
  source.monoEl = mono;
  source.stopBtn = stop;

  gain.addEventListener("input", () => {
    applyAudioSourceSettings(source);
    updateStreamStatus();
  });
  mute.addEventListener("change", () => {
    applyAudioSourceSettings(source);
    updateStreamStatus();
  });
  mono.addEventListener("change", () => {
    applyAudioSourceSettings(source);
    updateStreamStatus();
  });
  stop.onclick = () => removeAudioSource(source.kind, source);

  return block;
}

function disposeAudioSource(source) {
  if (!source) return;
  try { source.node.disconnect(); } catch (_) {}
  try { source.processor.disconnect(); } catch (_) {}
  try { source.processor.port.close(); } catch (_) {}
  if (source.block) source.block.remove();
  stopMediaStream(source.mediaStream);
}

function removeAudioSource(kind, source) {
  if (!active || active.sources[kind] !== source) return;
  active.sources[kind] = null;
  disposeAudioSource(source);
  updateSourceControls();
  updateStreamStatus();
}

function installAudioSource(kind, mediaStream) {
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
    mediaStream,
    node,
    processor
  };
  createSourceBlock(next);
  applyAudioSourceSettings(next);

  const previous = active.sources[kind];
  active.sources[kind] = next;
  if (previous) disposeAudioSource(previous);

  node.connect(processor);
  processor.connect(active.mixer);
  sourcesEl.appendChild(next.block);

  mediaStream.getAudioTracks().forEach(track => {
    track.addEventListener("ended", () => removeAudioSource(kind, next), { once: true });
  });

  updateSourceControls();
  updateStreamStatus();
}

async function requestAudioSource(kind) {
  setStatus(kind === "screen"
    ? "Choose a screen/tab and enable audio sharing in the browser prompt..."
    : "Allow microphone access in the browser prompt...");
  const mediaStream = await withTimeout(
    captureAudio(kind),
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

async function addOrReplaceSource(kind) {
  if (!active || sourceRequestInFlight) return;

  let mediaStream = null;
  setSourceRequestBusy(true);
  try {
    mediaStream = await requestAudioSource(kind);
    if (!active) {
      stopMediaStream(mediaStream);
      return;
    }
    installAudioSource(kind, mediaStream);
    mediaStream = null;
    updateStreamStatus();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    stopMediaStream(mediaStream);
    setSourceRequestBusy(false);
  }
}

async function start(kind) {
  if (active) {
    await addOrReplaceSource(kind);
    return;
  }
  if (sourceRequestInFlight) return;

  const code = streamCode;
  if (code.length < 8) {
    setStatus("Stream code is not ready.");
    return;
  }

  let mediaStream = null;
  let audioContext = null;
  let ws = null;
  let encoder = null;
  let pendingStreamListeners = 0;
  setSourceRequestBusy(true);
  try {
    mediaStream = await requestAudioSource(kind);

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

    installAudioSource(kind, mediaStream);
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

    setStatus(streamStatusText(encoderInfo));
    active.statusTimer = setInterval(() => {
      if (!active || active.ws !== ws) return;
      setStatus(streamStatusText(encoder.stats()));
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

function cleanup() {
  const current = active;
  active = null;
  setStreamingControls(false);
  if (!current) return;

  if (current.statusTimer) clearInterval(current.statusTimer);
  try { current.captureNode.disconnect(); } catch (_) {}
  try { current.mixer.disconnect(); } catch (_) {}
  try { current.monitor.disconnect(); } catch (_) {}
  disposeAudioSource(current.sources.mic);
  disposeAudioSource(current.sources.screen);
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

  copyUrlBtn.textContent = "Copied";
  setTimeout(() => {
    copyUrlBtn.textContent = "Copy";
  }, 800);
}

copyUrlBtn.onclick = copyUrl;
newLinkBtn.onclick = () => {
  rotateCode();
  updateUrl();
};
micBtn.onclick = () => start("mic");
screenBtn.onclick = () => start("screen");
stopBtn.onclick = stop;
micDeviceEl.onchange = () => {
  try { localStorage.setItem(micDeviceStorageKey, micDeviceEl.value); } catch (_) {}
  if (active) addOrReplaceSource("mic");
};
serverSelectEl.onchange = () => {
  try { localStorage.setItem(serverStorageKey, serverSelectEl.value); } catch (_) {}
  updateCustomVisibility();
  updateUrl();
  refreshStats();
};
encoderModeEl.onchange = () => {
  try { localStorage.setItem(encoderModeStorageKey, encoderModeEl.value); } catch (_) {}
};
customApiEl.addEventListener("input", () => {
  try { localStorage.setItem(customApiStorageKey, customApiEl.value); } catch (_) {}
  refreshStats();
});
customRtspEl.addEventListener("input", () => {
  try { localStorage.setItem(customRtspStorageKey, customRtspEl.value); } catch (_) {}
  updateUrl();
});
customPasswordEl.addEventListener("input", () => {
  try { localStorage.setItem(customPasswordStorageKey, customPasswordEl.value); } catch (_) {}
});
document.addEventListener("visibilitychange", refreshScreenWakeLock);
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    refreshMicDevices().catch(() => {});
  });
}

async function init() {
  streamCode = loadCode();
  await loadServers();
  renderServers();
  loadEncoderMode();
  try { await refreshMicDevices(savedMicDeviceId()); } catch (_) {}
  updateSourceControls();
  updateUrl();
  refreshStats();
  setInterval(refreshStats, statsRefreshMs);
}

init().catch(error => setStatus(error.message || String(error)));
