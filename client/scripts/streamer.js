export function createStreamer(app) {
  const config = app.config;
  const ui = app.ui;
  const assetVersion = new URL(import.meta.url).search;
  const audioWorkletUrl = new URL(`audio-worklet.js${assetVersion}`, import.meta.url);
  const aacWorkerUrl = new URL(`aac-worker.js${assetVersion}`, import.meta.url);
  const videoWorkerUrl = new URL(`video-worker.js${assetVersion}`, import.meta.url);
  const videoPlaceholderUrl = new URL(`static/live-placeholder-1080.webp${assetVersion}`, location.href).href;
  const maxAudioSwapBufferBlocks = 32;
  const audioSwapFlushTimeoutMs = 2000;

async function requestScreenWakeLock() {
  if (!("wakeLock" in navigator)) return null;
  try {
    const wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      if (app.active && app.active.wakeLock === wakeLock) app.active.wakeLock = null;
    });
    return wakeLock;
  } catch (_) {
    return null;
  }
}

async function refreshScreenWakeLock() {
  if (!app.active || document.visibilityState !== "visible") return;
  if (app.active.wakeLock && !app.active.wakeLock.released) return;
  const wakeLock = await requestScreenWakeLock();
  if (app.active && wakeLock) app.active.wakeLock = wakeLock;
}

function setMediaSessionPlaying(playing) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = playing ? "playing" : "none";
  } catch (_) {}
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

function displayMediaOptions(video, audio) {
  return {
    video,
    audio,
    systemAudio: "include",
    windowAudio: "window",
    surfaceSwitching: "include",
    selfBrowserSurface: "exclude"
  };
}

async function captureAudio(kind, deviceIdOverride = null) {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    sampleRate: config.sampleRate
  };
  if (kind === "screen") {
    const video = {
      width: { ideal: config.videoWidth },
      height: { ideal: config.videoHeight },
      frameRate: { ideal: config.videoCaptureFps, max: config.videoCaptureFps }
    };
    return await getDisplayMediaCompat(displayMediaOptions(video, audio), [
      { video, audio: true },
      { video: true, audio: true }
    ]);
  }
  const deviceId = deviceIdOverride ?? ui.els.micDeviceEl.value;
  if (!deviceId) return await navigator.mediaDevices.getUserMedia({ video: false, audio });

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { ...audio, deviceId: { exact: deviceId } }
    });
  } catch (error) {
    if (!isMissingAudioDeviceError(error)) throw error;
    ui.saveMicDeviceSelection("");
    return await navigator.mediaDevices.getUserMedia({ video: false, audio });
  }
}

async function captureVideo() {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    sampleRate: config.sampleRate
  };
  const video = {
    width: { ideal: config.videoWidth },
    height: { ideal: config.videoHeight },
    frameRate: { ideal: config.videoCaptureFps, max: config.videoCaptureFps }
  };
  return await getDisplayMediaCompat(displayMediaOptions(video, audio), [
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

function stopMediaStream(mediaStream) {
  if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
}

async function createCaptureNode(audioContext, onBlock) {
  await audioContext.audioWorklet.addModule(audioWorkletUrl);

  const node = new AudioWorkletNode(audioContext, "capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      frames: config.framesPerChunk,
      channels: config.channels
    }
  });
  node.port.onmessage = event => onBlock(event.data);
  return node;
}

function createAacEncoder(encoderMode, onPacket, onError) {
  const worker = new Worker(aacWorkerUrl, { type: "module" });
  let closed = false;
  let readySettled = false;
  let rejectReady = null;
  let flushPromise = null;
  let resolveFlush = null;
  let rejectFlush = null;
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

  function settleFlush(error = null) {
    if (error) {
      if (rejectFlush) rejectFlush(error);
    } else if (resolveFlush) {
      resolveFlush();
    }
    flushPromise = null;
    resolveFlush = null;
    rejectFlush = null;
  }

  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
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
      } else if (message.type === "flushed") {
        settleFlush();
      } else if (message.type === "error") {
        const error = new Error(message.message || "AAC worker failed.");
        if (!readySettled) {
          readySettled = true;
          reject(error);
        }
        settleFlush(error);
        onError(error);
      }
    };
    worker.onerror = event => {
      const error = new Error(event.message || "AAC worker failed.");
      if (!readySettled) {
        readySettled = true;
        reject(error);
      }
      settleFlush(error);
      onError(error);
    };
    worker.postMessage({
      type: "init",
      sampleRate: config.sampleRate,
      channels: config.channels,
      bitrate: encoderMode.bitrate,
      expectedAacConfigHex: config.expectedAacConfigHex,
      nativeAacBitrates: encoderMode.nativeAacBitrates,
      preferNative: encoderMode.preferNative,
      allowWasmFallback: encoderMode.allowWasmFallback,
      rtpTimestampBase: 0
    });
  });

  return {
    ready,
    encode(buffer) {
      if (closed) return;
      pcmBlocks++;
      worker.postMessage({ type: "encode", pcm: buffer }, [buffer]);
    },
    close() {
      if (closed) return;
      closed = true;
      const error = new Error("AAC encoder closed.");
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      settleFlush(error);
      try { worker.postMessage({ type: "close" }); } catch (_) {}
      worker.terminate();
    },
    flush() {
      if (closed) return Promise.reject(new Error("AAC encoder is closed."));
      if (flushPromise) return flushPromise;
      flushPromise = new Promise((resolve, reject) => {
        resolveFlush = resolve;
        rejectFlush = reject;
        worker.postMessage({ type: "flush" });
      });
      return flushPromise;
    },
    setTimestamp(value) {
      if (!closed) worker.postMessage({ type: "timestamp", value: value >>> 0 });
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

function sendAudioPacket(session, encoder, packet) {
  if (!session
      || app.active !== session
      || session.encoder !== encoder
      || session.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  if (session.ws.bufferedAmount > config.maxAudioWsBufferedBytes) {
    failActive();
    return;
  }
  session.ws.send(packet);
  session.nextAudioTimestamp = (
    session.nextAudioTimestamp + config.framesPerChunk
  ) >>> 0;
}

function handleAacEncoderError(session, encoder, error) {
  if (!session || app.active !== session) return;
  if (session.encoder === encoder) {
    failActive();
    return;
  }
  const swap = session.audioEncoderSwap;
  if (!swap || swap.encoder !== encoder) return;
  if (swap.draining) {
    failActive();
    return;
  }
  session.audioEncoderSwap = null;
  encoder.close();
  swap.reject(error);
}

function encodeAudioBlock(session, buffer) {
  if (!session || app.active !== session) return;
  const swap = session.audioEncoderSwap;
  if (swap) {
    if (swap.buffers.length >= maxAudioSwapBufferBlocks) {
      failActive();
      return;
    }
    swap.buffers.push(buffer);
    if (!swap.draining) {
      swap.draining = true;
      completeAudioEncoderSwap(session, swap);
    }
    return;
  }

  const encoder = session.encoder;
  if (encoder.lagFrames() > 128) {
    failActive();
    return;
  }
  encoder.encode(buffer);
}

async function completeAudioEncoderSwap(session, swap) {
  const previous = session.encoder;
  try {
    await withTimeout(
      previous.flush(),
      audioSwapFlushTimeoutMs,
      "AAC encoder flush timeout"
    );
    if (app.active !== session || session.audioEncoderSwap !== swap) {
      throw new Error("AAC encoder swap cancelled.");
    }

    swap.encoder.setTimestamp(session.nextAudioTimestamp);
    session.encoder = swap.encoder;
    session.encoderModeKey = swap.modeKey;
    session.audioEncoderSwap = null;
    previous.close();
    for (const buffer of swap.buffers) session.encoder.encode(buffer);
    swap.buffers.length = 0;
    swap.resolve(swap.info);
  } catch (error) {
    swap.encoder.close();
    swap.reject(error);
    if (app.active === session) failActive();
  }
}

async function replaceAudioEncoder() {
  const session = app.active;
  if (!session) return null;
  const modeKey = app.selectedEncoderModeKey();
  if (modeKey === session.encoderModeKey) return session.encoder.stats();
  if (session.preparingAudioEncoder || session.audioEncoderSwap) {
    throw new Error("AAC encoder swap is already running.");
  }

  let nextEncoder = null;
  const mode = app.selectedEncoderMode();
  nextEncoder = createAacEncoder(
    mode,
    packet => sendAudioPacket(session, nextEncoder, packet),
    error => handleAacEncoderError(session, nextEncoder, error)
  );
  session.preparingAudioEncoder = nextEncoder;

  let info;
  try {
    info = await withTimeout(nextEncoder.ready, 10000, "AAC encoder initialization timeout");
  } catch (error) {
    nextEncoder.close();
    throw error;
  } finally {
    if (session.preparingAudioEncoder === nextEncoder) session.preparingAudioEncoder = null;
  }

  if (app.active !== session) {
    nextEncoder.close();
    throw new Error("AAC encoder swap cancelled.");
  }

  return await new Promise((resolve, reject) => {
    session.audioEncoderSwap = {
      encoder: nextEncoder,
      modeKey,
      info,
      buffers: [],
      draining: false,
      resolve,
      reject
    };
  });
}

function createVideoWorker(ws, onError) {
  const worker = new Worker(videoWorkerUrl);
  let closed = false;
  let framePending = false;
  let readySettled = false;
  let pendingReconfigure = null;
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
      if (pendingReconfigure) {
        pendingReconfigure.reject(error);
        pendingReconfigure = null;
      }
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
        if (closed || !app.active || app.active.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > config.maxVideoWsBufferedBytes) {
          failReady(new Error("Network video queue is too slow; stopped video."));
          return;
        }
        ws.send(message.packet);
      } else if (message.type === "stats") {
        latestStats = message.stats || latestStats;
      } else if (message.type === "reconfigured" && pendingReconfigure) {
        const pending = pendingReconfigure;
        pendingReconfigure = null;
        try {
          if (ws.readyState !== WebSocket.OPEN) throw new Error("Streamer WebSocket is closed.");
          ws.send(`video_quality:${pending.qualityIndex}`);
          ws.send("video_reset");
          worker.postMessage({ type: "resume" });
          pending.resolve();
        } catch (error) {
          pending.reject(error);
        }
      } else if (message.type === "reconfigure-error" && pendingReconfigure) {
        pendingReconfigure.reject(new Error(message.message || "Video reconfigure failed."));
        pendingReconfigure = null;
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
    init() {
      worker.postMessage({
        type: "init",
        width: config.videoWidth,
        height: config.videoHeight,
        fps: config.videoFps,
        bitrate: config.videoBitrate,
        keyframeInterval: config.videoKeyframeInterval,
        framePeriodUs: config.videoFramePeriodUs,
        placeholderUrl: videoPlaceholderUrl
      });
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
    placeholder() {
      worker.postMessage({ type: "placeholder" });
    },
    forceKeyframe() {
      if (!closed) worker.postMessage({ type: "keyframe" });
    },
    reconfigure(options) {
      if (closed) return Promise.reject(new Error("Video worker is closed."));
      if (pendingReconfigure) return Promise.reject(new Error("Video reconfigure is already running."));
      return new Promise((resolve, reject) => {
        pendingReconfigure = { resolve, reject, qualityIndex: options.qualityIndex };
        worker.postMessage({ type: "reconfigure", ...options });
      });
    },
    close() {
      closed = true;
      if (pendingReconfigure) {
        pendingReconfigure.reject(new Error("Video worker is closed."));
        pendingReconfigure = null;
      }
      try { worker.postMessage({ type: "close" }); } catch (_) {}
      worker.terminate();
    },
    stats() {
      return latestStats;
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

function videoConstraints(width, height, fps) {
  return {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: fps, max: fps }
  };
}

async function createVideoStreamer(source, ws, onError) {
  if (!window.Worker) throw new Error("Video workers are not available.");
  if (!("MediaStreamTrackProcessor" in window)) {
    throw new Error("MediaStreamTrackProcessor is not available on main thread.");
  }
  if (!source || !source.mediaStream.getVideoTracks()[0]) {
    throw new Error("Selected source has no video track.");
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
    const replacingSource = currentSource !== null;
    clearStopTimer();
    closeReader();
    currentSource = nextSource;
    if (replacingSource) worker.placeholder();
    workerTrack = track.clone();
    try { workerTrack.contentHint = "motion"; } catch (_) {}
    const processor = new MediaStreamTrackProcessor({ track: workerTrack });
    reader = processor.readable.getReader();
    readFrames(++readToken);
  };

  try {
    try {
      await source.mediaStream.getVideoTracks()[0].applyConstraints(
        videoConstraints(config.videoWidth, config.videoHeight, config.videoFps)
      );
    } catch (_) {}
    worker.init();
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
      forceKeyframe() {
        worker.forceKeyframe();
      },
      async reconfigure(options) {
        const constraints = videoConstraints(options.width, options.height, options.fps);
        const sourceTrack = currentSource && currentSource.mediaStream.getVideoTracks()[0];
        const tracks = [sourceTrack, workerTrack].filter(Boolean);
        await Promise.allSettled(tracks.map(track => track.applyConstraints(constraints)));
        await worker.reconfigure(options);
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

function sendStreamerCommand(command) {
  if (!app.active || app.active.ws.readyState !== WebSocket.OPEN) return;
  try { app.active.ws.send(command); } catch (_) {}
}

function stopActiveVideo(source = null) {
  if (!app.active || !app.active.video) return;
  if (source && app.active.video.source !== source) return;
  clearTimeout(app.active.video.stopTimer);
  app.active.video.close();
  app.active.video = null;
  sendStreamerCommand("video_stop");
}

function showActiveVideoPlaceholder(source = null) {
  if (!app.active || !app.active.video) return;
  if (source && app.active.video.source !== source) return;
  const video = app.active.video;
  clearTimeout(video.stopTimer);
  video.placeholder();
  video.stopTimer = setTimeout(() => {
    if (!app.active || app.active.video !== video || app.active.sources.video) return;
    stopActiveVideo();
    ui.updateStreamStatus();
  }, config.videoPlaceholderHoldMs);
}

function disposeVideoSource(source, stopStream = true, holdVideo = true) {
  if (!source) return;
  if (app.active && app.active.video && app.active.video.source === source) {
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
  if (!app.active || app.active.sources.video !== source) return;
  app.active.sources.video = null;
  disposeVideoSource(source);
  ui.updateSourceControls();
  ui.updateStreamStatus();
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
  if (!app.active || app.active.sources[kind] !== source) return;
  app.active.sources[kind] = null;
  disposeAudioSource(source);
  ui.updateSourceControls();
  ui.updateStreamStatus();
}

function installAudioSource(kind, mediaStream, deviceId = kind === "mic" ? ui.els.micDeviceEl.value : "", settings = null) {
  if (!app.active) {
    stopMediaStream(mediaStream);
    return;
  }
  const replacedVideo = kind === "screen" ? app.active.sources.video : null;
  if (replacedVideo) app.active.sources.video = null;

  const node = app.active.audioContext.createMediaStreamSource(mediaStream);
  const processor = new AudioWorkletNode(app.active.audioContext, "source-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  const next = {
    kind,
    name: ui.sourceDisplayName(kind, mediaStream),
    deviceId,
    mediaStream,
    node,
    processor
  };
  ui.createSourceBlock(next);
  processor.port.onmessage = event => {
    const message = event.data;
    if (message && message.type === "level") ui.updateSourceLevel(next, message.peak);
  };
  const initialSettings = settings
    ? ui.normalizeRuntimeSourceSettings(kind, settings)
    : ui.normalizeRuntimeSourceSettings(kind, ui.loadSourceSettings(kind));
  next.gainEl.value = String(initialSettings.gain);
  next.muteEl.checked = Boolean(initialSettings.mute);
  next.monoEl.checked = Boolean(initialSettings.forceMono);
  applyAudioSourceSettings(next);
  ui.saveSourceSettings(next);

  const previous = app.active.sources[kind];
  app.active.sources[kind] = next;

  node.connect(processor);
  processor.connect(app.active.mixer);
  if (previous && previous.block && previous.block.parentNode) {
    previous.block.replaceWith(next.block);
  } else if (replacedVideo && replacedVideo.block && replacedVideo.block.parentNode) {
    replacedVideo.block.replaceWith(next.block);
  } else {
    ui.els.sourcesEl.appendChild(next.block);
  }
  if (previous) disposeAudioSource(previous);
  if (replacedVideo) disposeVideoSource(replacedVideo);

  mediaStream.getAudioTracks().forEach(track => {
    track.addEventListener("ended", () => removeAudioSource(kind, next), { once: true });
  });

  ui.updateSourceControls();
  ui.updateStreamStatus();
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
    try { await ui.refreshMicDevices(ui.els.micDeviceEl.value); } catch (_) {}
  }
  return mediaStream;
}

async function requestVideoSource() {
  if (!app.serverVideoEnabled()) throw new Error("Video is disabled on this server.");
  const mediaStream = await withTimeout(
    captureVideo(),
    45000,
    "Timed out waiting for browser video selection."
  );
  if (mediaStream.getVideoTracks().length === 0) {
    stopMediaStream(mediaStream);
    throw new Error("No video track selected");
  }
  try { mediaStream.getVideoTracks()[0].contentHint = "motion"; } catch (_) {}
  return mediaStream;
}

async function installVideoSource(mediaStream, settings = null) {
  if (!app.active) {
    stopMediaStream(mediaStream);
    return;
  }
  if (!app.serverVideoEnabled()) {
    stopMediaStream(mediaStream);
    throw new Error("Video is disabled on this server.");
  }
  const hasAudio = mediaStream.getAudioTracks().length > 0;

  const next = {
    kind: "video",
    name: ui.sourceDisplayName("video", mediaStream),
    mediaStream,
    hasAudio,
    videoHidden: false,
    node: null,
    processor: null
  };
  if (hasAudio) {
    next.node = app.active.audioContext.createMediaStreamSource(mediaStream);
    next.processor = new AudioWorkletNode(app.active.audioContext, "source-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
  }
  ui.createSourceBlock(next);
  if (hasAudio) {
    next.processor.port.onmessage = event => {
      const message = event.data;
      if (message && message.type === "level") ui.updateSourceLevel(next, message.peak);
    };
    const initialSettings = settings
      ? ui.normalizeRuntimeSourceSettings("video", settings)
      : ui.normalizeRuntimeSourceSettings("video", ui.loadSourceSettings("video"));
    next.gainEl.value = String(initialSettings.gain);
    next.muteEl.checked = Boolean(initialSettings.mute);
  }
  ui.updateSourceVideoPreview(next);
  applyAudioSourceSettings(next);
  ui.saveSourceSettings(next);

  const replacedScreen = app.active.sources.screen;
  if (replacedScreen) app.active.sources.screen = null;
  const previous = app.active.sources.video;
  app.active.sources.video = next;
  if (hasAudio) {
    next.node.connect(next.processor);
    next.processor.connect(app.active.mixer);
  }
  if (previous && previous.block && previous.block.parentNode) {
    previous.block.replaceWith(next.block);
  } else if (replacedScreen && replacedScreen.block && replacedScreen.block.parentNode) {
    replacedScreen.block.replaceWith(next.block);
  } else {
    ui.els.sourcesEl.appendChild(next.block);
  }
  let videoStartSent = false;
  try {
    if (app.active.video) {
      app.active.video.setSource(next);
    } else {
      sendStreamerCommand("video_start");
      videoStartSent = true;
      app.active.video = await createVideoStreamer(next, app.active.ws, error => {
        if (!app.active) return;
        removeVideoSource(next);
      });
    }
  } catch (error) {
    if (videoStartSent) sendStreamerCommand("video_stop");
    if (app.active && app.active.sources.video === next) app.active.sources.video = null;
    disposeVideoSource(next, true, false);
    throw error;
  }

  if (previous) disposeVideoSource(previous, true, false);
  if (replacedScreen) disposeAudioSource(replacedScreen);

  mediaStream.getTracks().forEach(track => {
    track.addEventListener("ended", () => removeVideoSource(next), { once: true });
  });

  ui.updateSourceControls();
  ui.updateStreamStatus();
}

async function addOrReplaceSource(kind, deviceId = null, settings = null, mediaStreamOverride = null) {
  if (!app.active || app.sourceRequestInFlight) return;
  if ((kind === "screen" || kind === "video") && ui.systemCaptureDisabled()) {
    ui.showSystemSourceHint(kind);
    return;
  }

  let mediaStream = mediaStreamOverride;
  ui.setSourceRequestBusy(true);
  try {
    if (!mediaStream) {
      mediaStream = kind === "video"
        ? await requestVideoSource()
        : await requestAudioSource(kind, deviceId);
    }
    if (!app.active) {
      stopMediaStream(mediaStream);
      return;
    }
    if (kind === "video") {
      await installVideoSource(mediaStream, settings);
    } else {
      installAudioSource(kind, mediaStream, deviceId ?? undefined, settings);
    }
    mediaStream = null;
    ui.updateStreamStatus();
  } catch {
  } finally {
    stopMediaStream(mediaStream);
    ui.setSourceRequestBusy(false);
  }
}

async function start(kind, deviceId = null, settings = null, mediaStreamOverride = null) {
  if ((kind === "screen" || kind === "video") && ui.systemCaptureDisabled()) {
    ui.showSystemSourceHint(kind);
    return;
  }
  if (app.active) {
    await addOrReplaceSource(kind, deviceId, settings, mediaStreamOverride);
    return;
  }
  if (app.sourceRequestInFlight) return;

  const code = app.streamCode;
  if (code.length !== config.streamCodeLength) {
    return;
  }

  let mediaStream = mediaStreamOverride;
  let audioContext = null;
  let ws = null;
  let encoder = null;
  let session = null;
  let pendingStreamListeners = 0;
  let pendingVideoKeyframe = false;
  let resolveHello = null;
  let helloReceived = false;
  const helloReady = new Promise(resolve => { resolveHello = resolve; });
  ui.setSourceRequestBusy(true);
  try {
    if (!mediaStream) {
      mediaStream = kind === "video"
        ? await requestVideoSource()
        : await requestAudioSource(kind, deviceId);
    }

    encoder = createAacEncoder(
      app.selectedEncoderMode(),
      packet => sendAudioPacket(session, encoder, packet),
      error => handleAacEncoderError(session, encoder, error)
    );
    let encoderReadyError = null;
    const encoderReady = encoder.ready.catch(error => {
      encoderReadyError = error;
      return null;
    });
    const encoderInfo = await encoderReady;
    if (encoderReadyError) throw encoderReadyError;

    const server = app.selectedServer();
    const serverInfoKey = app.serverKey(server);
    ws = new WebSocket(app.wsUrlForCode(code, server));
    ws.binaryType = "arraybuffer";
    ws.onmessage = event => app.handleStreamerMessage(
      event,
      serverInfoKey,
      listeners => {
        pendingStreamListeners = listeners;
        if (app.active && app.active.ws === ws) {
          app.active.streamListeners = listeners;
          ui.updateStreamStatus();
        }
      },
      () => {
        const video = app.active && app.active.ws === ws ? app.active.video : null;
        if (video) video.forceKeyframe();
        else pendingVideoKeyframe = true;
      },
      (message, quality) => {
        if (helloReceived) return;
        helloReceived = true;
        resolveHello({ message, quality });
      }
    );
    await app.waitForOpen(ws);
    const hello = await withTimeout(helloReady, 10000, "Streamer hello timeout");
    if (hello.message.video && hello.quality && Array.isArray(hello.message.video_qualities)) {
      ws.send(`video_quality:${hello.quality.index}`);
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: "interactive", sampleRate: config.sampleRate });
    if (audioContext.sampleRate !== config.sampleRate) {
      throw new Error(`AudioContext returned ${audioContext.sampleRate} Hz, expected ${config.sampleRate} Hz.`);
    }

    const captureNode = await createCaptureNode(audioContext, buffer => {
      encodeAudioBlock(session, buffer);
    });
    const mixer = audioContext.createGain();
    mixer.channelCount = config.channels;
    mixer.channelCountMode = "explicit";
    mixer.channelInterpretation = "speakers";
    const monitor = audioContext.createGain();
    monitor.gain.value = config.monitorOutputGain;
    const wakeLock = await requestScreenWakeLock();
    setMediaSessionPlaying(true);

    session = {
      audioContext,
      ws,
      encoder,
      encoderModeKey: app.selectedEncoderModeKey(),
      nextAudioTimestamp: 0,
      preparingAudioEncoder: null,
      audioEncoderSwap: null,
      video: null,
      mixer,
      captureNode,
      monitor,
      wakeLock,
      statsTimer: null,
      sources: { mic: null, screen: null, video: null },
      streamListeners: pendingStreamListeners
    };
    app.active = session;

    if (kind === "video") {
      await installVideoSource(mediaStream, settings);
      if (pendingVideoKeyframe && app.active.video) {
        app.active.video.forceKeyframe();
        pendingVideoKeyframe = false;
      }
    } else {
      installAudioSource(kind, mediaStream, deviceId ?? undefined, settings);
    }
    mediaStream = null;
    mixer.connect(captureNode);
    captureNode.connect(monitor);
    monitor.connect(audioContext.destination);
    await audioContext.resume();

    ui.setStreamingControls(true);

    ws.onclose = () => {
      if (app.active && app.active.ws === ws) {
        cleanup();
      }
    };
    ws.onerror = () => {
      if (app.active && app.active.ws === ws) failActive();
    };

    ui.updateStreamStatus(encoderInfo);
    app.active.statsTimer = setInterval(() => {
      const current = app.active;
      if (!current || current.ws !== ws) return;
      ui.updateStreamStatus(current.encoder.stats());
    }, 1000);
  } catch (error) {
    console.error("Stream start failed:", error);
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
    ui.setSourceRequestBusy(false);
  }
}

function failActive() {
  cleanup();
}

function stop() {
  cleanup();
}

async function restartActiveWithCurrentSources() {
  const sources = ui.activeSourceSpecs();
  if (!app.active || sources.length === 0) return;

  cleanup({ stopStreams: false, updateControls: false });
  const first = sources[0];
  await start(first.kind, first.deviceId, first.settings, first.mediaStream);
  if (!app.active) {
    for (let i = 1; i < sources.length; i++) stopMediaStream(sources[i].mediaStream);
    return;
  }
  for (let i = 1; i < sources.length && app.active; i++) {
    const source = sources[i];
    await addOrReplaceSource(source.kind, source.deviceId, source.settings, source.mediaStream);
  }
}

function forceResync() {
  if (!app.active || app.active.ws.readyState !== WebSocket.OPEN) return false;
  app.active.ws.send("force_resync");
  return true;
}

async function setVideoQuality(quality) {
  if (!quality || !Number.isInteger(quality.index)) {
    throw new Error("Invalid video quality preset.");
  }
  const keyframeInterval = quality.fps * 2;
  const framePeriodUs = Math.round(1000000 / quality.fps);
  if (app.active && app.active.video) {
    await app.active.video.reconfigure({
      width: quality.width,
      height: quality.height,
      fps: quality.fps,
      bitrate: quality.bitrate,
      keyframeInterval,
      framePeriodUs,
      qualityIndex: quality.index
    });
  } else if (app.active) {
    sendStreamerCommand(`video_quality:${quality.index}`);
  }
  app.applyVideoQuality(quality);
  ui.updateStreamStatus();
}

function cleanup({ stopStreams = true, updateControls = true } = {}) {
  const current = app.active;
  app.active = null;
  if (updateControls) ui.setStreamingControls(false);
  if (!current) return;

  if (current.statsTimer) clearInterval(current.statsTimer);
  if (current.preparingAudioEncoder) current.preparingAudioEncoder.close();
  if (current.audioEncoderSwap) {
    const swap = current.audioEncoderSwap;
    current.audioEncoderSwap = null;
    swap.encoder.close();
    swap.reject(new Error("AAC encoder swap cancelled."));
  }
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

  function applyAudioSourceSettings(source) {
    ui.updateMuteState(source);
    if (!source.processor || !source.muteEl) return;
    ui.updateGainValue(source);
    source.processor.port.postMessage({
      type: "settings",
      gain: ui.sourceGain(source),
      mute: Boolean(source.videoHidden) || source.muteEl.checked,
      forceMono: Boolean(source.monoEl && source.monoEl.checked)
    });
  }

  function setVideoSourceHidden(source, hidden) {
    if (!source || source.kind !== "video") return;
    source.videoHidden = Boolean(hidden);
    if (source.muteEl) source.muteEl.checked = source.videoHidden;
    applyAudioSourceSettings(source);
    if (app.active && app.active.video && app.active.sources.video === source) {
      if (source.videoHidden) {
        app.active.video.placeholder();
        app.active.video.source = source;
      } else {
        app.active.video.setSource(source);
      }
    }
    ui.updateStreamStatus();
  }

  function toggleVideoSourceHidden(source) {
    setVideoSourceHidden(source, !source.videoHidden);
  }

  return {
    start,
    stop,
    forceResync,
    replaceAudioEncoder,
    setVideoQuality,
    refreshScreenWakeLock,
    addOrReplaceSource,
    removeAudioSource,
    removeVideoSource,
    applyAudioSourceSettings,
    toggleVideoSourceHidden,
    restartActiveWithCurrentSources
  };
}
