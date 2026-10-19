// Audio thread: mono mic input at the device rate → 16 kHz Float32 chunks of 100 ms for the voice worker.
class PcmChunker extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000; // input samples per output sample (3 at 48 kHz, 2.756… at 44.1 kHz)
    this.position = 0; // fractional index into [previous sample, ...this block]
    this.previous = 0;
    this.chunk = new Float32Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const at = (index) => (index === 0 ? this.previous : input[index - 1]);
    // Linear interpolation; index 0 is the last sample of the previous block so blocks join without a seam.
    while (this.position < input.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      this.chunk[this.filled++] = at(index) + (at(index + 1) - at(index)) * fraction;
      if (this.filled === this.chunk.length) {
        this.port.postMessage(this.chunk);
        this.chunk = new Float32Array(1600);
        this.filled = 0;
      }
      this.position += this.step;
    }
    this.position -= input.length;
    this.previous = input[input.length - 1];
    return true;
  }
}

registerProcessor("pcm-chunker", PcmChunker);
