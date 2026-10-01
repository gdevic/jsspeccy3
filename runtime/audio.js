const ENABLE_OSCILLOSCOPE = false;

/* Buffers the emulator's audio between frames (which arrive in 20ms bursts,
 * paced by requestAnimationFrame) and the audio output (which pulls small
 * blocks at its own steady rate). Playback starts once `startSamples` are
 * queued, and restarts the same way after running dry, so a late frame
 * costs a short gap rather than a crackle on every block. If a burst of
 * frames queues more than `maxSamples`, the oldest audio is dropped down to
 * `trimSamples`, so latency can never build up.
 *
 * It must not refer to anything outside itself: its source text is also
 * what runs inside the AudioWorklet. */
class LatencyBuffer {
    constructor(size, startSamples, maxSamples, trimSamples) {
        this.left = new Float32Array(size);
        this.right = new Float32Array(size);
        this.size = size;
        this.startSamples = startSamples;
        this.maxSamples = maxSamples;
        this.trimSamples = trimSamples;
        this.readPtr = 0;
        this.available = 0;
        this.playing = false;
    }
    push(left, right) {
        const count = Math.min(left.length, this.size);
        let writePtr = (this.readPtr + this.available) % this.size;
        for (let i = 0; i < count; i++) {
            this.left[writePtr] = left[i];
            this.right[writePtr] = right[i];
            writePtr = (writePtr + 1) % this.size;
        }
        this.available = Math.min(this.available + count, this.size);
        if (this.available > this.maxSamples) {
            const drop = this.available - this.trimSamples;
            this.readPtr = (this.readPtr + drop) % this.size;
            this.available -= drop;
        }
    }
    pull(left, right) {
        if (!this.playing && this.available >= this.startSamples) this.playing = true;
        let count = 0;
        if (this.playing) {
            count = Math.min(left.length, this.available);
            for (let i = 0; i < count; i++) {
                left[i] = this.left[this.readPtr];
                right[i] = this.right[this.readPtr];
                this.readPtr = (this.readPtr + 1) % this.size;
            }
            this.available -= count;
            if (this.available === 0) this.playing = false;
        }
        left.fill(0, count);
        right.fill(0, count);
    }
}

/* The AudioWorklet side: a processor that owns a LatencyBuffer, fed frame
 * by frame through its message port. Loaded from a Blob URL, so the build
 * needs no separate worklet file. */
const WORKLET_SOURCE = `
const LatencyBuffer = ${LatencyBuffer.toString()};
class JSSpeccyAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = options.processorOptions;
        this.buffer = new LatencyBuffer(o.size, o.startSamples, o.maxSamples, o.trimSamples);
        this.port.onmessage = (e) => this.buffer.push(e.data.left, e.data.right);
    }
    process(inputs, outputs) {
        const output = outputs[0];
        this.buffer.pull(output[0], output[1] || output[0]);
        return true;
    }
}
registerProcessor('jsspeccy-audio', JSSpeccyAudioProcessor);
`;
let workletUrl = null;

/* The core's audio buffers hold 1024 samples (audioBufferLeft in
 * core.ts.in): a frame's worth at 48 kHz and what spills over into the next
 * frame. Output running faster than this gets a context at this rate, which
 * the browser resamples for the device. */
const MAX_SAMPLE_RATE = 48000;

/* A context made without a user gesture (autoStart, a dropped file, a
 * scripted start) starts suspended; the next of these on the page resumes
 * it. */
const RESUME_EVENTS = ['pointerdown', 'keydown', 'touchend'];
const isHeld = (audioContext) => (audioContext.state === 'suspended') || (audioContext.state === 'interrupted');

export class AudioHandler {
    constructor() {
        this.isActive = false;
        // While muted (Warp), frames still come and go but none of their sound is played.
        this.muted = false;

        if (ENABLE_OSCILLOSCOPE) {
            this.canvas = document.createElement('canvas');
            document.body.appendChild(this.canvas);
            this.canvasCtx = this.canvas.getContext('2d');
        }
    }
    start() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        let audioContext = new AudioContext({latencyHint: 'interactive'});
        if (audioContext.sampleRate > MAX_SAMPLE_RATE) {
            audioContext.close();
            audioContext = new AudioContext({latencyHint: 'interactive', sampleRate: MAX_SAMPLE_RATE});
        }
        this.audioContext = audioContext;
        this.samplesPerFrame = audioContext.sampleRate / 50;

        this.frameBuffers = [
            new ArrayBuffer(this.samplesPerFrame * 4),
            new ArrayBuffer(this.samplesPerFrame * 4)
        ];

        // Two frames queued before playing (frames arrive in bursts, up to
        // about 33ms apart), and never more than five: a burst beyond that is
        // trimmed back to two.
        const bufferOptions = {
            size: this.samplesPerFrame * 16,
            startSamples: this.samplesPerFrame * 2,
            maxSamples: this.samplesPerFrame * 5,
            trimSamples: this.samplesPerFrame * 2,
        };

        this.workletNode = null;
        this.scriptNode = null;
        // Frames that come while the worklet is still loading, played once it is in.
        this.pendingFrames = [];
        if (audioContext.audioWorklet && window.AudioWorkletNode) {
            // Runs on the audio thread, so a busy page can't starve the output.
            if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], {type: 'application/javascript'}));
            audioContext.audioWorklet.addModule(workletUrl).then(() => {
                if (this.audioContext !== audioContext || audioContext.state === 'closed') return;
                this.workletNode = new AudioWorkletNode(audioContext, 'jsspeccy-audio', {
                    numberOfInputs: 0,
                    outputChannelCount: [2],
                    processorOptions: bufferOptions,
                });
                this.workletNode.connect(audioContext.destination);
                for (const frame of this.pendingFrames) this.postFrame(frame.left, frame.right);
                this.pendingFrames = [];
            }).catch((e) => {
                console.warn('Audio worklet unavailable, falling back to ScriptProcessorNode:', e);
                this.startScriptProcessor(audioContext, bufferOptions);
            });
        } else {
            // AudioWorklet needs a secure context (https or localhost).
            this.startScriptProcessor(audioContext, bufferOptions);
        }

        this.isActive = true;
        this.resumeOnGesture(audioContext);

        if (ENABLE_OSCILLOSCOPE) {
            this.canvas.width = this.samplesPerFrame;
            this.canvas.height = 64;
        }
    }

    resumeOnGesture(audioContext) {
        if (!isHeld(audioContext)) return;
        const unwatch = () => RESUME_EVENTS.forEach(type => document.removeEventListener(type, resume, true));
        const resume = () => {
            if ((this.audioContext !== audioContext) || !isHeld(audioContext)) {
                unwatch();
                return;
            }
            audioContext.resume().then(() => {
                if (!isHeld(audioContext)) unwatch();
            }, () => {});
        };
        RESUME_EVENTS.forEach(type => document.addEventListener(type, resume, true));
        this.stopResumeWatch = unwatch;
    }

    /* Main-thread fallback. Its callbacks can be delayed by a busy page, but
     * the same LatencyBuffer keeps that from turning into growing lag. */
    startScriptProcessor(audioContext, bufferOptions) {
        if (this.audioContext !== audioContext || audioContext.state === 'closed') return;
        // Each callback takes a whole chunk, so the thresholds sit that much
        // higher than the worklet's.
        const chunk = 2048;
        const buffer = new LatencyBuffer(
            bufferOptions.size, chunk + bufferOptions.startSamples,
            chunk + bufferOptions.maxSamples, chunk + bufferOptions.trimSamples
        );
        this.scriptBuffer = buffer;
        this.scriptNode = audioContext.createScriptProcessor(chunk, 0, 2);
        this.scriptNode.onaudioprocess = (audioProcessingEvent) => {
            const outputBuffer = audioProcessingEvent.outputBuffer;
            buffer.pull(outputBuffer.getChannelData(0), outputBuffer.getChannelData(1));
        };
        this.scriptNode.connect(audioContext.destination);
    }

    stop() {
        if (!this.isActive) return;
        this.isActive = false;
        if (this.workletNode) this.workletNode.disconnect();
        if (this.scriptNode) this.scriptNode.disconnect();
        this.workletNode = null;
        this.scriptNode = null;
        this.pendingFrames = [];
        if (this.stopResumeWatch) this.stopResumeWatch();
        this.stopResumeWatch = null;
        this.audioContext.close();
    }

    frameCompleted(audioBufferLeft, audioBufferRight) {
        this.frameBuffers[0] = audioBufferLeft;
        this.frameBuffers[1] = audioBufferRight;

        if (!this.isActive || this.muted) return;

        // frameBuffers go back to the worker for the next frame, so the
        // output gets its own copy of the samples.
        const left = new Float32Array(audioBufferLeft);
        const right = new Float32Array(audioBufferRight);
        if (this.workletNode) {
            this.postFrame(left.slice(), right.slice());
        } else if (this.scriptNode) {
            this.scriptBuffer.push(left, right);
        } else {
            // Kept for the worklet, as many as its buffer would keep.
            this.pendingFrames.push({ left: left.slice(), right: right.slice() });
            if (this.pendingFrames.length > 5) this.pendingFrames.shift();
        }

        if (ENABLE_OSCILLOSCOPE) {
            this.drawOscilloscope(left, right);
        }
    }

    postFrame(left, right) {
        this.workletNode.port.postMessage({left, right}, [left.buffer, right.buffer]);
    }

    /* A frame the worker could not run: its buffers come back unfilled, and
     * are not played. */
    frameFailed(audioBufferLeft, audioBufferRight) {
        this.frameBuffers[0] = audioBufferLeft;
        this.frameBuffers[1] = audioBufferRight;
    }

    drawOscilloscope(leftData, rightData) {
        this.canvasCtx.fillStyle = '#000';
        this.canvasCtx.strokeStyle = '#0f0';
        this.canvasCtx.fillRect(0, 0, this.samplesPerFrame, 64);

        this.canvasCtx.beginPath();
        this.canvasCtx.moveTo(0, 16);
        for (let i = 0; i < this.samplesPerFrame; i++) {
            this.canvasCtx.lineTo(i, 16 - leftData[i] * 16);
        }
        this.canvasCtx.stroke();

        this.canvasCtx.beginPath();
        this.canvasCtx.moveTo(0, 48);
        for (let i = 0; i < this.samplesPerFrame; i++) {
            this.canvasCtx.lineTo(i, 48 - rightData[i] * 16);
        }
        this.canvasCtx.stroke();

    }
}
