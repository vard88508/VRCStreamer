let mode = "";
let sampleRate = 48000;
let channels = 2;
let bitrate = 320000;
let expectedAacConfigHex = "1190";
let nativeAacBitrates = [320000, 256000, 192000, 160000, 128000, 96000];

let nativeEncoder = null;
let nativeNextTimestampUs = 0;
let nativeS16Scratch = null;

let modulePromise = null;
let module = null;
let ctx = 0;
let frameSize = 0;
let inputBytesPerFrame = 0;
let nextTimestamp = 0;
let initEncoderFn = null;
let getEncoderFrameSizeFn = null;
let getEncoderExtradataFn = null;
let getEncoderExtradataSizeFn = null;
let getEncodeInputPtrFn = null;
let sendFrameFn = null;
let receivePacketFn = null;
let getEncodedDataFn = null;
let getEncodedPtsFn = null;
let closeEncoderFn = null;

function errorText(error) {
  if (!error) return "unknown error";
  return error.message || String(error);
}

function limitText(text, maxLength = 220) {
  const value = String(text || "");
  return value.length <= maxLength ? value : value.slice(0, maxLength - 1) + "...";
}

function kbps(value) {
  return `${Math.round(value / 1000)} kbps`;
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function nativeAacConfigs() {
  const configs = [];
  for (const candidateBitrate of nativeAacBitrates) {
    const base = {
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: channels,
      bitrate: candidateBitrate
    };
    configs.push([
      `raw AAC + CBR ${kbps(candidateBitrate)}`,
      { ...base, bitrateMode: "constant", aac: { format: "aac" } }
    ]);
    configs.push([
      `raw AAC ${kbps(candidateBitrate)}`,
      { ...base, aac: { format: "aac" } }
    ]);
    configs.push([
      `default AAC + CBR ${kbps(candidateBitrate)}`,
      { ...base, bitrateMode: "constant" }
    ]);
    configs.push([
      `default AAC ${kbps(candidateBitrate)}`,
      base
    ]);
  }
  configs.push([
    "raw AAC browser default bitrate",
    { codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, aac: { format: "aac" } }
  ]);
  configs.push([
    "default AAC browser default bitrate",
    { codec: "mp4a.40.2", sampleRate, numberOfChannels: channels }
  ]);
  return configs;
}

function copyEncodedChunk(chunk) {
  const packet = new Uint8Array(chunk.byteLength);
  chunk.copyTo(packet);
  return packet;
}

function validatePacket(packet, configHex) {
  if (!packet || packet.byteLength < 4) throw new Error("Native AAC encoder produced no packet.");
  if (packet[0] === 0xff && (packet[1] & 0xf6) === 0xf0) {
    throw new Error("Native AAC encoder produced ADTS instead of raw AAC access units.");
  }
  if (configHex && !configHex.startsWith(expectedAacConfigHex)) {
    throw new Error(`Native AAC config ${configHex} does not match RTSP SDP ${expectedAacConfigHex}.`);
  }
}

async function probeNativeAacEncoder(config) {
  let firstPacket = null;
  let configHex = "";
  let encoderError = null;
  let finishProbe = null;
  const probeDone = new Promise(resolve => { finishProbe = resolve; });
  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      if (!firstPacket) firstPacket = copyEncodedChunk(chunk);
      const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
      if (description && !configHex) configHex = bytesToHex(new Uint8Array(description));
      finishProbe();
    },
    error(error) {
      encoderError = error;
      finishProbe();
    }
  });

  try {
    encoder.configure(config);
    for (let i = 0; i < 20 && !firstPacket && !encoderError; i++) {
      const audioData = new AudioData({
        format: "s16",
        sampleRate,
        numberOfFrames: 1024,
        numberOfChannels: channels,
        timestamp: Math.round(i * 1024 * 1000000 / sampleRate),
        data: new Int16Array(1024 * channels).buffer
      });
      encoder.encode(audioData);
      audioData.close();
    }
    await Promise.race([probeDone, new Promise(resolve => setTimeout(resolve, 1500))]);
  } finally {
    try { encoder.close(); } catch (_) {}
  }

  if (encoderError) throw encoderError;
  validatePacket(firstPacket, configHex);
}

async function selectNativeAacConfig() {
  if (!("AudioEncoder" in globalThis)) throw new Error("AudioEncoder is missing in Worker.");
  if (!("AudioData" in globalThis)) throw new Error("AudioData is missing in Worker.");
  if (typeof AudioEncoder.isConfigSupported !== "function") {
    throw new Error("AudioEncoder.isConfigSupported is missing in Worker.");
  }

  const reasons = [];
  for (const [label, config] of nativeAacConfigs()) {
    try {
      const support = await AudioEncoder.isConfigSupported(config);
      if (!support.supported) {
        reasons.push(`${label}: supported=false`);
        continue;
      }
      const selected = support.config || config;
      await probeNativeAacEncoder(selected);
      return { config: selected, label };
    } catch (error) {
      reasons.push(`${label}: ${errorText(error)}`);
    }
  }

  throw new Error(`all AAC configs unsupported (${reasons.join("; ")})`);
}

function float32ToS16View(buffer) {
  const input = new Float32Array(buffer);
  if (!nativeS16Scratch || nativeS16Scratch.length < input.length) {
    nativeS16Scratch = new Int16Array(input.length);
  }

  const output = nativeS16Scratch;
  for (let i = 0; i < input.length; i++) {
    const sample = input[i];
    output[i] = sample <= -1 ? -32768 : sample >= 1 ? 32767 : sample < 0 ? sample * 32768 : sample * 32767;
  }
  return output.length === input.length ? output : output.subarray(0, input.length);
}

async function initNative() {
  const { config, label } = await selectNativeAacConfig();
  let configHex = "";
  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      if (mode !== "native") return;
      const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
      if (description) configHex = bytesToHex(new Uint8Array(description));

      const packet = copyEncodedChunk(chunk);
      try {
        validatePacket(packet, configHex);
      } catch (error) {
        self.postMessage({ type: "error", message: errorText(error) });
        return;
      }

      self.postMessage(
        { type: "packet", packet: packet.buffer, bytes: packet.byteLength },
        [packet.buffer]
      );
    },
    error(error) {
      if (mode === "native") self.postMessage({ type: "error", message: errorText(error) });
    }
  });

  encoder.configure(config);
  mode = "native";
  nativeEncoder = encoder;
  nativeNextTimestampUs = 0;
  self.postMessage({
    type: "ready",
    name: "Native WebCodecs AAC",
    detail: label,
    fallbackReason: ""
  });
}

function encodeNative(pcm) {
  if (!nativeEncoder) throw new Error("Native AAC encoder is not initialized.");
  const frameCount = pcm.byteLength / Float32Array.BYTES_PER_ELEMENT / channels;
  const audioData = new AudioData({
    format: "s16",
    sampleRate,
    numberOfFrames: frameCount,
    numberOfChannels: channels,
    timestamp: nativeNextTimestampUs,
    data: float32ToS16View(pcm)
  });
  nativeNextTimestampUs += Math.round(frameCount * 1000000 / sampleRate);
  nativeEncoder.encode(audioData);
  audioData.close();
}

function closeNative() {
  if (!nativeEncoder) return;
  try { nativeEncoder.close(); } catch (_) {}
  nativeEncoder = null;
  nativeS16Scratch = null;
  nativeNextTimestampUs = 0;
}

async function ensureModule() {
  if (module) return module;
  if (!modulePromise) modulePromise = import("./vendor/mediabunny-aac.js").then(mod => mod.default());
  module = await modulePromise;
  initEncoderFn = module.cwrap("init_encoder", "number", ["number", "number", "number"]);
  getEncoderFrameSizeFn = module.cwrap("get_encoder_frame_size", "number", ["number"]);
  getEncoderExtradataFn = module.cwrap("get_encoder_extradata", "number", ["number"]);
  getEncoderExtradataSizeFn = module.cwrap("get_encoder_extradata_size", "number", ["number"]);
  getEncodeInputPtrFn = module.cwrap("get_encode_input_ptr", "number", ["number", "number"]);
  sendFrameFn = module.cwrap("send_frame", "number", ["number", "number"]);
  receivePacketFn = module.cwrap("receive_packet", "number", ["number"]);
  getEncodedDataFn = module.cwrap("get_encoded_data", "number", ["number"]);
  getEncodedPtsFn = module.cwrap("get_encoded_pts", "number", ["number"]);
  closeEncoderFn = module.cwrap("close_encoder", null, ["number"]);
  return module;
}

function drainWasmPackets() {
  let size = 0;
  while ((size = receivePacketFn(ctx)) > 0) {
    const ptr = getEncodedDataFn(ctx);
    const pts = Number(getEncodedPtsFn(ctx));
    if (pts < 0) continue;

    const packet = module.HEAPU8.slice(ptr, ptr + size);
    self.postMessage(
      { type: "packet", packet: packet.buffer, bytes: packet.byteLength },
      [packet.buffer]
    );
  }
}

async function initWasm(fallbackReason) {
  await ensureModule();
  ctx = initEncoderFn(channels, sampleRate, bitrate);
  if (ctx === 0) throw new Error("Failed to initialize AAC encoder.");

  frameSize = getEncoderFrameSizeFn(ctx);
  inputBytesPerFrame = frameSize * channels * Float32Array.BYTES_PER_ELEMENT;
  nextTimestamp = 0;

  const extradataPtr = getEncoderExtradataFn(ctx);
  const extradataSize = getEncoderExtradataSizeFn(ctx);
  const extradata = module.HEAPU8.subarray(extradataPtr, extradataPtr + extradataSize);
  const configHex = bytesToHex(extradata);
  if (!configHex.startsWith(expectedAacConfigHex)) {
    throw new Error(`AAC config ${configHex} does not match RTSP SDP ${expectedAacConfigHex}.`);
  }

  mode = "wasm";
  self.postMessage({
    type: "ready",
    name: "WASM AAC",
    detail: "",
    fallbackReason,
    configHex
  });
}

function encodeWasm(pcm) {
  if (!ctx) throw new Error("WASM AAC encoder is not initialized.");

  const bytes = new Uint8Array(pcm);
  if (bytes.byteLength % inputBytesPerFrame !== 0) {
    throw new Error("PCM buffer does not contain whole AAC frames.");
  }

  for (let offset = 0; offset < bytes.byteLength; offset += inputBytesPerFrame) {
    const inputPtr = getEncodeInputPtrFn(ctx, inputBytesPerFrame);
    if (inputPtr === 0) throw new Error("Failed to allocate AAC input buffer.");

    module.HEAPU8.set(bytes.subarray(offset, offset + inputBytesPerFrame), inputPtr);
    const ret = sendFrameFn(ctx, BigInt(nextTimestamp));
    if (ret < 0) throw new Error(`AAC encode failed with code ${ret}.`);

    nextTimestamp += frameSize;
    drainWasmPackets();
  }
}

function closeWasm() {
  if (!ctx || !closeEncoderFn) return;
  closeEncoderFn(ctx);
  ctx = 0;
  frameSize = 0;
  inputBytesPerFrame = 0;
  nextTimestamp = 0;
}

function close() {
  mode = "";
  closeNative();
  closeWasm();
}

async function init(message) {
  close();
  sampleRate = message.sampleRate;
  channels = message.channels;
  bitrate = message.bitrate;
  expectedAacConfigHex = message.expectedAacConfigHex || expectedAacConfigHex;
  nativeAacBitrates = message.nativeAacBitrates || nativeAacBitrates;

  try {
    if (message.preferNative === false) throw new Error("Native AAC disabled.");
    await initNative();
  } catch (error) {
    const fallbackReason = limitText(errorText(error));
    closeNative();
    await initWasm(fallbackReason);
  }
}

function encode(pcm) {
  if (mode === "native") encodeNative(pcm);
  else if (mode === "wasm") encodeWasm(pcm);
  else throw new Error("AAC encoder is not initialized.");
}

self.onmessage = event => {
  const message = event.data;
  Promise.resolve()
    .then(async () => {
      if (message.type === "init") await init(message);
      else if (message.type === "encode") encode(message.pcm);
      else if (message.type === "close") close();
    })
    .catch(error => {
      self.postMessage({ type: "error", message: errorText(error) });
    });
};
