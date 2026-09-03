export function createStreamer(app) {
  const config = app.config;
  const ui = app.ui;
  const audioWorkletUrl = new URL("audio-worklet.js", import.meta.url);
  const aacWorkerUrl = new URL("aac-worker.js", import.meta.url);
  const videoWorkerUrl = new URL("video-worker.js", import.meta.url);
  const videoPlaceholderUrl = new URL("static/live-placeholder-1080.webp", location.href).href;
  const maxAudioBufferedBlocks = 6;
  const maxAudioPacketAgeSamples = config.sampleRate / 2;
  const maxAudioSendBytesPerSecond = 48000;
  const maxAudioSendBurstBytes = maxAudioSendBytesPerSecond;
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

function isMediaSelectionCancelled(error) {
  return error?.name === "AbortError" || error?.name === "NotAllowedError";
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

function videoCaptureConstraints(width, height, fps) {
  return {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: fps, max: fps }
  };
}

function audioCaptureConstraints() {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    sampleRate: config.sampleRate
  };
}

async function captureAudio(kind, deviceIdOverride = null) {
  const audio = audioCaptureConstraints();
  if (kind === "screen") {
    const video = videoCaptureConstraints(
      config.videoWidth,
      config.videoHeight,
      config.videoFps
    );
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
  const audio = audioCaptureConstraints();
  const video = videoCaptureConstraints(
    config.videoWidth,
    config.videoHeight,
    config.videoFps
  );
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

function closeWebSocket(ws, code, reason) {
  if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) return;
  try {
    ws.close(code, reason);
  } catch (_) {
    try { ws.close(); } catch (_) {}
  }
}

function createPublisherTransport(ws, onFailure) {
  let congestedAt = 0;
  let failed = false;
  let videoControl = null;
  let videoPaused = false;

  const pauseVideo = () => {
    if (!videoControl || videoPaused) return;
    videoPaused = true;
    videoControl.pause();
  };

  const resumeVideo = () => {
    if (!videoControl || !videoPaused) return;
    videoPaused = false;
    videoControl.resume();
  };

  const abort = error => {
    if (failed) return;
    failed = true;
    onFailure(error);
  };

  return {
    poll() {
      if (failed) return false;
      const now = performance.now();
      const queued = ws.bufferedAmount;
      if (queued > config.wsPauseBufferedBytes) {
        if (!congestedAt) congestedAt = now;
        pauseVideo();
      } else if (congestedAt && queued <= config.wsResumeBufferedBytes) {
        congestedAt = 0;
        resumeVideo();
      }
      if (congestedAt && now - congestedAt >= config.wsStallTimeoutMs) {
        abort(new Error(`Network upload stalled with ${Math.ceil(queued / 1024)} KB queued.`));
      }
      return !failed;
    },
    abort,
    attachVideo(control) {
      videoControl = control;
      videoPaused = false;
      if (congestedAt) pauseVideo();
    },
    detachVideo(control) {
      if (videoControl !== control) return;
      videoControl = null;
      videoPaused = false;
    },
    close() {
      failed = true;
      videoControl = null;
      videoPaused = false;
    },
    get videoPaused() {
      return videoPaused;
    },
    get congested() {
      return congestedAt !== 0;
    }
  };
}

function closeAudioContext(audioContext) {
  if (!audioContext || audioContext.state === "closed") return;
  try {
    void audioContext.close().catch(() => {});
  } catch (_) {}
}

function isSystemSource(kind) {
  return kind === "screen" || kind === "video";
}

function rejectUnsupportedSource(kind) {
  if (!isSystemSource(kind) || !ui.systemCaptureDisabled()) return false;
  ui.showSystemSourceHint(kind);
  return true;
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
  node.port.onmessage = event => {
    const block = event.data;
    onBlock(block.pcm, block.timestamp);
  };
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
  let pendingBlocks = 0;
  let codecQueue = 0;
  let droppedBlocks = 0;
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
        codecQueue = Number(message.queue) || 0;
        onPacket(message.packet, message.timestamp);
      } else if (message.type === "consumed") {
        pendingBlocks = Math.max(0, pendingBlocks - 1);
        codecQueue = Number(message.queue) || 0;
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
      allowWasmFallback: encoderMode.allowWasmFallback
    });
  });

  return {
    ready,
    encode(buffer, timestampSamples) {
      if (closed || pendingBlocks + codecQueue >= maxAudioBufferedBlocks) {
        droppedBlocks++;
        return;
      }
      pcmBlocks++;
      pendingBlocks++;
      worker.postMessage({ type: "encode", pcm: buffer, timestampSamples }, [buffer]);
    },
    recordDrop() {
      droppedBlocks++;
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
        queue: pendingBlocks + codecQueue,
        dropped: droppedBlocks
      };
    }
  };
}

function audioTimestampIsStale(session, sourceTimestamp) {
  if (!Number.isInteger(sourceTimestamp)) return false;
  const currentTimestamp = Math.round(
    session.audioContext.currentTime * config.sampleRate
  ) >>> 0;
  const age = (currentTimestamp - (sourceTimestamp >>> 0)) >>> 0;
  return age < 0x80000000 && age > maxAudioPacketAgeSamples;
}

function consumeAudioSendBudget(session, bytes) {
  const now = performance.now();
  const elapsed = Math.max(0, now - session.audioSendBudgetAt);
  session.audioSendBudget = Math.min(
    maxAudioSendBurstBytes,
    session.audioSendBudget + elapsed * maxAudioSendBytesPerSecond / 1000
  );
  session.audioSendBudgetAt = now;
  if (bytes > session.audioSendBudget) return false;
  session.audioSendBudget -= bytes;
  return true;
}

function sendAudioPacket(session, encoder, packet, sourceTimestamp) {
  if (!session
      || app.active !== session
      || session.encoder !== encoder
      || session.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  if (audioTimestampIsStale(session, sourceTimestamp)) {
    encoder.recordDrop();
    return;
  }
  if (!session.transport.poll()) return;
  if (session.transport.congested
      || !consumeAudioSendBudget(session, packet.byteLength)) {
    encoder.recordDrop();
    return;
  }
  try {
    session.ws.send(packet);
  } catch (error) {
    session.transport.abort(error);
  }
}

function handleAacEncoderError(session, encoder, error) {
  if (!session || app.active !== session) return;
  if (session.encoder === encoder) {
    failActive(error);
    return;
  }
  const swap = session.audioEncoderSwap;
  if (!swap || swap.encoder !== encoder) return;
  failActive(error);
}

function encodeAudioBlock(session, buffer, timestampSamples) {
  if (!session || app.active !== session) return;
  if (!Number.isSafeInteger(timestampSamples) || timestampSamples < 0) return;
  if (audioTimestampIsStale(session, timestampSamples)) {
    (session.audioEncoderSwap?.encoder || session.encoder).recordDrop();
    return;
  }

  const swap = session.audioEncoderSwap;
  if (swap) {
    if (swap.buffers.length >= maxAudioBufferedBlocks) {
      swap.buffers.shift();
      swap.encoder.recordDrop();
    }
    swap.buffers.push({ buffer, timestampSamples });
    return;
  }

  const encoder = session.encoder;
  encoder.encode(buffer, timestampSamples);
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

    session.encoder = swap.encoder;
    session.encoderModeKey = swap.modeKey;
    session.audioEncoderSwap = null;
    previous.close();
    for (const block of swap.buffers) {
      session.encoder.encode(block.buffer, block.timestampSamples);
    }
    swap.buffers.length = 0;
    swap.resolve(swap.info);
  } catch (error) {
    if (session.audioEncoderSwap === swap) session.audioEncoderSwap = null;
    swap.buffers.length = 0;
    swap.encoder.close();
    swap.reject(error);
    if (app.active === session) failActive(error);
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
    (packet, timestamp) => sendAudioPacket(session, nextEncoder, packet, timestamp),
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
    const swap = {
      encoder: nextEncoder,
      modeKey,
      info,
      buffers: [],
      resolve,
      reject
    };
    session.audioEncoderSwap = swap;
    void completeAudioEncoderSwap(session, swap);
  });
}

function createVideoWorker(ws, transport, onError) {
  const worker = new Worker(videoWorkerUrl);
  let closed = false;
  let readySettled = false;
  let pendingSource = null;
  let pendingReconfigure = null;
  let closePromise = null;
  let closeResolve = null;
  let terminateTimer = 0;
  let transportAttached = false;
  let networkDrops = 0;
  let latestStats = {
    queueDrops: 0,
    repeatedFrames: 0,
    submittedFps: 0,
    fps: 0,
    sourceFps: 0,
    kbps: 0,
    queue: 0,
    path: "placeholder"
  };

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const transportControl = {
    pause() {
      if (!closed) worker.postMessage({ type: "transport-pause" });
    },
    resume() {
      if (!closed) worker.postMessage({ type: "transport-resume" });
    }
  };

  const rejectPending = error => {
    if (pendingSource) {
      clearTimeout(pendingSource.timer);
      pendingSource.reject(error);
      pendingSource = null;
    }
    if (pendingReconfigure) {
      clearTimeout(pendingReconfigure.timer);
      pendingReconfigure.reject(error);
      pendingReconfigure = null;
    }
  };

  const terminate = () => {
    clearTimeout(terminateTimer);
    terminateTimer = 0;
    if (transportAttached) {
      transport.detachVideo(transportControl);
      transportAttached = false;
    }
    worker.terminate();
    if (closeResolve) {
      closeResolve();
      closeResolve = null;
    }
  };

  const fail = error => {
    rejectPending(error);
    const wasReady = readySettled;
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (closed) return;
    closed = true;
    terminate();
    if (wasReady) onError(error);
  };

  worker.onmessage = event => {
    const message = event.data || {};
    if (message.type === "ready") {
      if (!readySettled) {
        transport.attachVideo(transportControl);
        transportAttached = true;
        readySettled = true;
        resolveReady();
      }
    } else if (message.type === "source-ready" && pendingSource) {
      clearTimeout(pendingSource.timer);
      pendingSource.resolve();
      pendingSource = null;
    } else if (message.type === "packet") {
      if (closed || !app.active || app.active.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (!transport.poll()) return;
      if (transport.videoPaused) {
        networkDrops++;
        return;
      }
      try {
        ws.send(message.packet);
      } catch (error) {
        transport.abort(error);
      }
    } else if (message.type === "stats") {
      latestStats = message.stats || latestStats;
    } else if (message.type === "reconfigured" && pendingReconfigure) {
      const pending = pendingReconfigure;
      pendingReconfigure = null;
      clearTimeout(pending.timer);
      try {
        if (ws.readyState !== WebSocket.OPEN) throw new Error("Streamer WebSocket is closed.");
        ws.send(`video_quality:${pending.qualityIndex}`);
        ws.send("video_reset");
        worker.postMessage({ type: "resume" });
        pending.resolve();
      } catch (error) {
        pending.reject(error);
        fail(error);
      }
    } else if (message.type === "reconfigure-error" && pendingReconfigure) {
      clearTimeout(pendingReconfigure.timer);
      pendingReconfigure.reject(new Error(message.message || "Video reconfigure failed."));
      pendingReconfigure = null;
    } else if (message.type === "closed") {
      terminate();
    } else if (message.type === "error") {
      fail(new Error(message.message || "Video worker failed."));
    }
  };
  worker.onerror = event => fail(new Error(event.message || "Video worker failed."));

  return {
    ready,
    init() {
      worker.postMessage({
        type: "init",
        width: config.videoWidth,
        height: config.videoHeight,
        fps: config.videoFps,
        bitrate: config.videoBitrate,
        timelineOffsetMs: app.active
          ? Math.max(0, performance.now() - app.active.timelineStartedAt)
          : 0,
        placeholderUrl: videoPlaceholderUrl
      });
    },
    source(readable) {
      if (closed) {
        return Promise.reject(new Error("Video worker is closed."));
      }
      if (pendingSource) {
        return Promise.reject(new Error("Video source change is already running."));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingSource) fail(new Error("Video worker did not accept the capture stream."));
        }, 5000);
        pendingSource = { resolve, reject, timer };
        try {
          worker.postMessage({ type: "source", readable }, [readable]);
        } catch (error) {
          clearTimeout(timer);
          pendingSource = null;
          reject(error);
        }
      });
    },
    placeholder() {
      if (!closed) worker.postMessage({ type: "placeholder" });
    },
    reconfigure(options) {
      if (closed) return Promise.reject(new Error("Video worker is closed."));
      if (pendingReconfigure) return Promise.reject(new Error("Video reconfigure is already running."));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingReconfigure) fail(new Error("Video reconfigure timed out."));
        }, 10000);
        pendingReconfigure = { resolve, reject, timer, qualityIndex: options.qualityIndex };
        try {
          worker.postMessage({ type: "reconfigure", ...options });
        } catch (error) {
          clearTimeout(timer);
          pendingReconfigure = null;
          reject(error);
        }
      });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      const error = new Error("Video worker is closed.");
      rejectPending(error);
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      closePromise = new Promise(resolve => {
        closeResolve = resolve;
      });
      try {
        worker.postMessage({ type: "close" });
        terminateTimer = setTimeout(terminate, 1000);
      } catch (_) {
        terminate();
      }
      return closePromise;
    },
    stats() {
      return {
        ...latestStats,
        networkDrops,
        networkPaused: transport.videoPaused
      };
    }
  };
}

function videoTrackSettings(track) {
  try {
    const settings = track?.getSettings?.() || {};
    return {
      width: Number(settings.width) || 0,
      height: Number(settings.height) || 0,
      fps: Number(settings.frameRate) || 0,
      resizeMode: settings.resizeMode || "unknown"
    };
  } catch (_) {
    return { width: 0, height: 0, fps: 0, resizeMode: "unknown" };
  }
}

async function constrainVideoTrack(track, width, height, fps) {
  try {
    await track.applyConstraints({
      width: { ideal: width, max: width },
      height: { ideal: height, max: height },
      frameRate: { min: fps, ideal: fps, max: fps }
    });
  } catch (_) {
    try { await track.applyConstraints(videoCaptureConstraints(width, height, fps)); } catch (_) {}
  }
}

async function createVideoStreamer(source, ws, transport, onError) {
  if (!window.Worker) throw new Error("Video workers are not available.");
  if (!("MediaStreamTrackProcessor" in window)) {
    throw new Error("MediaStreamTrackProcessor is not available.");
  }
  if (!source || !source.mediaStream.getVideoTracks()[0]) {
    throw new Error("Selected source has no video track.");
  }
  const worker = createVideoWorker(ws, transport, onError);
  let closed = false;
  let processorTrack = null;
  let api = null;

  const clearStopTimer = () => {
    if (!api) return;
    clearTimeout(api.stopTimer);
    api.stopTimer = 0;
  };

  const setSource = async nextSource => {
    if (closed) throw new Error("Video streamer is closed.");
    const track = nextSource.mediaStream.getVideoTracks()[0];
    if (!track) throw new Error("Selected source has no video track.");
    clearStopTimer();
    const nextTrack = track.clone();
    try { nextTrack.contentHint = "motion"; } catch (_) {}
    await constrainVideoTrack(nextTrack, config.videoWidth, config.videoHeight, config.videoFps);
    const nextProcessor = new MediaStreamTrackProcessor({ track: nextTrack, maxBufferSize: 1 });
    try {
      await worker.source(nextProcessor.readable);
    } catch (error) {
      nextTrack.stop();
      throw error;
    }
    if (processorTrack) processorTrack.stop();
    processorTrack = nextTrack;
  };

  const stopVideoTrack = () => {
    if (processorTrack) processorTrack.stop();
    processorTrack = null;
  };

  try {
    worker.init();
    await worker.ready;
    if (!app.active || app.active.ws !== ws) throw new Error("Video start cancelled.");
    await setSource(source);
    api = {
      source,
      stopTimer: 0,
      async setSource(nextSource) {
        await setSource(nextSource);
        api.source = nextSource;
      },
      placeholder() {
        clearStopTimer();
        stopVideoTrack();
        api.source = null;
        worker.placeholder();
      },
      async reconfigure(options) {
        if (processorTrack) {
          await constrainVideoTrack(processorTrack, options.width, options.height, options.fps);
        }
        await worker.reconfigure(options);
      },
      close() {
        clearStopTimer();
        closed = true;
        stopVideoTrack();
        return worker.close();
      },
      stats() {
        const track = videoTrackSettings(processorTrack);
        return {
          ...worker.stats(),
          trackWidth: track.width,
          trackHeight: track.height,
          trackFps: track.fps,
          trackResizeMode: track.resizeMode
        };
      }
    };
    return api;
  } catch (error) {
    closed = true;
    stopVideoTrack();
    await worker.close();
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
  disconnectSourceAudio(source);
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
  disconnectSourceAudio(source);
  if (source.block) source.block.remove();
  if (stopStream) stopMediaStream(source.mediaStream);
}

function createSourceAudio(mediaStream) {
  const audioContext = app.active.audioContext;
  return {
    node: audioContext.createMediaStreamSource(mediaStream),
    processor: new AudioWorkletNode(audioContext, "source-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    })
  };
}

function disconnectSourceAudio(source) {
  if (!source) return;
  try { source.node && source.node.disconnect(); } catch (_) {}
  try { source.processor && source.processor.disconnect(); } catch (_) {}
  try { source.processor && source.processor.port.close(); } catch (_) {}
}

function initializeSourceAudio(source, settingsKind, settings) {
  if (source.processor) {
    source.processor.port.onmessage = event => {
      const message = event.data;
      if (message && message.type === "level") ui.updateSourceLevel(source, message.peak);
    };
    const initial = ui.normalizeRuntimeSourceSettings(
      settingsKind,
      settings || ui.loadSourceSettings(settingsKind)
    );
    source.gainEl.value = String(initial.gain);
    source.muteEl.checked = Boolean(initial.mute);
    if (source.monoEl) source.monoEl.checked = Boolean(initial.forceMono);
  }
  applyAudioSourceSettings(source);
  ui.saveSourceSettings(source);
}

function connectSourceAudio(source) {
  if (!source.processor) return;
  source.node.connect(source.processor);
  source.processor.connect(app.active.mixer);
}

function mountSourceBlock(source, previous, replacedSource = null) {
  const previousBlock = previous?.block;
  const fallbackBlock = replacedSource?.block;
  if (previousBlock?.parentNode) previousBlock.replaceWith(source.block);
  else if (fallbackBlock?.parentNode) fallbackBlock.replaceWith(source.block);
  else ui.els.sourcesEl.appendChild(source.block);
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

  const { node, processor } = createSourceAudio(mediaStream);
  const next = {
    kind,
    name: ui.sourceDisplayName(kind, mediaStream),
    deviceId,
    mediaStream,
    node,
    processor
  };
  ui.createSourceBlock(next);
  initializeSourceAudio(next, kind, settings);

  const previous = app.active.sources[kind];
  app.active.sources[kind] = next;

  connectSourceAudio(next);
  mountSourceBlock(next, previous, replacedVideo);
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
  return mediaStream;
}

function requestSource(kind, deviceId) {
  return kind === "video" ? requestVideoSource() : requestAudioSource(kind, deviceId);
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
    Object.assign(next, createSourceAudio(mediaStream));
  }
  ui.createSourceBlock(next);
  ui.updateSourceVideoPreview(next);
  initializeSourceAudio(next, "video", settings);

  const replacedScreen = app.active.sources.screen;
  if (replacedScreen) app.active.sources.screen = null;
  const previous = app.active.sources.video;
  app.active.sources.video = next;
  connectSourceAudio(next);
  mountSourceBlock(next, previous, replacedScreen);
  let videoStartSent = false;
  try {
    if (app.active.video) {
      await app.active.video.setSource(next);
    } else {
      sendStreamerCommand("video_start");
      videoStartSent = true;
      app.active.video = await createVideoStreamer(
        next,
        app.active.ws,
        app.active.transport,
        error => {
          if (!app.active) return;
          removeVideoSource(next);
        }
      );
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
  if (rejectUnsupportedSource(kind)) return;

  let mediaStream = mediaStreamOverride;
  ui.setSourceRequestBusy(true);
  try {
    if (!mediaStream) {
      mediaStream = await requestSource(kind, deviceId);
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
  } catch (error) {
    if (!isMediaSelectionCancelled(error)) console.error("Source change failed:", error);
  } finally {
    stopMediaStream(mediaStream);
    ui.setSourceRequestBusy(false);
  }
}

async function start(kind, deviceId = null, settings = null, mediaStreamOverride = null) {
  if (rejectUnsupportedSource(kind)) return;
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
  let resolveHello = null;
  let helloReceived = false;
  const helloReady = new Promise(resolve => { resolveHello = resolve; });
  ui.setSourceRequestBusy(true);
  try {
    if (!mediaStream) {
      mediaStream = await requestSource(kind, deviceId);
    }

    encoder = createAacEncoder(
      app.selectedEncoderMode(),
      (packet, timestamp) => sendAudioPacket(session, encoder, packet, timestamp),
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

    const captureNode = await createCaptureNode(audioContext, (buffer, timestamp) => {
      encodeAudioBlock(session, buffer, timestamp);
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
      timelineStartedAt: 0,
      preparingAudioEncoder: null,
      audioEncoderSwap: null,
      audioSendBudget: maxAudioSendBurstBytes,
      audioSendBudgetAt: performance.now(),
      video: null,
      mixer,
      captureNode,
      monitor,
      wakeLock,
      transport: null,
      statsTimer: null,
      sources: { mic: null, screen: null, video: null },
      streamListeners: pendingStreamListeners
    };
    session.transport = createPublisherTransport(ws, error => {
      if (app.active === session) failActive(error);
    });
    app.active = session;
    ws.onclose = event => {
      if (app.active && app.active.ws === ws) {
        const detail = event.reason
          ? `${event.code}: ${event.reason}`
          : String(event.code || "unknown");
        failActive(new Error(`Streamer connection closed (${detail}).`));
      }
    };
    ws.onerror = () => {
      if (app.active && app.active.ws === ws) {
        failActive(new Error("Streamer WebSocket connection failed."));
      }
    };

    mixer.connect(captureNode);
    captureNode.connect(monitor);
    monitor.connect(audioContext.destination);
    await audioContext.resume();
    session.timelineStartedAt = performance.now() - audioContext.currentTime * 1000;

    if (kind === "video") {
      await installVideoSource(mediaStream, settings);
    } else {
      installAudioSource(kind, mediaStream, deviceId ?? undefined, settings);
    }
    mediaStream = null;

    ui.setStreamingControls(true);

    ui.updateStreamStatus(encoderInfo);
    app.active.statsTimer = setInterval(() => {
      const current = app.active;
      if (!current || current.ws !== ws) return;
      ui.updateStreamStatus(current.encoder.stats());
    }, 1000);
  } catch (error) {
    const failureAlreadyHandled = Boolean(session && app.active !== session);
    console.error("Stream start failed:", error);
    if (app.active && app.active.ws === ws) {
      cleanup();
    } else {
      if (encoder) encoder.close();
      closeWebSocket(ws, 3000, "start failed");
      closeAudioContext(audioContext);
      ui.setStreamingControls(false);
    }
    stopMediaStream(mediaStream);
    if (!failureAlreadyHandled) {
      alert(`Stream start failed:\n\n${error?.message || error}`);
    }
  } finally {
    ui.setSourceRequestBusy(false);
  }
}

function failActive(error = new Error("Stream stopped unexpectedly.")) {
  if (!app.active) return;
  const message = error?.message || String(error);
  console.error("Stream stopped:", error);
  cleanup();
  alert(`Stream stopped:\n\n${message}`);
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
  if (app.active && app.active.video) {
    await app.active.video.reconfigure({
      width: quality.width,
      height: quality.height,
      fps: quality.fps,
      bitrate: quality.bitrate,
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
  current.transport.close();
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
  closeWebSocket(current.ws, 1000, "stop");
  closeAudioContext(current.audioContext);
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
        const video = app.active.video;
        void video.setSource(source).catch(error => {
          console.error("Video source restore failed:", error);
          if (!app.active || app.active.video !== video || app.active.sources.video !== source) return;
          source.videoHidden = true;
          if (source.muteEl) source.muteEl.checked = true;
          applyAudioSourceSettings(source);
          ui.updateSourceControls();
          ui.updateStreamStatus();
        });
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
