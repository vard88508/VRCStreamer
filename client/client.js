const serverSelectEl = document.getElementById("serverSelect");
const customServerEl = document.getElementById("customServer");
const customApiEl = document.getElementById("customApi");
const customRtspEl = document.getElementById("customRtsp");
const rtspUrlEl = document.getElementById("rtspUrl");
const encoderModeEl = document.getElementById("encoderMode");
const gainEl = document.getElementById("gain");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const newLinkBtn = document.getElementById("newLink");
const micBtn = document.getElementById("mic");
const screenBtn = document.getElementById("screen");
const stopBtn = document.getElementById("stop");
const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~";
const codeStorageKey = "vrc-audio-streamer-code";
const serverStorageKey = "vrc-audio-streamer-server";
const customApiStorageKey = "vrc-audio-streamer-custom-api";
const customRtspStorageKey = "vrc-audio-streamer-custom-rtsp";
const encoderModeStorageKey = "vrc-audio-streamer-encoder-mode";
const sampleRate = 48000;
const channels = 2;
const framesPerChunk = 1024;
const bitrate = 320000;
const native192Bitrates = [192000];
const expectedAacConfigHex = "1190";
const monitorOutputGain = 0.0001;
const fallbackServers = [
  { name: "Local 554", apiBase: "http://127.0.0.1:8081", rtspBase: "rtsp://127.0.0.1" },
  { name: "Local 8554", apiBase: "http://127.0.0.1:8081", rtspBase: "rtsp://127.0.0.1:8554" }
];

let urlSeq = 0;
let active = null;
let streamCode = "";
let servers = fallbackServers;

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

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeServerEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const apiBase = entry.apiBase || entry.api || entry.http || "";
  const rtspBase = entry.rtspBase || entry.rtsp || entry.media || "";
  if (typeof apiBase !== "string" || typeof rtspBase !== "string") return null;
  if (!apiBase.trim() || !rtspBase.trim()) return null;
  return {
    name: String(entry.name || entry.label || apiBase).trim(),
    apiBase: apiBase.trim(),
    rtspBase: rtspBase.trim()
  };
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
    option.textContent = server.name;
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
  } catch (_) {
    customApiEl.value = "http://127.0.0.1:8081";
    customRtspEl.value = "rtsp://127.0.0.1";
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
}

function selectedServer() {
  if (serverSelectEl.value === "custom") {
    return {
      name: "Custom",
      apiBase: customApiEl.value,
      rtspBase: customRtspEl.value
    };
  }
  return servers[Number(serverSelectEl.value)] || servers[0] || fallbackServers[0];
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
  return `${base}/live/${hash}`;
}

async function updateUrl() {
  const seq = ++urlSeq;
  const code = streamCode;
  if (!code) {
    rtspUrlEl.value = "";
    return;
  }
  const hash = await sha256Hex(code);
  if (seq !== urlSeq) return;
  rtspUrlEl.value = mediaUrl(hash);
}

function currentGain() {
  const value = Number(gainEl.value);
  if (!Number.isFinite(value)) return 1.5;
  return Math.min(4, Math.max(0.25, value));
}

function applyCaptureGain(node) {
  node.port.postMessage({ type: "gain", gain: currentGain() });
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

function wsUrlForCode(code) {
  const url = apiUrl(`ingest?code=${encodeURIComponent(code)}`);
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
    setStats(`Streamers: ${stats.active_publishers} Listeners: ${stats.active_listeners} Streams: ${stats.active_streams}`);
  } catch (_) {
    setStats("Streamers: - Listeners: - Streams: -");
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
  return await navigator.mediaDevices.getUserMedia({ video: false, audio });
}

function captureProcessorSource() {
  return `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = ${framesPerChunk};
    this.channels = ${channels};
    this.pcm = new Float32Array(this.frames * this.channels);
    this.offset = 0;
    this.gain = 1.5;
    this.port.onmessage = event => {
      if (event.data && event.data.type === "gain") {
        const gain = Number(event.data.gain);
        this.gain = Number.isFinite(gain) ? Math.min(4, Math.max(0.25, gain)) : 1.5;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const monitorOut = output && output[0] ? output[0] : null;

    const input = inputs[0];
    const leftIn = input && input[0] ? input[0] : null;
    if (!leftIn) return true;
    const rightIn = input[1] || leftIn;

    let sourceOffset = 0;
    while (sourceOffset < leftIn.length) {
      const take = Math.min(this.frames - this.offset, leftIn.length - sourceOffset);
      const gain = this.gain;
      for (let i = 0; i < take; i++) {
        const dst = (this.offset + i) * this.channels;
        const src = sourceOffset + i;
        let left = leftIn[src] * gain;
        let right = rightIn[src] * gain;
        if (left > 1) left = 1;
        else if (left < -1) left = -1;
        if (right > 1) right = 1;
        else if (right < -1) right = -1;
        this.pcm[dst] = left;
        this.pcm[dst + 1] = right;
        if (monitorOut) monitorOut[src] = (leftIn[src] + rightIn[src]) * 0.5;
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
  micBtn.disabled = streaming;
  screenBtn.disabled = streaming;
  stopBtn.disabled = !streaming;
  newLinkBtn.disabled = streaming;
  serverSelectEl.disabled = streaming;
  encoderModeEl.disabled = streaming;
  updateCustomVisibility();
}

async function start(kind) {
  if (active) stop();

  const code = streamCode;
  if (code.length < 8) {
    setStatus("Stream code is not ready.");
    return;
  }

  let mediaStream = null;
  let audioContext = null;
  let ws = null;
  let encoder = null;
  try {
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

    setStatus(kind === "screen"
      ? "Choose a screen/tab and enable audio sharing in the browser prompt..."
      : "Allow microphone access in the browser prompt...");
    mediaStream = await withTimeout(
      captureAudio(kind),
      45000,
      "Timed out waiting for browser audio permission/selection."
    );
    if (mediaStream.getAudioTracks().length === 0) throw new Error("No audio track selected");
    const encoderInfo = await encoderReady;
    if (encoderReadyError) throw encoderReadyError;

    setStatus("Connecting to relay server...");
    ws = new WebSocket(wsUrlForCode(code));
    ws.binaryType = "arraybuffer";
    await waitForOpen(ws);

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: "interactive", sampleRate });
    if (audioContext.sampleRate !== sampleRate) {
      throw new Error(`AudioContext returned ${audioContext.sampleRate} Hz, expected ${sampleRate} Hz.`);
    }

    const source = audioContext.createMediaStreamSource(mediaStream);
    const captureNode = await createCaptureNode(audioContext, buffer => {
      if (!active || active.encoder !== encoder) return;
      if (encoder.lagFrames() > 128) {
        failActive("AAC encoder queue is too slow; stopped.");
        return;
      }
      encoder.encode(buffer);
    });
    applyCaptureGain(captureNode);
    const monitor = audioContext.createGain();
    monitor.gain.value = monitorOutputGain;
    const wakeLock = await requestScreenWakeLock();
    setMediaSessionPlaying(true);

    active = {
      mediaStream,
      audioContext,
      ws,
      encoder,
      source,
      captureNode,
      monitor,
      wakeLock,
      statusTimer: null
    };

    source.connect(captureNode);
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

    const vrcUrl = rtspUrlEl.value;
    setStatus(`${encoderStatusLine(encoderInfo)}${browserThrottleWarning()}\nUse in VRChat: ${vrcUrl}`);
    active.statusTimer = setInterval(() => {
      if (!active || active.ws !== ws) return;
      const stats = encoder.stats();
      setStatus(`${encoderStatusLine(stats)}${browserThrottleWarning()}\nGain: ${currentGain().toFixed(2)}x\nEncoded AAC frames: ${stats.encodedFrames}\nEncoded fps: ${stats.encodedFps.toFixed(1)} / 46.9\nAAC kbps: ${stats.encodedKbps.toFixed(0)}\nEncoder queue: ${stats.queue}\nUse in VRChat: ${vrcUrl}`);
    }, 1000);
  } catch (error) {
    if (encoder) encoder.close();
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1011, "start failed");
    if (audioContext) {
      try { audioContext.close(); } catch (_) {}
    }
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
    cleanup();
    setStatus(error.message || String(error));
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
  try { current.source.disconnect(); } catch (_) {}
  try { current.monitor.disconnect(); } catch (_) {}
  current.mediaStream.getTracks().forEach(track => track.stop());
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

newLinkBtn.onclick = () => {
  rotateCode();
  updateUrl();
};
micBtn.onclick = () => start("mic");
screenBtn.onclick = () => start("screen");
stopBtn.onclick = stop;
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
gainEl.addEventListener("input", () => {
  if (active) applyCaptureGain(active.captureNode);
});
document.addEventListener("visibilitychange", refreshScreenWakeLock);

async function init() {
  streamCode = loadCode();
  await loadServers();
  renderServers();
  loadEncoderMode();
  updateUrl();
  refreshStats();
  setInterval(refreshStats, 2000);
}

init().catch(error => setStatus(error.message || String(error)));
