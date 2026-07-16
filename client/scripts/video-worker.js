const VIDEO_FRAME_HEADER_BYTES = 5;
const ANNEX_B_START_CODE = new Uint8Array([0, 0, 0, 1]);

let encoder = null;
let canvas = null;
let ctx = null;
let latestFrame = null;
let timer = 0;
let statsTimer = 0;
let closed = true;
let placeholder = false;
let placeholderImage = null;
let placeholderImageUrl = "";
let width = 1280;
let height = 720;
let fps = 30;
let bitrate = 2000000;
let keyframeInterval = 60;
let framePeriodMs = 1000 / 30;
let framePeriodUs = 33333;
let nextEncodeAt = 0;
let nextTimestampUs = 0;
let lastKeyframeTimestampUs = -2000000;
let submitted = 0;
let encoded = 0;
let dropped = 0;
let sourceFrames = 0;
let encodedBytes = 0;
let lastStatsAt = 0;
let lastEncoded = 0;
let lastSourceFrames = 0;
let lastEncodedBytes = 0;
let avcHeader = null;
let forceNextKeyframe = false;

function fail(error) {
  postMessage({ type: "error", message: error && error.message ? error.message : String(error) });
  closeAll();
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
    const len = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    if (offset + len > data.length) return null;
    parts.push(data.subarray(offset, offset + len));
    offset += len;
  }
  if (offset >= data.length) return null;
  const ppsCount = data[offset++];
  for (let i = 0; i < ppsCount; i++) {
    if (offset + 2 > data.length) return null;
    const len = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    if (offset + len > data.length) return null;
    parts.push(data.subarray(offset, offset + len));
    offset += len;
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
  const rtpTimestamp = Math.round(chunk.timestamp * 9 / 100) >>> 0;
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

function drawFrame(frame) {
  const srcWidth = frame.displayWidth || frame.codedWidth || frame.width || width;
  const srcHeight = frame.displayHeight || frame.codedHeight || frame.height || height;
  const scale = Math.min(width / srcWidth, height / srcHeight);
  const drawWidth = Math.max(1, Math.round(srcWidth * scale));
  const drawHeight = Math.max(1, Math.round(srcHeight * scale));
  const x = Math.floor((width - drawWidth) / 2);
  const y = Math.floor((height - drawHeight) / 2);
  if (drawWidth !== width || drawHeight !== height) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(frame, x, y, drawWidth, drawHeight);
}

function drawPlaceholder() {
  if (placeholderImage) {
    drawFrame(placeholderImage);
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    forceNextKeyframe = true;
  }
}

async function loadPlaceholderImage(url) {
  if (!url) throw new Error("Video placeholder image URL is missing.");
  if (!("createImageBitmap" in self)) throw new Error("createImageBitmap is not available in worker.");
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Video placeholder image failed to load: ${response.status}`);
  const image = await createImageBitmap(await response.blob());
  if (closed || url !== placeholderImageUrl) {
    try { image.close(); } catch (_) {}
    return;
  }
  if (placeholderImage) {
    try { placeholderImage.close(); } catch (_) {}
  }
  placeholderImage = image;
  forceNextKeyframe = true;
}

function submitFrame(timestamp) {
  if (!encoder || encoder.state !== "configured") return;
  if (encoder.encodeQueueSize > 2) {
    dropped++;
    return;
  }

  let frame = null;
  try {
    frame = new VideoFrame(canvas, { timestamp, duration: framePeriodUs });
    const keyFrame = forceNextKeyframe
      || timestamp - lastKeyframeTimestampUs >= keyframeInterval * framePeriodUs;
    forceNextKeyframe = false;
    encoder.encode(frame, { keyFrame });
    if (keyFrame) lastKeyframeTimestampUs = timestamp;
    submitted++;
  } finally {
    if (frame) frame.close();
  }
}

function encodeLatest() {
  if (closed) return;
  const now = performance.now();
  const missedFrames = Math.max(0, Math.floor((now - nextEncodeAt) / framePeriodMs));
  nextEncodeAt += missedFrames * framePeriodMs;
  nextTimestampUs += missedFrames * framePeriodUs;
  dropped += missedFrames;

  try {
    if (latestFrame && !placeholder) drawFrame(latestFrame);
    else drawPlaceholder();
    submitFrame(nextTimestampUs);
  } catch (error) {
    fail(error);
    return;
  }

  nextEncodeAt += framePeriodMs;
  nextTimestampUs += framePeriodUs;
  timer = setTimeout(encodeLatest, Math.max(0, nextEncodeAt - performance.now()));
}

function startEncoderLoop() {
  if (timer || closed) return;
  nextEncodeAt = performance.now() + framePeriodMs;
  timer = setTimeout(encodeLatest, framePeriodMs);
}

function setLatestFrame(frame) {
  sourceFrames++;
  const previous = latestFrame;
  latestFrame = frame;
  if (previous) previous.close();
  placeholder = false;
  startEncoderLoop();
  postMessage({ type: "frame" });
}

function closeLatestFrame() {
  if (!latestFrame) return;
  try { latestFrame.close(); } catch (_) {}
  latestFrame = null;
}

function usePlaceholder() {
  closeLatestFrame();
  placeholder = true;
  forceNextKeyframe = true;
  startEncoderLoop();
}

function postStats() {
  const now = performance.now();
  const elapsed = Math.max((now - lastStatsAt) / 1000, 0.001);
  const encodedDelta = encoded - lastEncoded;
  const sourceDelta = sourceFrames - lastSourceFrames;
  const byteDelta = encodedBytes - lastEncodedBytes;
  lastStatsAt = now;
  lastEncoded = encoded;
  lastSourceFrames = sourceFrames;
  lastEncodedBytes = encodedBytes;
  postMessage({
    type: "stats",
    stats: {
      submitted,
      encoded,
      dropped,
      sourceFrames,
      fps: encodedDelta / elapsed,
      sourceFps: sourceDelta / elapsed,
      kbps: (byteDelta * 8 / 1000) / elapsed,
      queue: encoder ? encoder.encodeQueueSize : 0
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
    bitrateMode: "constant",
    framerate: nextFps,
    hardwareAcceleration: "prefer-hardware",
    latencyMode: "realtime",
    contentHint: "motion",
    avc: { format: "annexb" }
  };
}

async function assertEncoderSupport(nextConfig) {
  if (!VideoEncoder.isConfigSupported) return;
  const support = await VideoEncoder.isConfigSupported(nextConfig);
  if (!support.supported) {
    throw new Error(`Native H.264 WebCodecs ${nextConfig.width}x${nextConfig.height}@${nextConfig.framerate} is not supported.`);
  }
}

function createEncoder(nextConfig) {
  const next = new VideoEncoder({
    output(chunk, metadata) {
      if (closed) return;
      const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
      avcHeader = avcDescriptionToAnnexB(description) || avcHeader;
      encoded++;
      sendVideoPacket(chunk, avcHeader);
    },
    error(error) {
      if (!closed) fail(error);
    }
  });
  next.configure(nextConfig);
  return next;
}

async function reconfigure(message) {
  const nextConfig = encoderConfig(message.width, message.height, message.fps, message.bitrate);
  try {
    await assertEncoderSupport(nextConfig);
    clearTimeout(timer);
    timer = 0;
    await encoder.flush();
    encoder.close();
    avcHeader = null;
    encoder = createEncoder(nextConfig);

    width = message.width;
    height = message.height;
    fps = message.fps;
    bitrate = message.bitrate;
    keyframeInterval = message.keyframeInterval;
    framePeriodMs = 1000 / fps;
    framePeriodUs = message.framePeriodUs;
    canvas.width = width;
    canvas.height = height;
    nextEncodeAt = performance.now() + framePeriodMs;
    lastKeyframeTimestampUs = nextTimestampUs - keyframeInterval * framePeriodUs;
    forceNextKeyframe = true;
    postMessage({ type: "reconfigured" });
  } catch (error) {
    startEncoderLoop();
    postMessage({
      type: "reconfigure-error",
      message: error && error.message ? error.message : String(error)
    });
  }
}

async function init(message) {
  closeAll();
  closed = false;
  width = message.width;
  height = message.height;
  fps = message.fps;
  bitrate = message.bitrate;
  keyframeInterval = message.keyframeInterval;
  framePeriodMs = 1000 / Math.max(1, fps);
  framePeriodUs = message.framePeriodUs;
  nextEncodeAt = 0;
  nextTimestampUs = 0;
  lastKeyframeTimestampUs = -keyframeInterval * framePeriodUs;
  submitted = 0;
  encoded = 0;
  dropped = 0;
  sourceFrames = 0;
  encodedBytes = 0;
  lastStatsAt = performance.now();
  lastEncoded = 0;
  lastSourceFrames = 0;
  lastEncodedBytes = 0;
  avcHeader = null;
  forceNextKeyframe = false;
  placeholder = true;
  placeholderImageUrl = message.placeholderUrl || "";

  if (!("VideoEncoder" in self) || !("VideoFrame" in self)) {
    throw new Error("Native H.264 WebCodecs video encoder is not available in worker.");
  }
  if (!("OffscreenCanvas" in self)) {
    throw new Error("OffscreenCanvas is not available in worker.");
  }
  const config = encoderConfig(width, height, fps, bitrate);
  await assertEncoderSupport(config);

  canvas = new OffscreenCanvas(width, height);
  ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) throw new Error("OffscreenCanvas 2D context is not available.");

  encoder = createEncoder(config);

  await loadPlaceholderImage(placeholderImageUrl);
  forceNextKeyframe = true;
  statsTimer = setInterval(postStats, 1000);
  postMessage({ type: "ready" });
}

function closeAll() {
  closed = true;
  clearTimeout(timer);
  clearInterval(statsTimer);
  timer = 0;
  statsTimer = 0;
  closeLatestFrame();
  if (placeholderImage) {
    try { placeholderImage.close(); } catch (_) {}
    placeholderImage = null;
  }
  if (encoder) {
    try { encoder.close(); } catch (_) {}
    encoder = null;
  }
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === "init") {
    init(message).catch(fail);
  } else if (message.type === "frame" && message.frame && !closed) {
    setLatestFrame(message.frame);
  } else if (message.type === "placeholder" && !closed) {
    usePlaceholder();
  } else if (message.type === "keyframe" && !closed) {
    forceNextKeyframe = true;
  } else if (message.type === "reconfigure" && !closed) {
    reconfigure(message);
  } else if (message.type === "resume" && !closed) {
    forceNextKeyframe = true;
    startEncoderLoop();
  } else if (message.type === "close") {
    closeAll();
  }
};
