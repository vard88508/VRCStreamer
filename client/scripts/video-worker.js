const VIDEO_FRAME_HEADER_BYTES = 5;
const H264_CLOCK_RATE = 90000;
const ANNEX_B_START_CODE = new Uint8Array([0, 0, 0, 1]);
const MAX_ENCODER_QUEUE = 2;
const BITRATE_HEADROOM = 0.9;
const MIN_QUANTIZER = 20;
const MAX_QUANTIZER = 51;
const INITIAL_QUANTIZER = 51;
const QUANTIZER_RATE_CONTROL = "quantizer";
const CONSTANT_RATE_CONTROL = "constant";
const VARIABLE_RATE_CONTROL = "variable";
const PREFER_HARDWARE = "prefer-hardware";
const NO_PREFERENCE = "no-preference";
const ENCODER_CANDIDATES = [
  [QUANTIZER_RATE_CONTROL, PREFER_HARDWARE],
  [CONSTANT_RATE_CONTROL, PREFER_HARDWARE],
  [VARIABLE_RATE_CONTROL, PREFER_HARDWARE],
  [CONSTANT_RATE_CONTROL, NO_PREFERENCE],
  [VARIABLE_RATE_CONTROL, NO_PREFERENCE]
];

let encoder = null;
let canvas = null;
let ctx = null;
let sourceReader = null;
let sourceGeneration = 0;
let latestFrame = null;
let pacingTimer = 0;
let statsTimer = 0;
let closed = true;
let failed = false;
let paused = false;
let placeholder = false;
let placeholderImage = null;
let placeholderImageUrl = "";
let width = 1280;
let height = 720;
let fps = 30;
let bitrateLimit = 2000000;
let rateControlMode = QUANTIZER_RATE_CONTROL;
let hardwareAccelerationMode = PREFER_HARDWARE;
let quantizer = INITIAL_QUANTIZER;
let keyframeInterval = 60;
let framePeriodMs = 1000 / 30;
let framePeriodUs = 33333;
let timelineStartedAt = 0;
let lastTimestampUs = -1;
let lastKeyframeTimestampUs = -2000000;
let submitted = 0;
let encoded = 0;
let sourceFrames = 0;
let queueDrops = 0;
let repeatedFrames = 0;
let encodedBytes = 0;
let outputPath = "placeholder";
let lastStatsAt = 0;
let lastSubmitted = 0;
let lastEncoded = 0;
let lastSourceFrames = 0;
let lastEncodedBytes = 0;
let quantizerAdjustments = 0;
let avcHeader = null;
let forceNextKeyframe = false;
let commandQueue = Promise.resolve();

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

async function fail(error) {
  if (failed) return;
  failed = true;
  postMessage({ type: "error", message: errorText(error) });
  await closeAll();
}

function enqueue(task) {
  commandQueue = commandQueue.then(task, task).catch(fail);
}

function avcDescriptionToAnnexB(description) {
  if (!description) return null;
  const data = new Uint8Array(description);
  if (data.length < 7 || data[0] !== 1) return null;
  let offset = 5;
  const parts = [];
  const spsCount = data[offset++] & 0x1f;
  for (let i = 0; i < spsCount; i++) {
    if (offset + 2 > data.length) return null;
    const length = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    if (offset + length > data.length) return null;
    parts.push(data.subarray(offset, offset + length));
    offset += length;
  }
  if (offset >= data.length) return null;
  const ppsCount = data[offset++];
  for (let i = 0; i < ppsCount; i++) {
    if (offset + 2 > data.length) return null;
    const length = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    if (offset + length > data.length) return null;
    parts.push(data.subarray(offset, offset + length));
    offset += length;
  }
  const total = parts.reduce((sum, part) => sum + 4 + part.byteLength, 0);
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let write = 0;
  for (const part of parts) {
    out.set(ANNEX_B_START_CODE, write);
    write += 4;
    out.set(part, write);
    write += part.byteLength;
  }
  return out;
}

function sendVideoPacket(chunk, header) {
  const headerLength = chunk.type === "key" && header ? header.byteLength : 0;
  const packet = new Uint8Array(chunk.byteLength + headerLength + VIDEO_FRAME_HEADER_BYTES);
  const rtpTimestamp = Math.round(chunk.timestamp * H264_CLOCK_RATE / 1000000) >>> 0;
  packet[0] = chunk.type === "key" ? 0x01 : 0x02;
  packet[1] = rtpTimestamp >>> 24;
  packet[2] = rtpTimestamp >>> 16;
  packet[3] = rtpTimestamp >>> 8;
  packet[4] = rtpTimestamp;
  if (headerLength) packet.set(header, VIDEO_FRAME_HEADER_BYTES);
  chunk.copyTo(packet.subarray(VIDEO_FRAME_HEADER_BYTES + headerLength));
  encodedBytes += chunk.byteLength + headerLength;
  postMessage({ type: "packet", packet: packet.buffer }, [packet.buffer]);
}

function frameWidth(frame) {
  return frame.displayWidth || frame.codedWidth || frame.width || width;
}

function frameHeight(frame) {
  return frame.displayHeight || frame.codedHeight || frame.height || height;
}

function frameMatchesOutput(frame) {
  return frameWidth(frame) === width && frameHeight(frame) === height;
}

function drawFrame(frame) {
  const sourceWidth = frameWidth(frame);
  const sourceHeight = frameHeight(frame);
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  const x = Math.floor((width - drawWidth) / 2);
  const y = Math.floor((height - drawHeight) / 2);
  if (drawWidth !== width || drawHeight !== height) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(frame, x, y, drawWidth, drawHeight);
}

function drawPlaceholder() {
  if (placeholderImage) drawFrame(placeholderImage);
  else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
  }
}

async function loadPlaceholderImage(url) {
  if (!url) throw new Error("Video placeholder image URL is missing.");
  if (!("createImageBitmap" in self)) throw new Error("createImageBitmap is not available in worker.");
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Video placeholder image failed to load: ${response.status}`);
  const image = await createImageBitmap(await response.blob());
  if (closed || url !== placeholderImageUrl) {
    image.close();
    return;
  }
  if (placeholderImage) placeholderImage.close();
  placeholderImage = image;
}

function mediaTimestampUs() {
  const elapsed = Math.round((performance.now() - timelineStartedAt) * 1000);
  lastTimestampUs = Math.max(lastTimestampUs + 1, elapsed);
  return lastTimestampUs;
}

function createOutputFrame(source, timestamp) {
  if (source && frameMatchesOutput(source)) {
    outputPath = "direct";
    return new VideoFrame(source, { timestamp, duration: framePeriodUs });
  }
  if (source) {
    drawFrame(source);
    outputPath = "scaled";
  } else {
    drawPlaceholder();
    outputPath = "placeholder";
  }
  return new VideoFrame(canvas, { timestamp, duration: framePeriodUs });
}

function submitFrame(source, repeated = false) {
  if (closed || paused || !encoder || encoder.state !== "configured") return;
  if (encoder.encodeQueueSize >= MAX_ENCODER_QUEUE) {
    queueDrops++;
    return;
  }

  const timestamp = mediaTimestampUs();
  const frame = createOutputFrame(source, timestamp);
  try {
    const keyFrame = forceNextKeyframe
      || timestamp - lastKeyframeTimestampUs >= keyframeInterval * framePeriodUs;
    const options = rateControlMode === QUANTIZER_RATE_CONTROL
      ? { keyFrame, avc: { quantizer } }
      : { keyFrame };
    encoder.encode(frame, options);
    forceNextKeyframe = false;
    if (keyFrame) lastKeyframeTimestampUs = timestamp;
    if (repeated) repeatedFrames++;
    submitted++;
  } finally {
    frame.close();
  }
}

function clearPacingTimer() {
  clearTimeout(pacingTimer);
  pacingTimer = 0;
}

function runPlaceholder() {
  pacingTimer = 0;
  if (closed || paused || !placeholder) return;
  try {
    submitFrame(null);
  } catch (error) {
    void fail(error);
    return;
  }
  pacingTimer = setTimeout(runPlaceholder, framePeriodMs);
}

function repeatStalledFrame() {
  pacingTimer = 0;
  if (closed || paused || placeholder || !latestFrame) return;
  try {
    submitFrame(latestFrame, true);
  } catch (error) {
    void fail(error);
    return;
  }
  pacingTimer = setTimeout(repeatStalledFrame, framePeriodMs);
}

function scheduleStallFallback() {
  clearPacingTimer();
  if (!closed && !paused && !placeholder && latestFrame) {
    pacingTimer = setTimeout(repeatStalledFrame, framePeriodMs * 1.5);
  }
}

function startCurrentOutput() {
  clearPacingTimer();
  if (closed || paused) return;
  if (placeholder || !latestFrame) {
    placeholder = true;
    runPlaceholder();
  } else {
    try {
      submitFrame(latestFrame);
    } catch (error) {
      void fail(error);
      return;
    }
    scheduleStallFallback();
  }
}

function closeLatestFrame() {
  if (latestFrame) latestFrame.close();
  latestFrame = null;
}

function enterPlaceholder(start = true) {
  closeLatestFrame();
  placeholder = true;
  forceNextKeyframe = true;
  if (start) startCurrentOutput();
}

function onSourceFrame(frame) {
  sourceFrames++;
  const previous = latestFrame;
  latestFrame = frame;
  if (previous) previous.close();
  placeholder = false;
  clearPacingTimer();
  if (closed || paused) return;
  try {
    submitFrame(frame);
  } catch (error) {
    void fail(error);
    return;
  }
  scheduleStallFallback();
}

async function stopSource() {
  sourceGeneration++;
  const reader = sourceReader;
  sourceReader = null;
  if (reader) {
    try { await reader.cancel(); } catch (_) {}
    try { reader.releaseLock(); } catch (_) {}
  }
}

async function readSource(reader, generation) {
  try {
    while (!closed && generation === sourceGeneration) {
      const { done, value } = await reader.read();
      if (generation !== sourceGeneration) {
        if (value) value.close();
        return;
      }
      if (done || !value) break;
      onSourceFrame(value);
    }
    if (!closed && generation === sourceGeneration) enterPlaceholder();
  } catch (error) {
    if (!closed && generation === sourceGeneration) await fail(error);
  } finally {
    if (generation === sourceGeneration && sourceReader === reader) {
      try { reader.releaseLock(); } catch (_) {}
      sourceReader = null;
    }
  }
}

async function setSource(readable) {
  if (!readable || typeof readable.getReader !== "function") {
    throw new Error("Video worker received an invalid capture stream.");
  }
  await stopSource();
  if (!placeholder) enterPlaceholder();

  sourceReader = readable.getReader();
  const generation = ++sourceGeneration;
  void readSource(sourceReader, generation);
  postMessage({ type: "source-ready" });
}

async function usePlaceholder() {
  if (placeholder && !sourceReader) return;
  await stopSource();
  enterPlaceholder();
}

function postStats() {
  const now = performance.now();
  const elapsed = Math.max((now - lastStatsAt) / 1000, 0.001);
  const submittedDelta = submitted - lastSubmitted;
  const encodedDelta = encoded - lastEncoded;
  const sourceDelta = sourceFrames - lastSourceFrames;
  const byteDelta = encodedBytes - lastEncodedBytes;
  const actualBitrate = byteDelta * 8 / elapsed;
  lastStatsAt = now;
  lastSubmitted = submitted;
  lastEncoded = encoded;
  lastSourceFrames = sourceFrames;
  lastEncodedBytes = encodedBytes;
  if (
    rateControlMode === QUANTIZER_RATE_CONTROL
    && !closed
    && !paused
    && !placeholder
    && encodedDelta > 0
  ) {
    adaptQuantizer(actualBitrate);
  }
  postMessage({
    type: "stats",
    stats: {
      queueDrops,
      repeatedFrames,
      submittedFps: submittedDelta / elapsed,
      fps: encodedDelta / elapsed,
      sourceFps: sourceDelta / elapsed,
      kbps: actualBitrate / 1000,
      queue: encoder ? encoder.encodeQueueSize : 0,
      path: outputPath,
      limitKbps: bitrateLimit / 1000,
      targetKbps: rateControlMode !== QUANTIZER_RATE_CONTROL
        ? bitrateLimit * BITRATE_HEADROOM / 1000
        : 0,
      rateControlMode,
      hardwareAcceleration: hardwareAccelerationMode,
      quantizerAdjustments,
      quantizer: rateControlMode === QUANTIZER_RATE_CONTROL ? quantizer : null
    }
  });
}

const H264_LEVELS = [
  [0x1f, 3600, 108000, 14000],
  [0x20, 5120, 216000, 20000],
  [0x28, 8192, 245760, 20000],
  [0x29, 8192, 245760, 50000],
  [0x2a, 8704, 522240, 50000],
  [0x32, 22080, 589824, 100000],
  [0x33, 36864, 983040, 100000],
  [0x34, 36864, 2073600, 100000],
  [0x3c, 139264, 4177920, 100000],
  [0x3d, 139264, 8355840, 100000],
  [0x3e, 139264, 16711680, 100000]
];

function h264Codec(nextWidth, nextHeight, nextFps, nextBitrate) {
  const frameMacroblocks = Math.ceil(nextWidth / 16) * Math.ceil(nextHeight / 16);
  const macroblocksPerSecond = frameMacroblocks * nextFps;
  const bitrateKbps = Math.ceil(nextBitrate / 1000);
  const level = H264_LEVELS.find(([, maxFrame, maxSecond, maxBitrate]) =>
    frameMacroblocks <= maxFrame
    && macroblocksPerSecond <= maxSecond
    && bitrateKbps <= maxBitrate
  );
  if (!level) throw new Error("Video preset exceeds supported H.264 levels.");
  return `avc1.42E0${level[0].toString(16).padStart(2, "0").toUpperCase()}`;
}

function encoderConfig(
  nextWidth,
  nextHeight,
  nextFps,
  nextBitrate,
  nextRateControlMode,
  nextHardwareAcceleration
) {
  return {
    codec: h264Codec(nextWidth, nextHeight, nextFps, nextBitrate),
    width: nextWidth,
    height: nextHeight,
    bitrate: nextRateControlMode === QUANTIZER_RATE_CONTROL
      ? nextBitrate
      : Math.max(1, Math.floor(nextBitrate * BITRATE_HEADROOM)),
    bitrateMode: nextRateControlMode,
    framerate: nextFps,
    hardwareAcceleration: nextHardwareAcceleration,
    latencyMode: "realtime",
    avc: { format: "annexb" }
  };
}

async function supportedEncoderConfig(nextWidth, nextHeight, nextFps, nextBitrate) {
  if (!VideoEncoder.isConfigSupported) {
    return encoderConfig(
      nextWidth,
      nextHeight,
      nextFps,
      nextBitrate,
      CONSTANT_RATE_CONTROL,
      NO_PREFERENCE
    );
  }
  for (const [mode, hardwareAcceleration] of ENCODER_CANDIDATES) {
    const config = encoderConfig(
      nextWidth,
      nextHeight,
      nextFps,
      nextBitrate,
      mode,
      hardwareAcceleration
    );
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch (_) {}
  }
  throw new Error(`Native H.264 WebCodecs encoding ${nextWidth}x${nextHeight}@${nextFps} is not supported.`);
}

function adaptQuantizer(actualBitrate) {
  const budget = bitrateLimit * BITRATE_HEADROOM;
  if (actualBitrate > budget) {
    const step = Math.max(1, Math.ceil(6 * Math.log2(actualBitrate / budget)));
    const nextQuantizer = Math.min(MAX_QUANTIZER, quantizer + step);
    if (nextQuantizer !== quantizer) {
      quantizer = nextQuantizer;
      quantizerAdjustments++;
    }
    return;
  }

  if (actualBitrate < budget * 0.7 && quantizer > MIN_QUANTIZER) {
    const step = Math.max(1, Math.floor(6 * Math.log2(budget / Math.max(actualBitrate, 1))));
    quantizer = Math.max(MIN_QUANTIZER, quantizer - Math.min(step, 6));
    quantizerAdjustments++;
  }
}

function createEncoder(config) {
  const next = new VideoEncoder({
    output(chunk, metadata) {
      if (closed) return;
      const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
      avcHeader = avcDescriptionToAnnexB(description) || avcHeader;
      encoded++;
      sendVideoPacket(chunk, avcHeader);
    },
    error(error) {
      if (!closed) void fail(error);
    }
  });
  next.configure(config);
  return next;
}

async function reconfigure(message) {
  let nextEncoder = null;
  try {
    const config = await supportedEncoderConfig(
      message.width,
      message.height,
      message.fps,
      message.bitrate
    );
    nextEncoder = createEncoder(config);
    paused = true;
    clearPacingTimer();
    const previousEncoder = encoder;
    await previousEncoder.flush();
    encoder = nextEncoder;
    nextEncoder = null;
    previousEncoder.close();

    width = message.width;
    height = message.height;
    fps = message.fps;
    bitrateLimit = message.bitrate;
    rateControlMode = config.bitrateMode;
    hardwareAccelerationMode = config.hardwareAcceleration;
    quantizer = INITIAL_QUANTIZER;
    quantizerAdjustments = 0;
    keyframeInterval = fps * 2;
    framePeriodMs = 1000 / fps;
    framePeriodUs = Math.round(1000000 / fps);
    canvas.width = width;
    canvas.height = height;
    avcHeader = null;
    lastKeyframeTimestampUs = lastTimestampUs - keyframeInterval * framePeriodUs;
    forceNextKeyframe = true;
    postMessage({ type: "reconfigured" });
  } catch (error) {
    if (nextEncoder) nextEncoder.close();
    paused = false;
    startCurrentOutput();
    postMessage({ type: "reconfigure-error", message: errorText(error) });
  }
}

async function init(message) {
  await closeAll();
  failed = false;
  closed = false;
  paused = false;
  placeholder = true;
  width = message.width;
  height = message.height;
  fps = message.fps;
  bitrateLimit = message.bitrate;
  rateControlMode = QUANTIZER_RATE_CONTROL;
  hardwareAccelerationMode = PREFER_HARDWARE;
  quantizer = INITIAL_QUANTIZER;
  keyframeInterval = fps * 2;
  framePeriodMs = 1000 / Math.max(1, fps);
  framePeriodUs = Math.round(1000000 / Math.max(1, fps));
  timelineStartedAt = performance.now() - Math.max(0, Number(message.timelineOffsetMs) || 0);
  lastTimestampUs = -1;
  lastKeyframeTimestampUs = -keyframeInterval * framePeriodUs;
  submitted = 0;
  encoded = 0;
  sourceFrames = 0;
  queueDrops = 0;
  repeatedFrames = 0;
  encodedBytes = 0;
  outputPath = "placeholder";
  lastStatsAt = performance.now();
  lastSubmitted = 0;
  lastEncoded = 0;
  lastSourceFrames = 0;
  lastEncodedBytes = 0;
  quantizerAdjustments = 0;
  avcHeader = null;
  forceNextKeyframe = true;
  placeholderImageUrl = message.placeholderUrl || "";

  if (!("VideoEncoder" in self) || !("VideoFrame" in self)) {
    throw new Error("Native H.264 WebCodecs video encoder is not available in worker.");
  }
  if (!("OffscreenCanvas" in self)) {
    throw new Error("Worker video pipeline is not available in this browser.");
  }

  const config = await supportedEncoderConfig(width, height, fps, bitrateLimit);
  rateControlMode = config.bitrateMode;
  hardwareAccelerationMode = config.hardwareAcceleration;
  canvas = new OffscreenCanvas(width, height);
  ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) throw new Error("OffscreenCanvas 2D context is not available.");
  encoder = createEncoder(config);
  await loadPlaceholderImage(placeholderImageUrl);
  statsTimer = setInterval(postStats, 1000);
  postMessage({ type: "ready" });
}

async function closeAll() {
  closed = true;
  paused = true;
  clearPacingTimer();
  clearInterval(statsTimer);
  statsTimer = 0;
  await stopSource();
  closeLatestFrame();
  if (placeholderImage) {
    placeholderImage.close();
    placeholderImage = null;
  }
  const currentEncoder = encoder;
  encoder = null;
  if (currentEncoder) {
    try { await currentEncoder.flush(); } catch (_) {}
    try { currentEncoder.close(); } catch (_) {}
  }
  canvas = null;
  ctx = null;
}

async function handleMessage(message) {
  if (message.type === "init") {
    await init(message);
  } else if (message.type === "source" && !closed) {
    await setSource(message.readable);
  } else if (message.type === "placeholder" && !closed) {
    await usePlaceholder();
  } else if (message.type === "keyframe" && !closed) {
    forceNextKeyframe = true;
  } else if (message.type === "reconfigure" && !closed) {
    await reconfigure(message);
  } else if (message.type === "resume" && !closed) {
    paused = false;
    forceNextKeyframe = true;
    startCurrentOutput();
  } else if (message.type === "close") {
    await closeAll();
    postMessage({ type: "closed" });
  }
}

self.onmessage = event => enqueue(() => handleMessage(event.data || {}));
