let track = null;
let reader = null;
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
let readToken = 0;
let width = 1280;
let height = 720;
let fps = 30;
let bitrate = 2500000;
let keyframeInterval = 60;
let framePeriodMs = 1000 / 30;
let framePeriodUs = 33333;
let nextEncodeAt = 0;
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
    out.set([0, 0, 0, 1], write);
    write += 4;
    out.set(part, write);
    write += part.byteLength;
  }
  return out;
}

function sendVideoPacket(chunk, header) {
  const headerLength = chunk.type === "key" && header ? header.byteLength : 0;
  const packet = new Uint8Array(chunk.byteLength + headerLength + 1);
  packet[0] = chunk.type === "key" ? 0x01 : 0x02;
  if (headerLength) packet.set(header, 1);
  chunk.copyTo(packet.subarray(1 + headerLength));
  encodedBytes += packet.byteLength - 1;
  postMessage({ type: "packet", packet: packet.buffer }, [packet.buffer]);
}

function drawFrame(frame) {
  const srcWidth = frame.displayWidth || frame.codedWidth || width;
  const srcHeight = frame.displayHeight || frame.codedHeight || height;
  const scale = Math.min(width / srcWidth, height / srcHeight);
  const drawWidth = Math.max(1, Math.round(srcWidth * scale));
  const drawHeight = Math.max(1, Math.round(srcHeight * scale));
  const x = Math.floor((width - drawWidth) / 2);
  const y = Math.floor((height - drawHeight) / 2);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(frame, x, y, drawWidth, drawHeight);
}

function drawPlaceholder() {
  if (placeholderImage) {
    ctx.drawImage(placeholderImage, 0, 0, width, height);
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

function encodeLatest() {
  if (closed) return;
  try {
    if (encoder && encoder.state === "configured") {
      if (encoder.encodeQueueSize > 2) {
        dropped++;
      } else {
        if (latestFrame && !placeholder) drawFrame(latestFrame);
        else drawPlaceholder();
        let frame = null;
        try {
          frame = new VideoFrame(canvas, {
            timestamp: submitted * framePeriodUs,
            duration: framePeriodUs
          });
          const keyFrame = forceNextKeyframe || submitted % keyframeInterval === 0;
          forceNextKeyframe = false;
          submitted++;
          encoder.encode(frame, { keyFrame });
        } finally {
          if (frame) frame.close();
        }
      }
    }
  } catch (error) {
    fail(error);
    return;
  }

  const now = performance.now();
  do {
    nextEncodeAt += framePeriodMs;
  } while (nextEncodeAt <= now);
  timer = setTimeout(encodeLatest, nextEncodeAt - now);
}

async function readFrames(token) {
  try {
    while (!closed) {
      if (token !== readToken) break;
      const { done, value } = await reader.read();
      if (token !== readToken) {
        if (value) value.close();
        break;
      }
      if (done || !value) break;
      sourceFrames++;
      const previous = latestFrame;
      latestFrame = value;
      if (previous) previous.close();
      placeholder = false;
    }
  } catch (error) {
    if (!closed && token === readToken) fail(error);
  }
}

function setLatestFrame(frame) {
  sourceFrames++;
  const previous = latestFrame;
  latestFrame = frame;
  if (previous) previous.close();
  placeholder = false;
  postMessage({ type: "frame" });
}

function closeReader() {
  readToken++;
  if (reader) {
    try { reader.cancel(); } catch (_) {}
    try { reader.releaseLock(); } catch (_) {}
    reader = null;
  }
  if (track) {
    try { track.stop(); } catch (_) {}
    track = null;
  }
}

function closeLatestFrame() {
  if (latestFrame) {
    try { latestFrame.close(); } catch (_) {}
    latestFrame = null;
  }
}

function usePlaceholder() {
  closeReader();
  closeLatestFrame();
  placeholder = true;
  forceNextKeyframe = true;
}

function useTrack(nextTrack) {
  if (!nextTrack) throw new Error("Video track is missing.");
  if (!("MediaStreamTrackProcessor" in self)) {
    throw new Error("MediaStreamTrackProcessor is not available in worker.");
  }
  closeReader();
  closeLatestFrame();
  placeholder = true;
  forceNextKeyframe = true;
  track = nextTrack;
  const processor = new MediaStreamTrackProcessor({ track });
  reader = processor.readable.getReader();
  const token = ++readToken;
  readFrames(token);
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

async function init(message) {
  closeAll();
  closed = false;
  const initialTrack = message.track;
  track = null;
  width = message.width;
  height = message.height;
  fps = message.fps;
  bitrate = message.bitrate;
  keyframeInterval = message.keyframeInterval;
  framePeriodMs = 1000 / Math.max(1, fps);
  framePeriodUs = message.framePeriodUs;
  nextEncodeAt = performance.now() + framePeriodMs;
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
  placeholder = !initialTrack;
  placeholderImageUrl = message.placeholderUrl || "";
  readToken = 0;

  if (!("VideoEncoder" in self) || !("VideoFrame" in self)) {
    throw new Error("Native H.264 WebCodecs video encoder is not available in worker.");
  }
  if (!("OffscreenCanvas" in self)) {
    throw new Error("OffscreenCanvas is not available in worker.");
  }
  const config = {
    codec: "avc1.42E01F",
    width,
    height,
    bitrate,
    framerate: fps,
    latencyMode: "realtime",
    avc: { format: "annexb" }
  };
  if (VideoEncoder.isConfigSupported) {
    const support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported) throw new Error("Native H.264 WebCodecs 720p30 is not supported.");
  }

  canvas = new OffscreenCanvas(width, height);
  ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) throw new Error("OffscreenCanvas 2D context is not available.");

  encoder = new VideoEncoder({
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
  encoder.configure(config);

  await loadPlaceholderImage(placeholderImageUrl);
  if (initialTrack) useTrack(initialTrack);
  else forceNextKeyframe = true;
  timer = setTimeout(encodeLatest, Math.max(0, nextEncodeAt - performance.now()));
  statsTimer = setInterval(postStats, 1000);
  postMessage({ type: "ready" });
}

function closeAll() {
  closed = true;
  clearTimeout(timer);
  clearInterval(statsTimer);
  timer = 0;
  statsTimer = 0;
  closeReader();
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
  } else if (message.type === "track" && message.track && !closed) {
    try { useTrack(message.track); } catch (error) { fail(error); }
  } else if (message.type === "placeholder" && !closed) {
    usePlaceholder();
  } else if (message.type === "close") {
    closeAll();
  }
};
