class SourceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gain = 1;
    this.mute = false;
    this.forceMono = false;
    this.levelPeak = 0;
    this.levelFrames = 0;
    this.levelInterval = Math.round(sampleRate / 15);
    this.port.onmessage = event => {
      if (event.data && event.data.type === "settings") {
        const gain = Number(event.data.gain);
        this.gain = Number.isFinite(gain) ? Math.min(4, Math.max(0, gain)) : 1;
        this.mute = Boolean(event.data.mute);
        this.forceMono = Boolean(event.data.forceMono);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const leftOut = output && output[0] ? output[0] : null;
    const rightOut = output && output[1] ? output[1] : leftOut;
    if (!leftOut) return true;

    const leftIn = input && input[0] ? input[0] : null;
    if (!leftIn || this.mute) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);
      this.reportLevel(leftOut.length, 0);
      return true;
    }

    const rightIn = input[1] || leftIn;
    let blockPeak = 0;
    for (let i = 0; i < leftOut.length; i++) {
      let left;
      let right;
      if (this.forceMono) {
        left = (leftIn[i] + rightIn[i]) * 0.5 * this.gain;
        right = left;
      } else {
        left = leftIn[i] * this.gain;
        right = rightIn[i] * this.gain;
      }
      if (left > 1) left = 1;
      else if (left < -1) left = -1;
      if (right > 1) right = 1;
      else if (right < -1) right = -1;
      leftOut[i] = left;
      if (rightOut !== leftOut) rightOut[i] = right;
      const absLeft = left < 0 ? -left : left;
      const absRight = right < 0 ? -right : right;
      const peak = absLeft > absRight ? absLeft : absRight;
      if (peak > blockPeak) blockPeak = peak;
    }
    this.reportLevel(leftOut.length, blockPeak);
    return true;
  }

  reportLevel(frames, peak) {
    this.levelPeak = Math.max(this.levelPeak, peak);
    this.levelFrames += frames;
    if (this.levelFrames < this.levelInterval) return;
    this.port.postMessage({ type: "level", peak: this.levelPeak });
    this.levelFrames = 0;
    this.levelPeak = 0;
  }
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.frames = config.frames || 1024;
    this.channels = config.channels || 2;
    this.pcm = new Float32Array(this.frames * this.channels);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const monitorOut = output && output[0] ? output[0] : null;
    const input = inputs[0];
    const leftIn = input && input[0] ? input[0] : null;
    const rightIn = input && input[1] ? input[1] : leftIn;
    const frameCount = leftIn ? leftIn.length : monitorOut ? monitorOut.length : 128;

    let sourceOffset = 0;
    while (sourceOffset < frameCount) {
      const take = Math.min(this.frames - this.offset, frameCount - sourceOffset);
      for (let i = 0; i < take; i++) {
        const destination = (this.offset + i) * this.channels;
        const source = sourceOffset + i;
        let left = leftIn ? leftIn[source] : 0;
        let right = rightIn ? rightIn[source] : left;
        if (left > 1) left = 1;
        else if (left < -1) left = -1;
        if (right > 1) right = 1;
        else if (right < -1) right = -1;
        this.pcm[destination] = left;
        this.pcm[destination + 1] = right;
        if (monitorOut) monitorOut[source] = (left + right) * 0.5;
      }
      this.offset += take;
      sourceOffset += take;

      if (this.offset === this.frames) {
        const pcm = this.pcm;
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.pcm = new Float32Array(this.frames * this.channels);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("source-processor", SourceProcessor);
registerProcessor("capture-processor", CaptureProcessor);
