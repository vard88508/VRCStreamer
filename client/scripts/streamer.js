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
    const session = app.active;
    if (!session || document.visibilityState !== "visible") return;
    if (session.wakeLock && !session.wakeLock.released) return;
    const wakeLock = await requestScreenWakeLock();
    if (!wakeLock) return;
    if (app.active === session && !session.wakeLock) session.wakeLock = wakeLock;
    else void wakeLock.release().catch(() => {});
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

  async function requestMedia(promise, message) {
    let abandoned = false;
    promise.then(
      (stream) => {
        if (abandoned) stopMediaStream(stream);
      },
      () => {},
    );
    try {
      return await withTimeout(promise, 45000, message);
    } catch (error) {
      abandoned = true;
      throw error;
    }
  }

  function isDisplayMediaConstraintError(error) {
    const name = error && error.name ? error.name : "";
    const message = error && error.message ? error.message : String(error || "");
    return (
      name === "TypeError" ||
      name === "NotSupportedError" ||
      name === "OverconstrainedError" ||
      /not supported|constraint|parameter|operation/i.test(message)
    );
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
    return (
      name === "OverconstrainedError" ||
      name === "NotFoundError" ||
      name === "DevicesNotFoundError" ||
      name === "ConstraintNotSatisfiedError"
    );
  }

  function displayMediaOptions(video, audio) {
    return {
      video,
      audio,
      systemAudio: "include",
      windowAudio: "window",
      surfaceSwitching: "include",
      selfBrowserSurface: "exclude",
    };
  }

  function videoCaptureConstraints(width, height, fps) {
    return {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: fps, max: fps },
    };
  }

  function audioCaptureConstraints() {
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: config.sampleRate,
    };
  }

  async function captureAudio(kind, deviceIdOverride = null) {
    const audio = audioCaptureConstraints();
    if (kind === "screen") {
      const video = videoCaptureConstraints(config.videoWidth, config.videoHeight, config.videoFps);
      return await getDisplayMediaCompat(displayMediaOptions(video, audio), [
        { video, audio: true },
        { video: true, audio: true },
      ]);
    }
    const deviceId = deviceIdOverride ?? ui.els.micDeviceEl.value;
    if (!deviceId) return await navigator.mediaDevices.getUserMedia({ video: false, audio });

    try {
      return await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { ...audio, deviceId: { exact: deviceId } },
      });
    } catch (error) {
      if (!isMissingAudioDeviceError(error)) throw error;
      ui.saveMicDeviceSelection("");
      return await navigator.mediaDevices.getUserMedia({ video: false, audio });
    }
  }

  async function captureVideo() {
    const audio = audioCaptureConstraints();
    const video = videoCaptureConstraints(config.videoWidth, config.videoHeight, config.videoFps);
    return await getDisplayMediaCompat(displayMediaOptions(video, audio), [
      { video, audio: true },
      { video: true, audio: true },
      { video: true, audio: false },
    ]);
  }

  function removeVideoTracks(mediaStream) {
    for (const track of mediaStream.getVideoTracks()) {
      mediaStream.removeTrack(track);
      track.stop();
    }
  }

  function stopMediaStream(mediaStream) {
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  }

  function closeWebSocket(ws, code, reason) {
    if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) return;
    try {
      ws.close(code, reason);
    } catch (_) {
      try {
        ws.close();
      } catch (_) {}
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

    const abort = (error) => {
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
      },
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
    await withTimeout(
      audioContext.audioWorklet.addModule(audioWorkletUrl),
      10000,
      "Audio worklet loading timeout",
    );

    const node = new AudioWorkletNode(audioContext, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        frames: config.framesPerChunk,
        channels: config.channels,
      },
    });
    node.port.onmessage = (event) => {
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

    const ready = new Promise((resolve, reject) => {
      rejectReady = reject;
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === "ready") {
          name = message.name || name;
          detail = message.detail || "";
          readySettled = true;
          resolve({ name, detail });
        } else if (message.type === "packet") {
          encodedFrames++;
          encodedBytes += message.bytes;
          codecQueue = Number(message.queue) || 0;
          onPacket(message.packet, message.timestamp);
        } else if (message.type === "consumed") {
          pendingBlocks = Math.max(0, pendingBlocks - 1);
          codecQueue = Number(message.queue) || 0;
        } else if (message.type === "error") {
          const error = new Error(message.message || "AAC worker failed.");
          if (!readySettled) {
            readySettled = true;
            reject(error);
          }
          onError(error);
        }
      };
      worker.onerror = (event) => {
        const error = new Error(event.message || "AAC worker failed.");
        if (!readySettled) {
          readySettled = true;
          reject(error);
        }
        onError(error);
      };
      worker.postMessage({
        type: "init",
        sampleRate: config.sampleRate,
        channels: config.channels,
        bitrate: encoderMode.bitrate,
        expectedAacConfigHex: config.expectedAacConfigHex,
        native: encoderMode.native,
      });
    });

    return {
      ready,
      encode(buffer, timestampSamples) {
        if (closed || pendingBlocks + codecQueue >= maxAudioBufferedBlocks) {
          droppedBlocks++;
          return;
        }
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
        worker.terminate();
      },
      stats() {
        const now = performance.now();
        const elapsed = Math.max((now - statsAt) / 1000, 0.001);
        if (elapsed >= 0.25) {
          currentEncodedFps = (encodedFrames - statsFrames) / elapsed;
          currentEncodedKbps = ((encodedBytes - statsBytes) * 8) / 1000 / elapsed;
          statsAt = now;
          statsFrames = encodedFrames;
          statsBytes = encodedBytes;
        }
        return {
          name,
          detail,
          encodedFrames,
          encodedFps: currentEncodedFps,
          encodedKbps: currentEncodedKbps,
          queue: pendingBlocks + codecQueue,
          dropped: droppedBlocks,
        };
      },
    };
  }

  function audioTimestampIsStale(session, sourceTimestamp) {
    if (!Number.isInteger(sourceTimestamp)) return false;
    const currentTimestamp = Math.round(session.audioContext.currentTime * config.sampleRate) >>> 0;
    const age = (currentTimestamp - (sourceTimestamp >>> 0)) >>> 0;
    return age < 0x80000000 && age > maxAudioPacketAgeSamples;
  }

  function consumeAudioSendBudget(session, bytes) {
    const now = performance.now();
    const elapsed = Math.max(0, now - session.audioSendBudgetAt);
    session.audioSendBudget = Math.min(
      maxAudioSendBurstBytes,
      session.audioSendBudget + (elapsed * maxAudioSendBytesPerSecond) / 1000,
    );
    session.audioSendBudgetAt = now;
    if (bytes > session.audioSendBudget) return false;
    session.audioSendBudget -= bytes;
    return true;
  }

  function sendAudioPacket(session, encoder, packet, sourceTimestamp) {
    if (
      !session ||
      app.active !== session ||
      session.encoder !== encoder ||
      session.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    if (audioTimestampIsStale(session, sourceTimestamp)) {
      encoder.recordDrop();
      return;
    }
    if (!session.transport.poll()) return;
    if (session.transport.congested || !consumeAudioSendBudget(session, packet.byteLength)) {
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
    if (session && app.active === session && session.encoder === encoder) failActive(error);
  }

  function encodeAudioBlock(session, buffer, timestampSamples) {
    if (!session || app.active !== session) return;
    if (!Number.isSafeInteger(timestampSamples) || timestampSamples < 0) return;
    const audioClockSamples = timestampSamples + config.framesPerChunk;
    if (audioClockSamples > session.audioClockSamples) {
      session.audioClockSamples = audioClockSamples;
      session.video?.syncAudioClock(audioClockSamples);
    }
    if (audioTimestampIsStale(session, timestampSamples)) {
      session.encoder.recordDrop();
      return;
    }

    session.encoder.encode(buffer, timestampSamples);
  }

  function createVideoWorker(ws, transport, onError) {
    const worker = new Worker(videoWorkerUrl);
    let closed = false;
    let readySettled = false;
    let pendingSource = null;
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
      path: "placeholder",
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
      },
    };

    const rejectPending = (error) => {
      if (pendingSource) {
        clearTimeout(pendingSource.timer);
        pendingSource.reject(error);
        pendingSource = null;
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

    const fail = (error) => {
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

    worker.onmessage = (event) => {
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
      } else if (message.type === "closed") {
        terminate();
      } else if (message.type === "error") {
        fail(new Error(message.message || "Video worker failed."));
      }
    };
    worker.onerror = (event) => fail(new Error(event.message || "Video worker failed."));

    return {
      ready,
      init(audioClockSamples) {
        worker.postMessage({
          type: "init",
          width: config.videoWidth,
          height: config.videoHeight,
          fps: config.videoFps,
          bitrate: config.videoBitrate,
          audioClockSamples,
          audioSampleRate: config.sampleRate,
          placeholderUrl: videoPlaceholderUrl,
        });
      },
      syncAudioClock(timestampSamples) {
        if (!closed) worker.postMessage({ type: "audio-clock", timestampSamples });
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
      close() {
        if (closePromise) return closePromise;
        closed = true;
        const error = new Error("Video worker is closed.");
        rejectPending(error);
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        closePromise = new Promise((resolve) => {
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
          networkPaused: transport.videoPaused,
        };
      },
    };
  }

  function videoTrackSettings(track) {
    try {
      const settings = track?.getSettings?.() || {};
      return {
        width: Number(settings.width) || 0,
        height: Number(settings.height) || 0,
        fps: Number(settings.frameRate) || 0,
        resizeMode: settings.resizeMode || "unknown",
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
        frameRate: { min: fps, ideal: fps, max: fps },
      });
    } catch (_) {
      try {
        await track.applyConstraints(videoCaptureConstraints(width, height, fps));
      } catch (_) {}
    }
  }

  async function createVideoStreamer(source, ws, transport, onError) {
    if (!window.Worker) throw new Error("Video workers are not available.");
    if (!("MediaStreamTrackProcessor" in window)) {
      throw new Error("MediaStreamTrackProcessor is not available.");
    }
    const worker = createVideoWorker(ws, transport, onError);
    let closed = false;
    let processorTrack = null;
    let api = null;
    let sourceRevision = 0;

    const setSource = async (nextSource) => {
      if (closed) throw new Error("Video streamer is closed.");
      const revision = ++sourceRevision;
      if (nextSource.videoHidden) {
        stopVideoTrack();
        worker.placeholder();
        return true;
      }
      const track = nextSource.mediaStream.getVideoTracks()[0];
      if (!track) throw new Error("Selected source has no video track.");
      const nextTrack = track.clone();
      try {
        nextTrack.contentHint = "motion";
      } catch (_) {}
      await constrainVideoTrack(nextTrack, config.videoWidth, config.videoHeight, config.videoFps);
      try {
        if (closed || revision !== sourceRevision) {
          nextTrack.stop();
          return false;
        }
        const nextProcessor = new MediaStreamTrackProcessor({ track: nextTrack, maxBufferSize: 1 });
        await worker.source(nextProcessor.readable);
        if (closed || revision !== sourceRevision) {
          nextTrack.stop();
          return false;
        }
      } catch (error) {
        nextTrack.stop();
        throw error;
      }
      if (processorTrack) processorTrack.stop();
      processorTrack = nextTrack;
      return true;
    };

    const stopVideoTrack = () => {
      if (processorTrack) processorTrack.stop();
      processorTrack = null;
    };

    try {
      worker.init(app.active?.audioClockSamples || 0);
      await withTimeout(worker.ready, 10000, "Video encoder initialization timeout");
      if (!app.active || app.active.ws !== ws) throw new Error("Video start cancelled.");
      if (source) await setSource(source);
      worker.syncAudioClock(app.active.audioClockSamples);
      api = {
        source,
        async setSource(nextSource) {
          const applied = await setSource(nextSource);
          if (applied) api.source = nextSource;
          return applied;
        },
        placeholder() {
          sourceRevision++;
          stopVideoTrack();
          api.source = null;
          worker.placeholder();
        },
        syncAudioClock(timestampSamples) {
          worker.syncAudioClock(timestampSamples);
        },
        close() {
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
            trackResizeMode: track.resizeMode,
          };
        },
      };
      return api;
    } catch (error) {
      closed = true;
      stopVideoTrack();
      await worker.close();
      throw error;
    }
  }

  function disposeVideoSource(source, stopStream = true) {
    if (!source) return;
    if (app.active?.video?.source === source) app.active.video.placeholder();
    disconnectSourceAudio(source);
    if (source.previewEl) {
      source.previewEl.pause();
      source.previewEl.srcObject = null;
    }
    source.block?.remove();
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
        outputChannelCount: [2],
      }),
    };
  }

  function disconnectSourceAudio(source) {
    if (!source) return;
    try {
      source.node && source.node.disconnect();
    } catch (_) {}
    try {
      source.processor && source.processor.disconnect();
    } catch (_) {}
    try {
      source.processor && source.processor.port.close();
    } catch (_) {}
  }

  function initializeSourceAudio(source, settingsKind, settings) {
    const initial = ui.normalizeRuntimeSourceSettings(
      settingsKind,
      settings || ui.loadSourceSettings(settingsKind),
    );
    if (source.gainEl) source.gainEl.value = String(initial.gain);
    if (source.muteEl) source.muteEl.checked = Boolean(initial.mute);
    if (source.monoEl) source.monoEl.checked = Boolean(initial.forceMono);
    if (source.kind === "video") source.videoHidden = Boolean(initial.mute);
    if (source.processor) {
      source.processor.port.onmessage = (event) => {
        const message = event.data;
        if (message && message.type === "level") ui.updateSourceLevel(source, message.peak);
      };
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

  function installAudioSource(
    kind,
    mediaStream,
    deviceId = kind === "mic" ? ui.els.micDeviceEl.value : "",
    settings = null,
  ) {
    if (!app.active) {
      stopMediaStream(mediaStream);
      return;
    }
    const replacedVideo = kind === "screen" ? app.active.sources.video : null;
    const next = {
      kind,
      name: ui.sourceDisplayName(kind, mediaStream),
      deviceId,
      mediaStream,
    };
    const previous = app.active.sources[kind];
    try {
      Object.assign(next, createSourceAudio(mediaStream));
      ui.createSourceBlock(next);
      initializeSourceAudio(next, kind, settings);
      connectSourceAudio(next);
      mountSourceBlock(next, previous, replacedVideo);
    } catch (error) {
      disposeAudioSource(next);
      throw error;
    }
    app.active.sources[kind] = next;
    if (replacedVideo) app.active.sources.video = null;
    if (previous) disposeAudioSource(previous);
    if (replacedVideo) disposeVideoSource(replacedVideo);

    mediaStream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => removeAudioSource(kind, next), { once: true });
    });

    ui.updateSourceControls();
    ui.updateStreamStatus();
  }

  async function requestAudioSource(kind, deviceId = null) {
    const mediaStream = await requestMedia(
      captureAudio(kind, deviceId),
      "Timed out waiting for browser audio permission/selection.",
    );
    if (kind === "screen") removeVideoTracks(mediaStream);
    if (mediaStream.getAudioTracks().length === 0) {
      stopMediaStream(mediaStream);
      throw new Error("No audio track selected");
    }
    if (kind === "mic") {
      try {
        await ui.refreshMicDevices(ui.els.micDeviceEl.value);
      } catch (_) {}
    }
    return mediaStream;
  }

  async function requestVideoSource() {
    if (!app.serverVideoEnabled()) throw new Error("Video is disabled on this server.");
    const mediaStream = await requestMedia(captureVideo(), "Timed out waiting for browser video selection.");
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
    if (app.active.mode !== "video") throw new Error("This session is audio-only.");
    const session = app.active;
    const hasAudio = mediaStream.getAudioTracks().length > 0;

    const next = {
      kind: "video",
      name: ui.sourceDisplayName("video", mediaStream),
      mediaStream,
      hasAudio,
      videoHidden: false,
      node: null,
      processor: null,
    };
    const previous = session.sources.video;
    const replacedScreen = session.sources.screen;
    try {
      if (hasAudio) Object.assign(next, createSourceAudio(mediaStream));
      ui.createSourceBlock(next);
      ui.updateSourceVideoPreview(next);
      initializeSourceAudio(next, "video", settings);
      if (session.video) {
        if (!(await session.video.setSource(next))) throw new Error("Video source change cancelled.");
      } else {
        const video = await createVideoStreamer(next, session.ws, session.transport, (error) => {
          if (app.active === session) failActive(error);
        });
        if (app.active !== session) {
          await video.close();
          throw new Error("Video start cancelled.");
        }
        session.video = video;
      }
      if (app.active !== session) throw new Error("Video source change cancelled.");
      connectSourceAudio(next);
      mountSourceBlock(next, previous, replacedScreen);
      session.sources.video = next;
      session.sources.screen = null;
      disposeVideoSource(previous);
      disposeAudioSource(replacedScreen);
    } catch (error) {
      disposeVideoSource(next);
      throw error;
    }

    mediaStream.getVideoTracks()[0].addEventListener("ended", () => removeVideoSource(next), { once: true });
    ui.updateSourceControls();
    ui.updateStreamStatus();
  }

  async function addOrReplaceSource(kind, deviceId = null, settings = null, mediaStreamOverride = null) {
    if (!app.active || app.sourceRequestInFlight) return;
    if (rejectUnsupportedSource(kind)) return;

    const session = app.active;
    if (kind === "video" && session.mode !== "video") return;
    let mediaStream = mediaStreamOverride;
    ui.setSourceRequestBusy(true);
    try {
      if (!mediaStream) {
        mediaStream = await requestSource(kind, deviceId);
      }
      if (app.active !== session) return;
      if (kind === "video") {
        await installVideoSource(mediaStream, settings);
      } else {
        installAudioSource(kind, mediaStream, deviceId ?? undefined, settings);
      }
      mediaStream = null;
      ui.updateStreamStatus();
    } catch (error) {
      if (app.active === session && !isMediaSelectionCancelled(error)) {
        console.error("Source change failed:", error);
        alert(`Source change failed:\n\n${error.message || error}`);
      }
    } finally {
      stopMediaStream(mediaStream);
      ui.setSourceRequestBusy(false);
    }
  }

  function connectStream(ws, settings, onListeners, onFailure) {
    return new Promise((resolve, reject) => {
      let ready = false;
      const fail = (error) => {
        clearTimeout(timer);
        if (ready) onFailure(error);
        else reject(error);
      };
      const timer = setTimeout(() => fail(new Error("Stream connection timeout.")), 10000);
      ws.onopen = () => ws.send(JSON.stringify(settings));
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        if (message.type !== "ready" && message.type !== "listeners") return;
        if (Number.isInteger(message.listeners) && message.listeners >= 0) onListeners(message.listeners);
        if (message.type === "ready" && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onerror = () => fail(new Error("Streamer WebSocket connection failed."));
      ws.onclose = (event) =>
        fail(
          new Error(`Streamer connection closed (${event.code}${event.reason ? ": " + event.reason : ""}).`),
        );
    });
  }

  async function start(
    kind,
    deviceId = null,
    settings = null,
    mediaStreamOverride = null,
    restarting = false,
  ) {
    if (rejectUnsupportedSource(kind)) return;
    if (app.active) {
      await addOrReplaceSource(kind, deviceId, settings, mediaStreamOverride);
      return;
    }
    if (app.sourceRequestInFlight || !app.serverConnectionReady() || !app.streamMode) return;
    const mode = app.streamMode;
    if (!restarting && mode === "video" && kind !== "video") return;
    if (mode === "audio" && kind === "video") return;
    const quality = mode === "video" ? app.selectedVideoQuality() : null;
    if (mode === "video" && !quality) return;
    const code = app.streamCode;
    if (code.length !== config.streamCodeLength) return;

    let mediaStream = mediaStreamOverride;
    let audioContext = null;
    let ws = null;
    let encoder = null;
    let session = null;
    let wakeLock = null;
    let connectionError = null;
    let listeners = 0;
    ui.setSourceRequestBusy(true);
    try {
      if (!mediaStream && kind) mediaStream = await requestSource(kind, deviceId);
      encoder = createAacEncoder(
        app.selectedEncoderMode(),
        (packet, timestamp) => sendAudioPacket(session, encoder, packet, timestamp),
        (error) => handleAacEncoderError(session, encoder, error),
      );
      const encoderInfo = await withTimeout(encoder.ready, 10000, "Audio encoder initialization timeout");
      ws = new WebSocket(app.wsUrlForCode(code));
      await connectStream(
        ws,
        mode === "video" ? { mode, video_quality: quality.id } : { mode },
        (count) => {
          listeners = count;
          if (app.active === session && session) {
            session.streamListeners = count;
            ui.updateStreamStatus();
          }
        },
        (error) => {
          connectionError = error;
          if (session && app.active === session) failActive(error);
        },
      );

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContextClass({ latencyHint: "interactive", sampleRate: config.sampleRate });
      if (audioContext.sampleRate !== config.sampleRate) {
        throw new Error(
          `AudioContext returned ${audioContext.sampleRate} Hz, expected ${config.sampleRate} Hz.`,
        );
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
      wakeLock = await requestScreenWakeLock();
      if (connectionError || ws.readyState !== WebSocket.OPEN) {
        throw connectionError || new Error("Stream connection closed during setup.");
      }

      session = {
        mode,
        videoQuality: quality,
        audioContext,
        ws,
        encoder,
        audioClockSamples: Math.round(audioContext.currentTime * config.sampleRate),
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
        streamListeners: listeners,
      };
      session.transport = createPublisherTransport(ws, (error) => {
        if (app.active === session) failActive(error);
      });
      app.active = session;
      setMediaSessionPlaying(true);
      mixer.connect(captureNode);
      captureNode.connect(monitor);
      monitor.connect(audioContext.destination);
      await withTimeout(audioContext.resume(), 10000, "Audio context start timeout");
      if (app.active !== session) throw new Error("Stream start cancelled.");
      session.audioClockSamples = Math.round(audioContext.currentTime * config.sampleRate);
      if (kind === "video") await installVideoSource(mediaStream, settings);
      else {
        if (kind) installAudioSource(kind, mediaStream, deviceId ?? undefined, settings);
        if (mode === "video") {
          const video = await createVideoStreamer(null, ws, session.transport, (error) => {
            if (app.active === session) failActive(error);
          });
          if (app.active !== session) {
            await video.close();
            throw new Error("Stream start cancelled.");
          }
          session.video = video;
        }
      }
      mediaStream = null;
      if (app.active !== session) throw new Error("Stream start cancelled.");
      ui.setStreamingControls(true);
      ui.updateStreamStatus(encoderInfo);
      session.statsTimer = setInterval(() => {
        if (app.active === session) ui.updateStreamStatus(session.encoder.stats());
      }, 1000);
    } catch (error) {
      const handled = Boolean(session && app.active !== session);
      if (session && app.active === session) cleanup();
      else {
        encoder?.close();
        closeWebSocket(ws, 3000, "start failed");
        closeAudioContext(audioContext);
        if (wakeLock) void wakeLock.release().catch(() => {});
        ui.setStreamingControls(false);
      }
      stopMediaStream(mediaStream);
      if (!handled && !isMediaSelectionCancelled(error)) {
        console.error("Stream start failed:", error);
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
    if (!app.active) return;

    cleanup({ stopStreams: false, updateControls: false });
    const first = sources.shift();
    await start(first?.kind, first?.deviceId, first?.settings, first?.mediaStream, true);
    if (!app.active) {
      stopMediaStream(first?.mediaStream);
      for (const source of sources) stopMediaStream(source.mediaStream);
      return;
    }
    for (const source of sources) {
      if (app.active)
        await addOrReplaceSource(source.kind, source.deviceId, source.settings, source.mediaStream);
      else stopMediaStream(source.mediaStream);
    }
  }

  function cleanup({ stopStreams = true, updateControls = true } = {}) {
    const current = app.active;
    app.active = null;
    if (updateControls) ui.setStreamingControls(false);
    if (!current) return;

    if (current.statsTimer) clearInterval(current.statsTimer);
    current.transport.close();
    current.captureNode.port.onmessage = null;
    current.captureNode.port.close();
    try {
      current.captureNode.disconnect();
    } catch (_) {}
    try {
      current.mixer.disconnect();
    } catch (_) {}
    try {
      current.monitor.disconnect();
    } catch (_) {}
    disposeAudioSource(current.sources.mic, stopStreams);
    disposeAudioSource(current.sources.screen, stopStreams);
    disposeVideoSource(current.sources.video, stopStreams);
    try {
      current.video && current.video.close();
    } catch (_) {}
    try {
      current.encoder.close();
    } catch (_) {}
    if (current.wakeLock) {
      void current.wakeLock.release().catch(() => {});
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
      forceMono: Boolean(source.monoEl && source.monoEl.checked),
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
        void video.setSource(source).catch((error) => {
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
    refreshScreenWakeLock,
    addOrReplaceSource,
    removeAudioSource,
    removeVideoSource,
    applyAudioSourceSettings,
    toggleVideoSourceHidden,
    restartActiveWithCurrentSources,
  };
}
