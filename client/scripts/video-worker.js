const VIDEO_FRAME_HEADER_BYTES = 5;
const H264_CLOCK_RATE = 90000;
const ANNEX_B_START_CODE = new Uint8Array([0, 0, 0, 1]);
const MAX_ENCODER_QUEUE = 2;
const SOURCE_BUFFER_FRAMES = 2;
const BITRATE_HEADROOM = 0.9;
const MIN_QUANTIZER = 20;
const MAX_QUANTIZER = 51;
const INITIAL_QUANTIZER = 51;

let encoder = null;
let canvas = null;
let ctx = null;
let sourceReader = null;
let sourceGeneration = 0;
let sourceBuffer = [];
let sourceBufferReadyAt = 0;
let renderedSourceFrame = false;
let pacingTimer = 0;
let scheduledFrameIndex = 0;
let statsTimer = 0;
let closed = true;
let failed = false;
let paused = false;
let networkPaused = false;
let placeholder = false;
let placeholderImage = null;
let placeholderImageUrl = "";
let width = 1280;
let height = 720;
let fps = 30;
let bitrateLimit = 2000000;
let quantizer = INITIAL_QUANTIZER;
let keyframeInterval = 30;
let framePeriodUs = 33333;
let timelineStartedAt = 0;
let lastFrameIndex = -1;
let lastTimestampUs = -1;
let lastKeyframeTimestampUs = -2000000;
let submitted = 0;
let encoded = 0;
let sourceFrames = 0;
let sourceBufferDrops = 0;
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

function timelineElapsedMs() {
  return Math.max(0, performance.now() - timelineStartedAt);
}

function frameTimestampUs(frameIndex) {
  return Math.round(frameIndex * 1000000 / fps);
}

function createOutputFrame(source, showPlaceholder, timestamp, duration) {
  if (source) {
    drawFrame(source);
    outputPath = "normalized";
  } else if (showPlaceholder) {
    drawPlaceholder();
    outputPath = "placeholder";
  } else {
    outputPath = "normalized";
  }
  return new VideoFrame(canvas, { timestamp, duration });
}

function submitFrame(source, showPlaceholder, timestamp, duration, repeated = false) {
  if (closed || paused || networkPaused || !encoder || encoder.state !== "configured") return false;
  if (encoder.encodeQueueSize >= MAX_ENCODER_QUEUE) {
    queueDrops++;
    return false;
  }

  const frame = createOutputFrame(source, showPlaceholder, timestamp, duration);
  try {
    const keyFrame = forceNextKeyframe
      || timestamp - lastKeyframeTimestampUs >= keyframeInterval * framePeriodUs;
    encoder.encode(frame, { keyFrame, avc: { quantizer } });
    forceNextKeyframe = false;
    if (keyFrame) lastKeyframeTimestampUs = timestamp;
    if (repeated) repeatedFrames++;
    submitted++;
    return true;
  } finally {
    frame.close();
  }
}

function clearPacingTimer() {
  clearTimeout(pacingTimer);
  pacingTimer = 0;
}

function scheduleNextFrame() {
  if (closed || paused || networkPaused || pacingTimer) return;
  const elapsedMs = timelineElapsedMs();
  const elapsedFrame = Math.ceil(elapsedMs * fps / 1000);
  scheduledFrameIndex = Math.max(elapsedFrame, lastFrameIndex + 1);
  const delay = Math.max(0, scheduledFrameIndex * 1000 / fps - elapsedMs);
  pacingTimer = setTimeout(runPacing, delay);
}

function runPacing() {
  pacingTimer = 0;
  if (closed || paused || networkPaused) return;
  let frameIndex = Math.max(
    scheduledFrameIndex,
    Math.floor(timelineElapsedMs() * fps / 1000),
    lastFrameIndex + 1
  );
  let timestamp = frameTimestampUs(frameIndex);
  while (timestamp <= lastTimestampUs) {
    frameIndex++;
    timestamp = frameTimestampUs(frameIndex);
  }
  const duration = frameTimestampUs(frameIndex + 1) - timestamp;
  lastFrameIndex = frameIndex;
  lastTimestampUs = timestamp;
  const sourceReady = !placeholder && (
    renderedSourceFrame
    || sourceBuffer.length >= SOURCE_BUFFER_FRAMES
    || timelineElapsedMs() >= sourceBufferReadyAt
  );
  const source = sourceReady && sourceBuffer.length ? sourceBuffer.shift() : null;
  const showPlaceholder = placeholder || !renderedSourceFrame && !source;
  const repeated = !showPlaceholder && !source;
  try {
    if (submitFrame(source, showPlaceholder, timestamp, duration, repeated) && source) {
      renderedSourceFrame = true;
    }
  } catch (error) {
    void fail(error);
    return;
  } finally {
    if (source) source.close();
  }
  scheduleNextFrame();
}

function startCurrentOutput() {
  if (closed || paused || networkPaused) return;
  if (!placeholder && !renderedSourceFrame && sourceBuffer.length === 0) return;
  scheduleNextFrame();
}

function clearSourceBuffer() {
  for (const frame of sourceBuffer) frame.close();
  sourceBuffer = [];
}

function enterPlaceholder(start = true) {
  clearSourceBuffer();
  renderedSourceFrame = false;
  placeholder = true;
  forceNextKeyframe = true;
  if (start) startCurrentOutput();
}

function onSourceFrame(frame) {
  sourceFrames++;
  if (sourceBuffer.length === SOURCE_BUFFER_FRAMES) {
    sourceBuffer.shift().close();
    sourceBufferDrops++;
  }
  sourceBuffer.push(frame);
  if (placeholder) {
    sourceBufferReadyAt = timelineElapsedMs() + 1000 / fps;
    renderedSourceFrame = false;
    forceNextKeyframe = true;
  }
  placeholder = false;
  startCurrentOutput();
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
  if (!closed && !paused && !networkPaused && !placeholder && encodedDelta > 0) {
    adaptQuantizer(actualBitrate);
  }
  postMessage({
    type: "stats",
    stats: {
      queueDrops,
      sourceBufferDrops,
      repeatedFrames,
      submittedFps: submittedDelta / elapsed,
      fps: encodedDelta / elapsed,
      sourceFps: sourceDelta / elapsed,
      kbps: actualBitrate / 1000,
      queue: encoder ? encoder.encodeQueueSize : 0,
      path: outputPath,
      limitKbps: bitrateLimit / 1000,
      quantizerAdjustments,
      quantizer
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

function encoderConfig(nextWidth, nextHeight, nextFps, nextBitrate) {
  return {
    codec: h264Codec(nextWidth, nextHeight, nextFps, nextBitrate),
    width: nextWidth,
    height: nextHeight,
    bitrate: nextBitrate,
    bitrateMode: "quantizer",
    framerate: nextFps,
    hardwareAcceleration: "prefer-hardware",
    latencyMode: "realtime",
    avc: { format: "annexb" }
  };
}

async function assertEncoderSupport(config) {
  if (!VideoEncoder.isConfigSupported) return;
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported || support.config?.bitrateMode !== "quantizer") {
    throw new Error(`Native H.264 WebCodecs quantizer mode ${config.width}x${config.height}@${config.framerate} is not supported.`);
  }
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
  const config = encoderConfig(
    message.width,
    message.height,
    message.fps,
    message.bitrate
  );
  let nextEncoder = null;
  try {
    await assertEncoderSupport(config);
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
    quantizer = INITIAL_QUANTIZER;
    keyframeInterval = fps;
    framePeriodUs = Math.round(1000000 / fps);
    lastFrameIndex = Math.floor(lastTimestampUs * fps / 1000000);
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
  networkPaused = false;
  placeholder = true;
  width = message.width;
  height = message.height;
  fps = message.fps;
  bitrateLimit = message.bitrate;
  quantizer = INITIAL_QUANTIZER;
  keyframeInterval = fps;
  framePeriodUs = Math.round(1000000 / Math.max(1, fps));
  timelineStartedAt = performance.now() - Math.max(0, Number(message.timelineOffsetMs) || 0);
  lastFrameIndex = -1;
  lastTimestampUs = -1;
  sourceBuffer = [];
  sourceBufferReadyAt = 0;
  renderedSourceFrame = false;
  scheduledFrameIndex = 0;
  lastKeyframeTimestampUs = -keyframeInterval * framePeriodUs;
  submitted = 0;
  encoded = 0;
  sourceFrames = 0;
  sourceBufferDrops = 0;
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

  const config = encoderConfig(width, height, fps, bitrateLimit);
  await assertEncoderSupport(config);
  canvas = new OffscreenCanvas(width, height);
  ctx = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true,
    colorSpace: "srgb"
  });
  if (!ctx) throw new Error("OffscreenCanvas 2D context is not available.");
  encoder = createEncoder(config);
  await loadPlaceholderImage(placeholderImageUrl);
  statsTimer = setInterval(postStats, 1000);
  postMessage({ type: "ready" });
}

async function closeAll() {
  closed = true;
  paused = true;
  networkPaused = false;
  clearPacingTimer();
  clearInterval(statsTimer);
  statsTimer = 0;
  await stopSource();
  clearSourceBuffer();
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
  } else if (message.type === "reconfigure" && !closed) {
    await reconfigure(message);
  } else if (message.type === "resume" && !closed) {
    paused = false;
    forceNextKeyframe = true;
    startCurrentOutput();
  } else if (message.type === "transport-pause" && !closed) {
    networkPaused = true;
    clearPacingTimer();
  } else if (message.type === "transport-resume" && !closed) {
    networkPaused = false;
    forceNextKeyframe = true;
    startCurrentOutput();
  } else if (message.type === "close") {
    await closeAll();
    postMessage({ type: "closed" });
  }
}

self.onmessage = event => enqueue(() => handleMessage(event.data || {}));
