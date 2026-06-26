const serverSelectEl = document.getElementById("serverSelect");
const customServerEl = document.getElementById("customServer");
const customApiEl = document.getElementById("customApi");
const customRtspEl = document.getElementById("customRtsp");
const rtspUrlEl = document.getElementById("rtspUrl");
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
const sampleRate = 48000;
const channels = 2;
const framesPerChunk = 1024;
const bitrate = 320000;
const expectedAacConfigHex = "1190";
const wasmEncodeBatchFrames = 2;
const fallbackServers = [
  { name: "Local 554", apiBase: "http://127.0.0.1:8081", rtspBase: "rtsp://127.0.0.1" },
  { name: "Local 8554", apiBase: "http://127.0.0.1:8081", rtspBase: "rtsp://127.0.0.1:8554" }
];

let urlSeq = 0;
let active = null;
let streamCode = "";
let servers = fallbackServers;

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

  limit(sample) {
    if (sample > 1) return 1;
    if (sample < -1) return -1;
    return sample;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) for (const channel of output) channel.fill(0);

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
        this.pcm[dst] = this.limit(leftIn[src] * gain);
        this.pcm[dst + 1] = this.limit(rightIn[src] * gain);
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

function errorText(error) {
  if (!error) return "unknown error";
  return error.message || String(error);
}

function limitText(text, maxLength = 220) {
  const value = String(text || "");
  return value.length <= maxLength ? value : value.slice(0, maxLength - 1) + "...";
}

function nativeAacConfigs() {
  return [
    ["raw AAC + CBR", {
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: channels,
      bitrate,
      bitrateMode: "constant",
      aac: { format: "aac" }
    }],
    ["raw AAC", {
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: channels,
      bitrate,
      aac: { format: "aac" }
    }],
    ["default AAC + CBR", {
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: channels,
      bitrate,
      bitrateMode: "constant"
    }],
    ["default AAC", {
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: channels,
      bitrate
    }]
  ];
}

async function supportedNativeAacConfig() {
  if (!("AudioEncoder" in globalThis)) throw new Error("AudioEncoder is missing.");
  if (!("AudioData" in globalThis)) throw new Error("AudioData is missing.");
  if (typeof AudioEncoder.isConfigSupported !== "function") {
    throw new Error("AudioEncoder.isConfigSupported is missing.");
  }

  const reasons = [];
  for (const [label, config] of nativeAacConfigs()) {
    try {
      const support = await AudioEncoder.isConfigSupported(config);
      if (support.supported) return { config: support.config || config, label };
      reasons.push(`${label}: supported=false`);
    } catch (error) {
      reasons.push(`${label}: ${errorText(error)}`);
    }
  }

  throw new Error(`all AAC configs unsupported (${reasons.join("; ")})`);
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function copyEncodedChunk(chunk) {
  const packet = new Uint8Array(chunk.byteLength);
  chunk.copyTo(packet);
  return packet;
}

async function probeNativeAacEncoder(config) {
  let firstPacket = null;
  let configHex = "";
  let encoderError = null;

  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      if (!firstPacket) firstPacket = copyEncodedChunk(chunk);
      const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
      if (description && !configHex) configHex = bytesToHex(new Uint8Array(description));
    },
    error(error) {
      encoderError = error;
    }
  });

  try {
    encoder.configure(config);
    const silence = new Float32Array(framesPerChunk * channels);
    const audioData = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: framesPerChunk,
      numberOfChannels: channels,
      timestamp: 0,
      data: silence
    });
    encoder.encode(audioData);
    audioData.close();
    await encoder.flush();
  } finally {
    try { encoder.close(); } catch (_) {}
  }

  if (encoderError) throw encoderError;
  if (!firstPacket || firstPacket.byteLength < 4) throw new Error("Native AAC probe produced no packet.");
  if (firstPacket[0] === 0xff && (firstPacket[1] & 0xf6) === 0xf0) {
    throw new Error("Native AAC encoder produced ADTS instead of raw AAC access units.");
  }
  if (configHex && !configHex.startsWith(expectedAacConfigHex)) {
    throw new Error(`Native AAC config ${configHex} does not match RTSP SDP ${expectedAacConfigHex}.`);
  }
}

async function createNativeAacEncoder(onPacket, onError) {
  const { config, label } = await supportedNativeAacConfig();
  await probeNativeAacEncoder(config);

  let pcmBlocks = 0;
  let encodedFrames = 0;
  let encodedBytes = 0;
  let firstPacketAt = 0;
  let nextTimestampUs = 0;
  let closed = false;

  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      if (closed) return;
      const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
      if (description) {
        const configHex = bytesToHex(new Uint8Array(description));
        if (!configHex.startsWith(expectedAacConfigHex)) {
          onError(new Error(`Native AAC config ${configHex} does not match RTSP SDP ${expectedAacConfigHex}.`));
          return;
        }
      }

      const packet = copyEncodedChunk(chunk);
      if (packet[0] === 0xff && (packet[1] & 0xf6) === 0xf0) {
        onError(new Error("Native AAC encoder produced ADTS instead of raw access units."));
        return;
      }

      if (firstPacketAt === 0) firstPacketAt = performance.now();
      encodedFrames++;
      encodedBytes += packet.byteLength;
      onPacket(packet.buffer);
    },
    error(error) {
      if (!closed) onError(error);
    }
  });

  encoder.configure(config);

  return {
    name: "Native WebCodecs AAC",
    detail: label,
    encode(buffer) {
      pcmBlocks++;
      const frameCount = buffer.byteLength / Float32Array.BYTES_PER_ELEMENT / channels;
      const audioData = new AudioData({
        format: "f32",
        sampleRate,
        numberOfFrames: frameCount,
        numberOfChannels: channels,
        timestamp: nextTimestampUs,
        data: buffer
      });
      nextTimestampUs += Math.round(frameCount * 1000000 / sampleRate);
      encoder.encode(audioData);
      audioData.close();
    },
    close() {
      closed = true;
      try { encoder.close(); } catch (_) {}
    },
    stats() {
      const elapsed = firstPacketAt === 0
        ? 0.001
        : Math.max((performance.now() - firstPacketAt) / 1000, 0.001);
      return {
        name: "Native WebCodecs AAC",
        detail: label,
        fallbackReason: "",
        pcmBlocks,
        encodedFrames,
        encodedBytes,
        encodedFps: encodedFrames / elapsed,
        encodedKbps: (encodedBytes * 8 / 1000) / elapsed,
        queue: encoder.encodeQueueSize || 0
      };
    }
  };
}

function createWorkerAacEncoder(onPacket, onError) {
  const worker = new Worker(new URL("aac-worker.js", location.href), { type: "module" });
  let readySettled = false;
  let pcmBlocks = 0;
  let encodedFrames = 0;
  let encodedBytes = 0;
  let firstPacketAt = 0;
  let pendingBatch = null;
  let pendingBatchFrames = 0;

  function sendBatch(buffer) {
    worker.postMessage({ type: "encode", pcm: buffer }, [buffer]);
  }

  const ready = new Promise((resolve, reject) => {
    worker.onmessage = event => {
      const message = event.data;
      if (message.type === "ready") {
        if (!message.configHex.startsWith(expectedAacConfigHex)) {
          reject(new Error(`AAC config ${message.configHex} does not match RTSP SDP ${expectedAacConfigHex}.`));
          worker.terminate();
          return;
        }
        readySettled = true;
        resolve(message);
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
    worker.postMessage({ type: "init", sampleRate, channels, bitrate });
  });

  return {
    ready,
    encode(buffer) {
      pcmBlocks++;
      if (wasmEncodeBatchFrames <= 1) {
        sendBatch(buffer);
        return;
      }

      if (!pendingBatch) {
        pendingBatch = buffer;
        pendingBatchFrames = 1;
        return;
      }

      const joined = new Uint8Array(pendingBatch.byteLength + buffer.byteLength);
      joined.set(new Uint8Array(pendingBatch), 0);
      joined.set(new Uint8Array(buffer), pendingBatch.byteLength);
      pendingBatch = joined.buffer;
      pendingBatchFrames++;

      if (pendingBatchFrames >= wasmEncodeBatchFrames) {
        const batch = pendingBatch;
        pendingBatch = null;
        pendingBatchFrames = 0;
        sendBatch(batch);
      }
    },
    close() {
      if (pendingBatch) {
        sendBatch(pendingBatch);
        pendingBatch = null;
        pendingBatchFrames = 0;
      }
      try { worker.postMessage({ type: "close" }); } catch (_) {}
      worker.terminate();
    },
    stats() {
      const elapsed = firstPacketAt === 0
        ? 0.001
        : Math.max((performance.now() - firstPacketAt) / 1000, 0.001);
      return {
        name: "WASM AAC",
        detail: "",
        fallbackReason: "",
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

function createAacEncoder(onPacket, onError) {
  let impl = null;
  let workerFallback = null;
  let fallbackReason = "";
  const ready = createNativeAacEncoder(onPacket, onError)
    .then(nativeEncoder => {
      impl = nativeEncoder;
      return { name: nativeEncoder.name, detail: nativeEncoder.detail, fallbackReason: "" };
    })
    .catch(error => {
      fallbackReason = limitText(errorText(error));
      workerFallback = createWorkerAacEncoder(onPacket, onError);
      impl = workerFallback;
      return workerFallback.ready.then(() => ({
        name: "WASM AAC",
        detail: "",
        fallbackReason
      }));
    });

  return {
    ready,
    encode(buffer) {
      if (!impl) {
        onError(new Error("AAC encoder is not ready."));
        return;
      }
      impl.encode(buffer);
    },
    close() {
      if (impl) impl.close();
      else if (workerFallback) workerFallback.close();
    },
    stats() {
      if (!impl) {
        return {
          name: "Loading AAC",
          pcmBlocks: 0,
          encodedFrames: 0,
          encodedBytes: 0,
          encodedFps: 0,
          encodedKbps: 0,
          queue: 0,
          detail: "",
          fallbackReason
        };
      }
      const stats = impl.stats();
      if (fallbackReason && !stats.fallbackReason) stats.fallbackReason = fallbackReason;
      return stats;
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
    setStatus("Loading browser AAC encoder...");
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
    const encoderInfo = await encoder.ready;

    setStatus(kind === "screen"
      ? "Choose a screen/tab and enable audio sharing in the browser prompt..."
      : "Allow microphone access in the browser prompt...");
    mediaStream = await withTimeout(
      captureAudio(kind),
      45000,
      "Timed out waiting for browser audio permission/selection."
    );
    if (mediaStream.getAudioTracks().length === 0) throw new Error("No audio track selected");

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
      const stats = encoder.stats();
      if (stats.pcmBlocks - stats.encodedFrames > 128) {
        failActive("AAC encoder queue is too slow; stopped.");
        return;
      }
      encoder.encode(buffer);
    });
    applyCaptureGain(captureNode);
    const muted = audioContext.createGain();
    muted.gain.value = 0;

    active = {
      mediaStream,
      audioContext,
      ws,
      encoder,
      source,
      captureNode,
      muted,
      statusTimer: null
    };

    source.connect(captureNode);
    captureNode.connect(muted);
    muted.connect(audioContext.destination);
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
    setStatus(`${encoderStatusLine(encoderInfo)}\nUse in VRChat: ${vrcUrl}`);
    active.statusTimer = setInterval(() => {
      if (!active || active.ws !== ws) return;
      const stats = encoder.stats();
      setStatus(`${encoderStatusLine(stats)}\nGain: ${currentGain().toFixed(2)}x\nEncoded AAC frames: ${stats.encodedFrames}\nEncoded fps: ${stats.encodedFps.toFixed(1)} / 46.9\nAAC kbps: ${stats.encodedKbps.toFixed(0)}\nEncoder queue: ${stats.queue}\nUse in VRChat: ${vrcUrl}`);
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
  try { current.muted.disconnect(); } catch (_) {}
  current.mediaStream.getTracks().forEach(track => track.stop());
  current.encoder.close();
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

async function init() {
  streamCode = loadCode();
  await loadServers();
  renderServers();
  updateUrl();
  refreshStats();
  setInterval(refreshStats, 2000);
}

init().catch(error => setStatus(error.message || String(error)));
