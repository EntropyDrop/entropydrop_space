// Procedural Web Audio sound generator and music player for Space.

const MUSIC_CODEC_PREROLL_SECONDS = 8_192 / 48_000;
const BACKGROUND_MUSIC_GAIN = 0.5;
const BLOCK_BREAK_VARIANT_COUNT = 6;
const MAX_BLOCK_BREAK_VOICES = 5;
const BLOCK_TONE_START_HZ = 280;
const BLOCK_TONE_END_HZ = 120;
const BLOCK_PLACE_GLIDE_SECONDS = 0.08;

type BlockBreakKind = 'micro' | 'standard' | 'bulk';

type BlockBreakOptions = {
  kind?: BlockBreakKind;
  count?: number;
};

type ActiveBlockBreakVoice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  level: number;
  startedAt: number;
};

export class SoundManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicBuffer: AudioBuffer | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicStartPromise: Promise<void> | null = null;
  private blockBreakSerial = 0;
  private blockBreakBuffers = new Map<string, AudioBuffer>();
  private activeBlockBreakVoices = new Set<ActiveBlockBreakVoice>();
  private musicEnabled = false;
  private effectsEnabled = true;

  constructor() {
    this.ctx = null;
    this.masterGain = null;
  }

  init() {
    // requestLock calls init on every user gesture. Re-entering lets an enabled
    // soundtrack retry a transient load failure without duplicating its source.
    if (this.ctx) {
      if (this.musicEnabled) void this.startBackgroundMusic();
      return;
    }
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.3, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);

      this.effectsGain = this.ctx.createGain();
      this.effectsGain.gain.setValueAtTime(this.effectsEnabled ? 1 : 0, this.ctx.currentTime);
      this.effectsGain.connect(this.masterGain);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.setValueAtTime(0, this.ctx.currentTime);
      this.musicGain.connect(this.masterGain);
      if (this.musicEnabled) void this.startBackgroundMusic();
    } catch (e) {
      console.warn('Web Audio API not supported:', e);
    }
  }

  private rampBus(gain: GainNode, target: number, duration: number, from?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const param = gain.gain;
    const now = ctx.currentTime;
    try {
      if (from !== undefined) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(from, now);
      } else if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(now);
      } else {
        const current = Number.isFinite(param.value) ? param.value : target;
        param.cancelScheduledValues(now);
        param.setValueAtTime(current, now);
      }
      param.linearRampToValueAtTime(target, now + duration);
    } catch {
      try { param.setValueAtTime(target, now); } catch { }
    }
  }

  private startDecodedMusic(ctx: AudioContext, musicGain: GainNode): void {
    if (!this.musicEnabled || this.musicSource || !this.musicBuffer || this.ctx !== ctx) return;

    const source = ctx.createBufferSource();
    source.buffer = this.musicBuffer;
    source.loop = true;
    source.loopStart = MUSIC_CODEC_PREROLL_SECONDS;
    source.loopEnd = this.musicBuffer.duration;
    source.connect(musicGain);

    const now = ctx.currentTime;
    try {
      source.start(now, MUSIC_CODEC_PREROLL_SECONDS);
      this.musicSource = source;
      this.rampBus(musicGain, BACKGROUND_MUSIC_GAIN, 1.5, 0);
    } catch (error) {
      try { source.disconnect(); } catch { }
      console.warn('Space background music could not start:', error);
    }
  }

  private startBackgroundMusic(): void {
    const ctx = this.ctx;
    const musicGain = this.musicGain;
    if (!ctx || !musicGain || !this.musicEnabled) return;
    if (this.musicSource) {
      this.rampBus(musicGain, BACKGROUND_MUSIC_GAIN, 0.35);
      return;
    }
    if (this.musicBuffer) {
      this.startDecodedMusic(ctx, musicGain);
      return;
    }
    if (this.musicStartPromise) return;

    const musicUrl = new URL('../../assets/audio/bwv1043-ii-8bit.ogg', import.meta.url).href;
    this.musicStartPromise = (async () => {
      const response = await fetch(musicUrl);
      if (!response.ok) throw new Error(`Background music request failed: ${response.status}`);
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());

      // A toggle may have changed while decoding. Keep the decoded buffer, but
      // only create the one looping source when music is still enabled.
      if (this.ctx !== ctx) return;
      this.musicBuffer = buffer;
      this.startDecodedMusic(ctx, musicGain);
    })()
      .catch(error => {
        console.warn('Space background music is temporarily unavailable:', error);
      })
      .finally(() => {
        this.musicStartPromise = null;
      });
  }

  ensureContext() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = Boolean(enabled);
    if (!this.musicEnabled) {
      if (this.musicGain) this.rampBus(this.musicGain, 0, 0.2);
      return;
    }
    // This setter is normally reached from a settings click, so use that
    // gesture to create or resume Web Audio and start playback immediately.
    // Keeping this inside the enabled branch preserves default-off lazy load.
    if (typeof window !== 'undefined') this.ensureContext();
    if (this.ctx) void this.startBackgroundMusic();
  }

  getMusicEnabled(): boolean {
    return this.musicEnabled;
  }

  toggleMusic(): boolean {
    this.setMusicEnabled(!this.musicEnabled);
    return this.musicEnabled;
  }

  setEffectsEnabled(enabled: boolean): void {
    this.effectsEnabled = Boolean(enabled);
    if (this.effectsGain) this.rampBus(this.effectsGain, this.effectsEnabled ? 1 : 0, 0.02);
  }

  getEffectsEnabled(): boolean {
    return this.effectsEnabled;
  }

  toggleEffects(): boolean {
    this.setEffectsEnabled(!this.effectsEnabled);
    return this.effectsEnabled;
  }

  /** Legacy all-audio master mute retained for older callers. */
  setMuted(muted: boolean) {
    const enabled = !Boolean(muted);
    this.setMusicEnabled(enabled);
    this.setEffectsEnabled(enabled);
  }

  getMuted(): boolean {
    return !this.musicEnabled && !this.effectsEnabled;
  }

  toggleMute(): boolean {
    const muted = !this.getMuted();
    this.setMuted(muted);
    return muted;
  }

  // Wrench ratchet sound
  playWrenchClick() {
    this.ensureContext();
    if (!this.ctx || !this.effectsGain || !this.effectsEnabled) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.06);

    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

    osc.connect(gain);
    gain.connect(this.effectsGain);

    osc.start(t);
    osc.stop(t + 0.07);
  }

  // Super glue apply sound
  playGlueApply() {
    this.ensureContext();
    if (!this.ctx || !this.effectsGain || !this.effectsEnabled) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.linearRampToValueAtTime(440, t + 0.08);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    osc.connect(gain);
    gain.connect(this.effectsGain);

    osc.start(t);
    osc.stop(t + 0.13);
  }

  // Mechanical Assembly: "Ka-Chink! Clack-clack!"
  playAssemblyClack() {
    this.ensureContext();
    if (!this.ctx || !this.effectsGain || !this.effectsEnabled) return;

    const t = this.ctx.currentTime;

    // Pulse 1: Low mechanical clunk
    const osc1 = this.ctx.createOscillator();
    const gain1 = this.ctx.createGain();
    osc1.type = 'square';
    osc1.frequency.setValueAtTime(140, t);
    osc1.frequency.exponentialRampToValueAtTime(50, t + 0.15);
    gain1.gain.setValueAtTime(0.4, t);
    gain1.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
    osc1.connect(gain1);
    gain1.connect(this.effectsGain);
    osc1.start(t);
    osc1.stop(t + 0.16);

    // Pulse 2: High metallic latch
    const osc2 = this.ctx.createOscillator();
    const gain2 = this.ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1200, t + 0.06);
    osc2.frequency.exponentialRampToValueAtTime(400, t + 0.22);
    gain2.gain.setValueAtTime(0.3, t + 0.06);
    gain2.gain.exponentialRampToValueAtTime(0.01, t + 0.22);
    osc2.connect(gain2);
    gain2.connect(this.effectsGain);
    osc2.start(t + 0.06);
    osc2.stop(t + 0.23);
  }

  // Disassembly uncouple sound
  playDisassemblySound() {
    this.ensureContext();
    if (!this.ctx || !this.effectsGain || !this.effectsEnabled) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(450, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.18);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.18);

    osc.connect(gain);
    gain.connect(this.effectsGain);

    osc.start(t);
    osc.stop(t + 0.19);
  }

  // Steam hiss (filtered white noise)
  playSteamHiss() {
    this.ensureContext();
    if (!this.ctx || !this.effectsGain || !this.effectsEnabled) return;

    const bufferSize = this.ctx.sampleRate * 0.25;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 1.5;

    const gain = this.ctx.createGain();
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.effectsGain);

    noise.start(t);
    noise.stop(t + 0.26);
  }

  // Physics Impact Thud
  playImpact() {
    this.ensureContext();
    if (!this.ctx || !this.effectsGain || !this.effectsEnabled) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(35, t + 0.18);

    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    osc.connect(gain);
    gain.connect(this.effectsGain);

    osc.start(t);
    osc.stop(t + 0.19);
  }

  // Block place / break
  playBlockPlace() {
    this.ensureContext();
    if (!this.ctx || !this.effectsGain || !this.effectsEnabled) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(BLOCK_TONE_START_HZ, t);
    osc.frequency.exponentialRampToValueAtTime(BLOCK_TONE_END_HZ, t + BLOCK_PLACE_GLIDE_SECONDS);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + BLOCK_PLACE_GLIDE_SECONDS);

    osc.connect(gain);
    gain.connect(this.effectsGain);

    osc.start(t);
    osc.stop(t + 0.09);
  }

  private getBlockBreakBuffer(kind: BlockBreakKind, variant: number): AudioBuffer {
    const key = `${kind}:${variant}`;
    const cached = this.blockBreakBuffers.get(key);
    if (cached) return cached;

    const ctx = this.ctx!;
    const settings = kind === 'micro'
      ? {
          duration: 0.064,
          taps: [
            { start: 0, duration: 0.045, pitchScale: 1.22, level: 1 },
            { start: 0.018, duration: 0.038, pitchScale: 0.92, level: 0.44 }
          ]
        }
      : kind === 'bulk'
        ? {
            duration: 0.18,
            taps: [
              { start: 0, duration: 0.1, pitchScale: 0.78, level: 1 },
              { start: 0.045, duration: 0.1, pitchScale: 0.58, level: 0.68 },
              { start: 0.095, duration: 0.07, pitchScale: 0.86, level: 0.38 }
            ]
          }
        : {
            duration: 0.115,
            taps: [
              { start: 0, duration: BLOCK_PLACE_GLIDE_SECONDS, pitchScale: 1, level: 1 },
              { start: 0.031, duration: 0.068, pitchScale: 0.72, level: 0.56 }
            ]
          };
    const frameCount = Math.ceil(ctx.sampleRate * settings.duration);
    const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    const pitchRatios = [0.96, 1, 1.035, 0.98, 1.02, 0.985];
    const timingOffsets = [-0.003, 0, 0.003, -0.001, 0.002, -0.002];
    const secondaryLevels = [0.97, 1, 1.04, 0.98, 1.02, 0.96];

    // Break keeps the exact triangle/glide language of block placement. A
    // second soft tap makes standard blocks read as splitting in two; bulk
    // deletion adds one more low tap. No noise, pulse wave, clicks, or bitcrush.
    settings.taps.forEach((tap, tapIndex) => {
      const startSeconds = tap.start + (tapIndex === 0 ? 0 : timingOffsets[variant]);
      const startFrame = Math.max(0, Math.round(startSeconds * ctx.sampleRate));
      const durationFrames = Math.max(2, Math.round(tap.duration * ctx.sampleRate));
      const attackFrames = Math.max(1, Math.round(ctx.sampleRate * 0.0015));
      const releaseFrames = Math.max(2, Math.round(ctx.sampleRate * 0.007));
      const pitchRatio = pitchRatios[variant] * tap.pitchScale;
      const level = tap.level * (tapIndex === 0 ? 1 : secondaryLevels[variant]);
      let phase = 0;

      for (let localFrame = 0; localFrame < durationFrames; localFrame++) {
        const frame = startFrame + localFrame;
        if (frame >= frameCount) break;
        const progress = localFrame / (durationFrames - 1);
        const frequency = BLOCK_TONE_START_HZ * pitchRatio
          * (BLOCK_TONE_END_HZ / BLOCK_TONE_START_HZ) ** progress;
        phase = (phase + frequency / ctx.sampleRate) % 1;
        const triangle = 1 - 4 * Math.abs(phase - 0.5);
        const attackProgress = Math.min(1, localFrame / attackFrames);
        const attack = 0.5 - 0.5 * Math.cos(Math.PI * attackProgress);
        const releaseStart = durationFrames - releaseFrames;
        const releaseProgress = localFrame <= releaseStart
          ? 0
          : Math.min(1, (localFrame - releaseStart) / (durationFrames - 1 - releaseStart));
        const release = 0.5 + 0.5 * Math.cos(Math.PI * releaseProgress);
        const decay = 20 ** (-progress);
        samples[frame] += triangle * attack * decay * release * level;
      }
    });

    let peak = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      peak = Math.max(peak, Math.abs(samples[frame]));
    }

    const normalization = 0.88 / Math.max(peak, 1e-6);
    for (let frame = 0; frame < frameCount; frame++) {
      samples[frame] *= normalization;
    }
    samples[0] = 0;
    samples[frameCount - 1] = 0;

    this.blockBreakBuffers.set(key, buffer);
    return buffer;
  }

  private makeRoomForBlockBreak(now: number): number {
    if (this.activeBlockBreakVoices.size < MAX_BLOCK_BREAK_VOICES) return now;
    const oldest = [...this.activeBlockBreakVoices]
      .sort((left, right) => left.startedAt - right.startedAt)[0];
    this.activeBlockBreakVoices.delete(oldest);
    const handoffAt = now + 0.007;
    oldest.gain.gain.cancelScheduledValues(now);
    oldest.gain.gain.setValueAtTime(oldest.level, now);
    oldest.gain.gain.linearRampToValueAtTime(0.001, now + 0.006);
    try {
      oldest.source.stop(handoffAt);
    } catch { }
    // Start the replacement as the faded voice stops. The tiny handoff keeps
    // the hard five-voice ceiling without introducing a discontinuity click.
    return handoffAt;
  }

  playBlockBreak(options: BlockBreakOptions = {}) {
    this.ensureContext();
    if (!this.ctx || !this.effectsGain || !this.effectsEnabled) return;

    const t = this.ctx.currentTime;
    const kind: BlockBreakKind = options.kind === 'micro' || options.kind === 'bulk'
      ? options.kind
      : 'standard';
    const count = Math.max(1, Math.floor(Number(options.count) || 1));
    const variant = this.blockBreakSerial++ % BLOCK_BREAK_VARIANT_COUNT;
    const buffer = this.getBlockBreakBuffer(kind, variant);
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    const baseGain = kind === 'micro' ? 0.14 : kind === 'bulk' ? 0.21 : 0.2;
    const countGain = kind === 'bulk'
      ? Math.min(1.18, 1 + 0.05 * Math.log2(count))
      : 1;
    const variationGain = [0.97, 1, 0.99, 1.03, 0.98, 1.01][variant];
    const level = baseGain * countGain * variationGain;

    const startAt = this.makeRoomForBlockBreak(t);
    source.buffer = buffer;
    gain.gain.setValueAtTime(level, startAt);
    source.connect(gain);
    gain.connect(this.effectsGain);

    const voice: ActiveBlockBreakVoice = { source, gain, level, startedAt: startAt };
    this.activeBlockBreakVoices.add(voice);
    source.onended = () => {
      this.activeBlockBreakVoices.delete(voice);
      source.disconnect();
      gain.disconnect();
    };
    source.start(startAt);
    source.stop(startAt + buffer.duration + 0.005);
  }
}
