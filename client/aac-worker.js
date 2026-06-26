import createAacModule from "./vendor/mediabunny-aac.js";

let modulePromise = null;
let module = null;
let ctx = 0;
let frameSize = 0;
let inputBytesPerFrame = 0;
let nextTimestamp = 0;
let inputChannels = 0;
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

async function ensureModule() {
  if (module) return module;
  if (!modulePromise) modulePromise = createAacModule();
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

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function drainPackets() {
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

async function init({ sampleRate, channels, bitrate }) {
  await ensureModule();
  close();
  ctx = initEncoderFn(channels, sampleRate, bitrate);
  if (ctx === 0) throw new Error("Failed to initialize AAC encoder.");

  frameSize = getEncoderFrameSizeFn(ctx);
  inputChannels = channels;
  inputBytesPerFrame = frameSize * inputChannels * Float32Array.BYTES_PER_ELEMENT;
  nextTimestamp = 0;
  const extradataPtr = getEncoderExtradataFn(ctx);
  const extradataSize = getEncoderExtradataSizeFn(ctx);
  const extradata = module.HEAPU8.slice(extradataPtr, extradataPtr + extradataSize);
  self.postMessage({ type: "ready", frameSize, configHex: hex(extradata) });
}

function encode(pcm) {
  if (!ctx) throw new Error("AAC encoder is not initialized.");

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
    drainPackets();
  }
}

function close() {
  if (!ctx || !closeEncoderFn) return;
  closeEncoderFn(ctx);
  ctx = 0;
  frameSize = 0;
  inputBytesPerFrame = 0;
  inputChannels = 0;
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
      self.postMessage({ type: "error", message: error.message || String(error) });
    });
};
