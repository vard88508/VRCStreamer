const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const workerSource = readFileSync(join(__dirname, "../scripts/video-worker.js"), "utf8");

function loadWorker() {
  const clock = { now: 0 };
  const messages = [];
  const context = vm.createContext({
    self: {},
    clearTimeout() {},
    recordFrame,
    performance: { now: () => clock.now },
    postMessage: message => messages.push(message)
  });
  vm.runInContext(workerSource, context);
  return { clock, context, messages, Control: vm.runInContext("VideoRateControl", context) };
}

const { Control: RateControl } = loadWorker();

function createControl(bitrate, frameRate, now) {
  const control = new RateControl();
  control.reset(bitrate, frameRate, now);
  return control;
}

// Submit an in-flight frame's QP without changing the controller's current decision.
function recordFrame(control, bytes, now, frameQuantizer) {
  const current = control.quantizer;
  control.quantizer = frameQuantizer;
  control.submit(now * 1000);
  control.quantizer = current;
  control.record(bytes, now, now * 1000);
}

test("the controller and encoder reserve 15 percent of the preset bitrate", () => {
  const worker = loadWorker();
  for (const limit of [2500000, 3000001, 6000000]) {
    const control = createControl(limit, 30, 0);
    const target = Math.floor(limit * 0.85);
    assert.equal(control.budget, target);
    assert.equal(vm.runInContext(`encoderConfig(1280, 720, 30, ${limit}).bitrate`, worker.context), target);
  }
});

// Synthetic encoder: one IDR per second, two in-flight frames, and a QP-dependent byte size.
// This exercises feedback and the server's token bucket, not a hardware quality model.
function simulate(limit, fps, bitrateAtQP28, motion = () => 1, seconds = 150) {
  const control = createControl(limit, fps, 0);
  const pending = [control.quantizer, control.quantizer];
  const samples = [];
  let bytes = 0;
  let serverCredit = limit / 8 * 2;
  let minimumCredit = serverCredit;
  for (let index = 0; index < fps * seconds; index++) {
    const now = (index + 1) * 1000 / fps;
    const previousMinimum = control.minQuantizer;
    const previousExpiry = control.blockedUntil;
    const qp = pending.shift();
    pending.push(control.quantizer);
    const weight = (index % fps === 0 ? 8 : 1) * fps / (fps + 7);
    const bitrate = bitrateAtQP28 * motion(index / fps) * 2 ** ((28 - qp) / 6);
    const size = Math.round(bitrate * weight / fps / 8) + 5;
    serverCredit = Math.min(limit / 8 * 2, serverCredit + limit / 8 / fps) - size;
    minimumCredit = Math.min(minimumCredit, serverCredit);
    const previousQP = control.quantizer;
    recordFrame(control, size, now, qp);
    if (control.quantizer > previousQP) {
      assert.equal(control.quantizer, control.minQuantizer, "QP increases only to the blocked boundary");
      assert.equal(control.minQuantizer, Math.min(51, qp + 1), "only the overflowing QP and better levels are blocked");
      assert.ok(control.blockedUntil > now, "every QP increase has an active block");
    }
    bytes += size;
    if ((index + 1) % fps === 0) {
      const previousQP = control.quantizer;
      control.update(bytes * 8, 1, now, true);
      assert.ok(previousQP - control.quantizer === 0 || previousQP - control.quantizer === 2);
      samples.push(bytes * 8);
      if (samples.length > 10) samples.shift();
      bytes = 0;
    }
    assert.ok(Number.isFinite(control.smoothedBitrate));
    assert.ok(control.available >= 0 && control.available <= control.capacity);
    assert.ok(Number.isInteger(control.quantizer) && control.quantizer >= 18 && control.quantizer <= 51);
    assert.ok(control.quantizer >= control.minQuantizer);
    if (now < previousExpiry) assert.ok(control.minQuantizer >= previousMinimum, "the block cannot weaken before expiry");
  }
  return {
    control,
    minimumCredit,
    bitrate: samples.reduce((sum, sample) => sum + sample, 0) / samples.length
  };
}

test("larger budgets improve the same content without a preset-specific QP floor", () => {
  const publicStream = simulate(2500000, 30, 2500000);
  const privateStream = simulate(6000000, 30, 2500000);
  assert.ok(privateStream.control.quantizer < 28);
  assert.ok(privateStream.control.quantizer < publicStream.control.quantizer);
  assert.ok(privateStream.bitrate > publicStream.bitrate * 1.8);
  assert.ok(publicStream.minimumCredit >= 0);
  assert.ok(privateStream.minimumCredit >= 0);
});

test("different budgets and frame rates converge without preset-specific tuning", () => {
  for (const fps of [1, 5, 15, 30, 60, 144]) {
    for (const limit of [64000, 2500000, 6000000, 50000000]) {
      const result = simulate(limit, fps, limit * 2);
      // At low FPS, sequential QP trials can outlast the server's two-second startup allowance.
      if (fps >= 30) assert.ok(result.minimumCredit >= 0, `server budget exceeded at ${fps} FPS / ${limit} bps`);
      assert.ok(result.bitrate <= limit, `sustained rate exceeded at ${fps} FPS / ${limit} bps`);
      assert.ok(result.bitrate > limit * 0.5, `quality did not recover at ${fps} FPS / ${limit} bps`);
    }
  }
});

test("action scene bursts settle and keep the quality ceiling during its cooldown", () => {
  for (const fps of [15, 30, 60, 144]) {
    for (const limit of [2500000, 6000000, 50000000]) {
      const result = simulate(limit, fps, limit * 2, time => time >= 60 && time < 80 ? 3 : 1);
      if (fps >= 30) assert.ok(result.minimumCredit >= 0, `server budget exceeded at ${fps} FPS / ${limit} bps`);
      // The final ten-second average can still spend the bounded burst allowance.
      assert.ok(result.bitrate > 0 && result.bitrate <= limit + result.control.capacity / 10);
    }
  }
});

test("low-QP startup is not a hard bitrate guarantee before low-FPS feedback converges", () => {
  const result = simulate(2500000, 15, 5000000);
  assert.ok(result.minimumCredit < 0, "a large startup burst can exceed a short server allowance");
  assert.ok(result.bitrate <= 2500000, "the controller must still converge to the selected budget");
});

test("burst response runs per packet, before the statistics timer", () => {
  const control = createControl(2000000, 30, 0);
  control.setQuantizer(24, 0);
  recordFrame(control, control.capacity / 8 * 0.8, 10, 24);
  assert.equal(control.quantizer, 24, "a short burst should fit the allowance");
  recordFrame(control, control.capacity / 8, 200, 24);
  assert.ok(control.quantizer > 24);
  const afterBurst = control.quantizer;
  control.update(0, 1, 500, true);
  assert.equal(control.quantizer, afterBurst, "do not immediately undo a burst correction");
});

test("repeated overshoots from an old QP cannot raise the current QP again", () => {
  const control = createControl(6000000, 30, 0);
  control.setQuantizer(25, 0);
  recordFrame(control, control.capacity / 8 * 2, 200, 25);
  const corrected = control.quantizer;
  assert.equal(corrected, 26);
  recordFrame(control, control.capacity / 8, 230, 25);
  recordFrame(control, control.capacity / 8, 260, 25);
  assert.equal(control.quantizer, corrected);
  assert.equal(control.minQuantizer, corrected);
  recordFrame(control, control.capacity / 8 * 2, 500, 25);
  assert.equal(control.quantizer, corrected, "even late output must not stack a correction onto the current QP");
  recordFrame(control, control.capacity / 8 * 2, 700, corrected);
  assert.equal(control.quantizer, 27);
  assert.equal(control.minQuantizer, control.quantizer);
});

test("only the overflowing QP and better levels stay blocked for 15 seconds", () => {
  const control = createControl(6000000, 30, 0);
  control.setQuantizer(24, 0);
  recordFrame(control, control.capacity / 8 * 2, 200, 24);
  assert.equal(control.minQuantizer, 25);
  assert.equal(control.quantizer, 25);
  assert.equal(control.blockedUntil, 15200);
  for (let second = 1; second <= 15; second++) control.update(1000, 1, second * 1000, true);
  assert.equal(control.quantizer, 25, "recovery must not undo the blocked correction");
  control.setQuantizer(0, 15001);
  assert.equal(control.quantizer, 25);
  recordFrame(control, control.capacity / 8 * 2, 16000, 28);
  assert.equal(control.minQuantizer, 29);
  recordFrame(control, control.capacity / 8, 16001, 24);
  assert.equal(control.minQuantizer, 29, "late frames must not weaken the ban");
  const restarted = createControl(6000000, 30, 17000);
  assert.equal(restarted.minQuantizer, 0);
  assert.equal(restarted.quantizer, 24);
  recordFrame(control, control.capacity / 8 * 2, 16500, 39);
  control.reset(6000000, 30, 17000, true);
  assert.equal(control.quantizer, 40, "startup must also respect a retained floor");
  assert.equal(control.blockedUntil, 31500, "reconfiguration must not restart the cooldown");
});

test("expiry allows gradual recovery, not an immediate jump in quality", () => {
  const control = createControl(6000000, 30, 0);
  control.setQuantizer(24, 0);
  recordFrame(control, control.capacity / 8 * 2, 200, 24);
  for (let second = 1; second <= 15; second++) control.update(1000, 1, second * 1000, true);
  control.update(1000, 0.199, 15199, true);
  assert.equal(control.quantizer, 25);
  assert.equal(control.minQuantizer, 25);
  control.update(1000, 0.001, 15200, true);
  assert.equal(control.minQuantizer, 0);
  assert.equal(control.blockedUntil, 0);
  assert.equal(control.quantizer, 23);
  control.update(1000, 0.001, 15201, true);
  assert.equal(control.quantizer, 23, "expiry does not bypass the recovery interval");
});

test("a new overshoot renews the 15 seconds, but expiry alone does not force quality recovery", () => {
  const control = createControl(6000000, 30, 0);
  recordFrame(control, control.capacity / 8 * 2, 200, 24);
  recordFrame(control, control.capacity / 8 * 2, 10000, 26);
  assert.equal(control.blockedUntil, 25000);
  const corrected = control.quantizer;
  control.update(control.budget, 1, 15200, false);
  assert.equal(control.minQuantizer, 27);
  control.update(control.budget, 1, 25000, false);
  assert.equal(control.minQuantizer, 0);
  assert.equal(control.quantizer, corrected);
});

test("an expired ban is not inherited or revived by a new overshoot after a pause", () => {
  const control = createControl(6000000, 30, 0);
  recordFrame(control, control.capacity / 8 * 2, 200, 39);
  control.reset(6000000, 30, 15200, true);
  assert.equal(control.minQuantizer, 0);
  assert.equal(control.blockedUntil, 0);
  assert.equal(control.quantizer, 24);
  recordFrame(control, control.capacity / 8 * 2, 70000, 24);
  assert.equal(control.minQuantizer, 25);
  assert.equal(control.blockedUntil, 85000);
});

test("short allowed bursts do not ban a quality level", () => {
  const control = createControl(6000000, 30, 0);
  control.setQuantizer(24, 0);
  recordFrame(control, control.capacity / 8 * 0.9, 200, 24);
  assert.equal(control.minQuantizer, 0);
  assert.equal(control.quantizer, 24);
});

test("overshoot size never bans untested QP levels", () => {
  for (const multiplier of [1.001, 2, 100]) {
    const control = createControl(6000000, 30, 0);
    recordFrame(control, control.capacity / 8 * multiplier, 200, 24);
    assert.equal(control.minQuantizer, 25);
    assert.equal(control.quantizer, 25);
    assert.equal(control.blockedUntil, 15200);
  }
});

test("starts at QP 24 and improves by exactly two steps per adjustment", () => {
  const control = createControl(6000000, 30, 0);
  assert.equal(control.quantizer, 24);
  control.update(1000, 1, 1000, true);
  assert.equal(control.quantizer, 22);
  control.update(1000, 1, 2000, true);
  assert.equal(control.quantizer, 20);
});

test("recovery respects recent load and QP stays within encoder bounds", () => {
  const control = createControl(6000000, 30, 0);
  control.setQuantizer(28, 0);
  control.update(control.budget * 4, 1, 1000, true);
  control.update(control.budget * 0.1, 1, 2000, true);
  assert.equal(control.quantizer, 28, "retain recent load instead of following one quiet sample");
  for (let second = 3; second <= 70; second++) {
    const previous = control.quantizer;
    control.update(1000, 1, second * 1000, true);
    assert.ok(previous - control.quantizer === 0 || previous - control.quantizer === 2);
  }
  assert.equal(control.quantizer, 18);
  for (let tick = 1; tick <= 60; tick++) recordFrame(control, 1e9, 70000 + tick * 100, control.quantizer);
  assert.equal(control.quantizer, 51);
});

test("recovery does not round a two-step change down to one at a boundary", () => {
  for (const [floor, start, expected] of [[0, 20, 18], [0, 21, 19], [25, 28, 26], [26, 28, 26]]) {
    const control = createControl(6000000, 30, 0);
    control.minQuantizer = floor;
    control.blockedUntil = 15000;
    control.setQuantizer(start, 0);
    for (let second = 1; second <= 4; second++) control.update(1000, 1, second * 1000, true);
    assert.equal(control.quantizer, expected);
  }
});

test("QP 18 is a permanent floor, not a temporary block", () => {
  const control = createControl(6000000, 30, 0);
  control.setQuantizer(0, 0);
  assert.equal(control.quantizer, 18);
  assert.equal(control.blockedMinimum(0), 0);
  recordFrame(control, control.capacity / 8 * 2, 200, 18);
  assert.equal(control.quantizer, 19);
  assert.equal(control.blockedMinimum(200), 19);
  control.update(1000, 15, 15200, true);
  assert.equal(control.blockedMinimum(15200), 0);
  assert.equal(control.quantizer, 19, "a two-step recovery must not cross the permanent floor");
  control.setQuantizer(0, 15201);
  assert.equal(control.quantizer, 18);
  assert.equal(control.blockedMinimum(15201), 0);
});

test("low encoder FPS cannot be mistaken for room to improve quality", () => {
  const control = createControl(2500000, 60, 0);
  control.setQuantizer(30, 0);
  for (let second = 1; second <= 20; second++) control.update(1000, 1, second * 1000, false);
  assert.equal(control.quantizer, 30);
  control.update(1000, 1, 21000, true);
  assert.equal(control.quantizer, 28);
});

test("pauses do not accumulate an unlimited burst allowance or a catch-up QP change", () => {
  const control = createControl(6000000, 60, 0);
  control.setQuantizer(25, 0);
  recordFrame(control, 1000, 1, 25);
  recordFrame(control, 1000, 36000000, 25);
  assert.equal(control.available, control.capacity - 8000);
  control.update(1000, 36000, 36000000, true);
  assert.equal(control.quantizer, 23);
});

test("worker accounts for the complete packet and resets measurements on preset changes", () => {
  const worker = loadWorker();
  vm.runInContext("bitrateLimit = 6000000; fps = 30; resetRateControl();", worker.context);
  const chunk = { type: "key", byteLength: 1234, timestamp: 1000000, copyTo() {} };
  worker.context.chunk = chunk;
  vm.runInContext("rateControl.submit(chunk.timestamp); sendVideoPacket(chunk, new Uint8Array(15));", worker.context);
  assert.equal(worker.messages[0].packet.byteLength, 1234 + 15 + 5);
  assert.equal(vm.runInContext("encodedBytes", worker.context), 1234 + 15 + 5);
  assert.equal(vm.runInContext("rateControl.capacity - rateControl.available", worker.context), (1234 + 15 + 5) * 8);
  worker.clock.now = 1000;
  vm.runInContext("bitrateLimit = 2500000; fps = 60; resetRateControl();", worker.context);
  assert.equal(vm.runInContext("rateControl.budget", worker.context), 2125000);
  assert.equal(vm.runInContext("rateControl.quantizer", worker.context), 24);
  assert.equal(vm.runInContext("encodedBytes - lastEncodedBytes", worker.context), 0);
  assert.equal(vm.runInContext("lastStatsAt", worker.context), 1000);
});

test("worker remembers the submitted frame QP even when the current QP changes before output", () => {
  const worker = loadWorker();
  vm.runInContext(`
    closed = false; paused = false; networkPaused = false;
    bitrateLimit = 6000000; fps = 30; resetRateControl(); rateControl.setQuantizer(24, 0);
    createOutputFrame = () => ({ close() {} });
    encoder = { state: "configured", encodeQueueSize: 0, encode(frame, options) { self.encodedQP = options.avc.quantizer; } };
    submitFrame(null, true, 1000000, 33333);
    rateControl.setQuantizer(32, 100);
  `, worker.context);
  assert.equal(vm.runInContext("self.encodedQP", worker.context), 24);
  worker.clock.now = 200;
  worker.context.chunk = {
    type: "key", timestamp: 1000000, copyTo() {},
    byteLength: vm.runInContext("rateControl.capacity / 8 * 2", worker.context)
  };
  vm.runInContext("sendVideoPacket(chunk, null);", worker.context);
  assert.equal(vm.runInContext("rateControl.minQuantizer", worker.context), 25);
  assert.equal(vm.runInContext("rateControl.quantizer", worker.context), 32, "old output must not raise the current QP independently");
  assert.equal(vm.runInContext("rateControl.frameTimestamps.includes(1000000)", worker.context), false);
});

test("out-of-order encoder output blocks the QP used by each frame", () => {
  const control = createControl(6000000, 30, 0);
  assert.equal(control.submit(100), 24);
  control.setQuantizer(28, 0);
  assert.equal(control.submit(200), 28);
  control.setQuantizer(32, 0);
  control.record(control.capacity / 8 * 2, 200, 200);
  assert.equal(control.minQuantizer, 29);
  control.record(control.capacity / 8 * 2, 201, 100);
  assert.equal(control.minQuantizer, 29);
  assert.equal(control.quantizer, 32);
  assert.ok(control.frameTimestamps.every(timestamp => timestamp === -1));
});

test("reset reuses the bounded frame history and clears measurements and stale metadata", () => {
  const control = createControl(6000000, 30, 0);
  const timestamps = control.frameTimestamps;
  const quantizers = control.frameQuantizers;
  recordFrame(control, control.capacity / 8 * 2, 200, 24);
  control.submit(123456);
  control.reset(2500000, 60, 1000, true);
  assert.equal(control.frameTimestamps, timestamps);
  assert.equal(control.frameQuantizers, quantizers);
  assert.ok(timestamps.every(timestamp => timestamp === -1));
  assert.equal(control.frameSlot, 0);
  assert.equal(control.adjustments, 0);
  assert.equal(control.available, control.capacity);
  assert.equal(control.smoothedBitrate, control.budget);
  assert.equal(control.minQuantizer, 25);
  assert.equal(control.blockedUntil, 15200);
  control.reset(6000000, 30, 1100);
  assert.equal(control.frameTimestamps, timestamps);
  assert.equal(control.minQuantizer, 0);
  assert.equal(control.blockedUntil, 0);
  assert.equal(control.quantizer, 24);
});

test("missing frame QP metadata still creates a visible block for a conservative correction", () => {
  const worker = loadWorker();
  vm.runInContext(`
    resetRateControl(); rateControl.setQuantizer(24, 0);
    for (let i = 0; i < QUANTIZER_HISTORY_SIZE + 1; i++) rateControl.submit(i);
    rateControl.record(rateControl.capacity / 8 * 2, 200, 0);
  `, worker.context);
  assert.equal(vm.runInContext("rateControl.minQuantizer", worker.context), 25);
  assert.equal(vm.runInContext("rateControl.quantizer", worker.context), 25);
  assert.equal(vm.runInContext("rateControl.blockedUntil", worker.context), 15200);
  worker.clock.now = 200;
  vm.runInContext("postStats();", worker.context);
  assert.equal(worker.messages.at(-1).stats.minQuantizer, 25);
  assert.equal(worker.messages.at(-1).stats.quantizer, 25);
  assert.equal(vm.runInContext("rateControl.frameQuantizers[rateControl.frameTimestamps.indexOf(QUANTIZER_HISTORY_SIZE)]", worker.context), 24);
  assert.equal(vm.runInContext("rateControl.frameTimestamps.length", worker.context), 64);
  vm.runInContext("resetRateControl();", worker.context);
  assert.equal(vm.runInContext("rateControl.frameTimestamps.includes(1)", worker.context), false);
});

test("reconfiguration retains the ban for the same resolution and clears it for a new resolution", async () => {
  const worker = loadWorker();
  worker.context.VideoEncoder = class {
    static async isConfigSupported(config) { return { supported: true, config }; }
    configure() {}
    async flush() {}
    close() {}
  };
  vm.runInContext(`
    closed = false; width = 1280; height = 720; fps = 30; bitrateLimit = 2500000;
    resetRateControl(); recordFrame(rateControl, rateControl.capacity / 8 * 2, 200, 28);
    encoder = new VideoEncoder(); canvas = {};
  `, worker.context);
  worker.clock.now = 10000;
  await vm.runInContext("reconfigure({ width: 1280, height: 720, fps: 60, bitrate: 6000000 });", worker.context);
  assert.equal(worker.messages.at(-1).type, "reconfigured");
  assert.equal(vm.runInContext("rateControl.minQuantizer", worker.context), 29);
  assert.equal(vm.runInContext("rateControl.blockedUntil", worker.context), 15200);
  await vm.runInContext("reconfigure({ width: 1920, height: 1080, fps: 60, bitrate: 6000000 });", worker.context);
  assert.equal(worker.messages.at(-1).type, "reconfigured");
  assert.equal(vm.runInContext("rateControl.minQuantizer", worker.context), 0);
  assert.equal(vm.runInContext("rateControl.blockedUntil", worker.context), 0);
  vm.runInContext("recordFrame(rateControl, rateControl.capacity / 8 * 2, 10100, 29);", worker.context);
  worker.context.VideoEncoder.isConfigSupported = async config => ({ supported: false, config });
  await vm.runInContext("reconfigure({ width: 1280, height: 720, fps: 30, bitrate: 2500000 });", worker.context);
  assert.equal(worker.messages.at(-1).type, "reconfigure-error");
  assert.equal(vm.runInContext("rateControl.minQuantizer", worker.context), 30);
  assert.equal(vm.runInContext("rateControl.blockedUntil", worker.context), 25100);
});

test("worker does not improve quality during placeholders or transport pauses", () => {
  const worker = loadWorker();
  vm.runInContext("closed = false; bitrateLimit = 6000000; fps = 30; resetRateControl(); rateControl.setQuantizer(28, 0);", worker.context);
  for (const state of ["placeholder = true;", "placeholder = false; networkPaused = true;", "networkPaused = false; paused = true;"]) {
    worker.clock.now += 1000;
    vm.runInContext(`${state} encoded += 30; encodedBytes += 1000; postStats();`, worker.context);
    assert.equal(vm.runInContext("rateControl.quantizer", worker.context), 28);
  }
});

test("statistics clear expired blocks even while video is paused", () => {
  const worker = loadWorker();
  vm.runInContext("resetRateControl(); recordFrame(rateControl, rateControl.capacity / 8 * 2, 200, 24);", worker.context);
  worker.clock.now = 15199;
  vm.runInContext("postStats();", worker.context);
  assert.equal(worker.messages.at(-1).stats.minQuantizer, 25);
  worker.clock.now = 15200;
  vm.runInContext("postStats();", worker.context);
  assert.equal(worker.messages.at(-1).stats.minQuantizer, 0);
});

test("long-running feedback remains bounded", () => {
  const result = simulate(2500000, 30, 2500000, time => 1 + 2 * (Math.floor(time / 30) % 2), 36000);
  assert.ok(result.minimumCredit >= 0);
  assert.ok(result.bitrate <= 2500000);
});
