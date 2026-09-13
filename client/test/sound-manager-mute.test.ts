import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundManager } from '../src/engine/audio/SoundManager.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

test('SoundManager defaults to music off and effects on with independent controls', () => {
  const sound = new SoundManager();
  assert.equal(sound.getMusicEnabled(), false);
  assert.equal(sound.getEffectsEnabled(), true);
  assert.equal(sound.getMuted(), false);

  sound.setMusicEnabled(true);
  assert.equal(sound.getMusicEnabled(), true);
  assert.equal(sound.getEffectsEnabled(), true);

  sound.setEffectsEnabled(false);
  assert.equal(sound.getMusicEnabled(), true);
  assert.equal(sound.getEffectsEnabled(), false);

  sound.toggleMusic();
  sound.toggleEffects();
  assert.equal(sound.getMusicEnabled(), false);
  assert.equal(sound.getEffectsEnabled(), true);

  // The legacy all-audio control remains an alias for both independent buses.
  sound.setMuted(true);
  assert.equal(sound.getMusicEnabled(), false);
  assert.equal(sound.getEffectsEnabled(), false);
  assert.equal(sound.getMuted(), true);

  sound.toggleMute();
  assert.equal(sound.getMusicEnabled(), true);
  assert.equal(sound.getEffectsEnabled(), true);
  assert.equal(sound.getMuted(), false);
});

test('SpaceUiStore controls and persists music and effects independently', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousGame = Object.getOwnPropertyDescriptor(globalThis, 'game');
  const values = new Map<string, string>();
  const sound = new SoundManager();
  let musicSetCalls = 0;
  let effectsSetCalls = 0;
  const setMusicEnabled = sound.setMusicEnabled.bind(sound);
  const setEffectsEnabled = sound.setEffectsEnabled.bind(sound);
  sound.setMusicEnabled = enabled => {
    musicSetCalls++;
    setMusicEnabled(enabled);
  };
  sound.setEffectsEnabled = enabled => {
    effectsSetCalls++;
    setEffectsEnabled(enabled);
  };
  const controller: any = {
    sound,
    fov: 75,
    perspective: 'first_person',
    thirdPersonDistance: 4
  };

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key)
    }
  });
  // The development global can reference the same manager. It must still
  // receive each setting exactly once.
  Object.defineProperty(globalThis, 'game', {
    configurable: true,
    value: { soundManager: sound }
  });

  try {
    const ui = new SpaceUiStore();
    ui.setController(controller);

    assert.equal(ui.getSnapshot().musicEnabled, false);
    assert.equal(ui.getSnapshot().effectsEnabled, true);
    assert.equal(sound.getMusicEnabled(), false);
    assert.equal(sound.getEffectsEnabled(), true);
    assert.equal(musicSetCalls, 1);
    assert.equal(effectsSetCalls, 1);

    ui.setMusicEnabled(true);
    assert.equal(ui.getSnapshot().musicEnabled, true);
    assert.equal(ui.getSnapshot().effectsEnabled, true);
    assert.equal(sound.getMusicEnabled(), true);
    assert.equal(values.get('space_setting_music_enabled'), 'true');
    assert.equal(musicSetCalls, 2, 'one shared manager must receive one music call');

    ui.setEffectsEnabled(false);
    assert.equal(ui.getSnapshot().musicEnabled, true);
    assert.equal(ui.getSnapshot().effectsEnabled, false);
    assert.equal(sound.getEffectsEnabled(), false);
    assert.equal(values.get('space_setting_effects_enabled'), 'false');
    assert.equal(effectsSetCalls, 2, 'one shared manager must receive one effects call');

    ui.toggleMusic();
    ui.toggleEffects();
    assert.equal(ui.getSnapshot().musicEnabled, false);
    assert.equal(ui.getSnapshot().effectsEnabled, true);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as any).localStorage;
    if (previousGame) Object.defineProperty(globalThis, 'game', previousGame);
    else delete (globalThis as any).game;
  }
});

test('SpaceUiStore migrates the legacy mute preference and prioritizes valid new keys', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousGame = Object.getOwnPropertyDescriptor(globalThis, 'game');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key)
    }
  });
  Object.defineProperty(globalThis, 'game', { configurable: true, value: undefined });

  const load = () => {
    const sound = new SoundManager();
    const ui = new SpaceUiStore();
    ui.setController({ sound, fov: 75, perspective: 'first_person', thirdPersonDistance: 4 });
    return { sound, state: ui.getSnapshot() };
  };

  try {
    let loaded = load();
    assert.equal(loaded.state.musicEnabled, false, 'music defaults off with no preference');
    assert.equal(loaded.state.effectsEnabled, true, 'effects default on with no preference');

    values.clear();
    values.set('space_setting_muted', 'true');
    loaded = load();
    assert.equal(loaded.sound.getMusicEnabled(), false);
    assert.equal(loaded.sound.getEffectsEnabled(), false);
    assert.equal(values.get('space_setting_music_enabled'), 'false');
    assert.equal(values.get('space_setting_effects_enabled'), 'false');

    values.clear();
    values.set('space_setting_muted', 'false');
    loaded = load();
    assert.equal(loaded.sound.getMusicEnabled(), true, 'an explicit legacy Sound ON is preserved');
    assert.equal(loaded.sound.getEffectsEnabled(), true);

    values.clear();
    values.set('space_setting_muted', 'true');
    values.set('space_setting_music_enabled', 'true');
    values.set('space_setting_effects_enabled', 'false');
    loaded = load();
    assert.equal(loaded.sound.getMusicEnabled(), true, 'new music key overrides legacy mute');
    assert.equal(loaded.sound.getEffectsEnabled(), false, 'new effects key overrides legacy mute');

    values.clear();
    values.set('space_setting_muted', 'false');
    values.set('space_setting_music_enabled', 'invalid');
    values.set('space_setting_effects_enabled', 'invalid');
    loaded = load();
    assert.equal(loaded.sound.getMusicEnabled(), false, 'invalid music state falls back off');
    assert.equal(loaded.sound.getEffectsEnabled(), true, 'invalid effects state falls back on');
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as any).localStorage;
    if (previousGame) Object.defineProperty(globalThis, 'game', previousGame);
    else delete (globalThis as any).game;
  }
});

test('enabling music before init creates and resumes Web Audio immediately', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let contextCount = 0;
  let fetchCount = 0;
  let resumeCount = 0;
  let sourceCount = 0;

  class FakeAudioContext {
    currentTime = 3;
    state = 'suspended';
    destination = {};

    constructor() {
      contextCount++;
    }

    createGain() {
      const param: any = {
        value: 1,
        setValueAtTime(value: number) { this.value = value; },
        cancelScheduledValues() {},
        cancelAndHoldAtTime() {},
        linearRampToValueAtTime(value: number) { this.value = value; }
      };
      return { gain: param, connect() {} };
    }

    createBufferSource() {
      sourceCount++;
      return {
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        connect() {},
        disconnect() {},
        start() {}
      };
    }

    async decodeAudioData() {
      return { duration: 30 };
    }

    async resume() {
      resumeCount++;
      this.state = 'running';
    }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: FakeAudioContext }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(8)
      };
    }
  });

  try {
    const sound = new SoundManager();
    sound.setMusicEnabled(true);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(contextCount, 1, 'the settings gesture should initialize Web Audio');
    assert.equal(resumeCount, 1, 'a suspended context should resume on enable');
    assert.equal(fetchCount, 1);
    assert.equal(sourceCount, 1);

    sound.setMusicEnabled(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(contextCount, 1);
    assert.equal(resumeCount, 1);
    assert.equal(fetchCount, 1);
    assert.equal(sourceCount, 1, 'repeated enable must retain one looping source');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as any).window;
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
    else delete (globalThis as any).fetch;
  }
});

test('SoundManager lazily starts one sample-accurate music source and reuses it across toggles', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const gainNodes: any[] = [];
  const sources: any[] = [];
  const requestedUrls: string[] = [];
  const decodedDuration = 11_768_192 / 48_000;
  const codecPreroll = 8_192 / 48_000;

  class FakeAudioContext {
    currentTime = 12;
    state = 'running';
    destination = { kind: 'destination' };

    createGain() {
      const events: any[] = [];
      const param: any = {
        value: 1,
        setValueAtTime(value: number, time: number) {
          this.value = value;
          events.push(['set', value, time]);
        },
        cancelScheduledValues: (time: number) => events.push(['cancel', time]),
        cancelAndHoldAtTime: (time: number) => events.push(['hold', time]),
        linearRampToValueAtTime(value: number, time: number) {
          this.value = value;
          events.push(['ramp', value, time]);
        }
      };
      const node = {
        events,
        gain: param,
        connect: (target: any) => events.push(['connect', target])
      };
      gainNodes.push(node);
      return node;
    }

    createBufferSource() {
      const source: any = {
        buffer: null,
        loop: false,
        loopStart: -1,
        loopEnd: -1,
        connectedTo: null,
        startedAt: null,
        startedOffset: null,
        connect(target: any) { this.connectedTo = target; },
        start(time: number, offset: number) {
          this.startedAt = time;
          this.startedOffset = offset;
        }
      };
      sources.push(source);
      return source;
    }

    async decodeAudioData() {
      return { duration: decodedDuration };
    }

    async resume() {}
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: FakeAudioContext }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (url: string) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(8)
      };
    }
  });

  try {
    const sound = new SoundManager();
    sound.init();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(sound.getMusicEnabled(), false);
    assert.equal(sound.getEffectsEnabled(), true);
    assert.equal(requestedUrls.length, 0, 'default-off music must not download');
    assert.equal(gainNodes.length, 3);
    assert.equal(sources.length, 0);
    assert.deepEqual(gainNodes[1].events[0], ['set', 1, 12]);
    assert.deepEqual(gainNodes[2].events[0], ['set', 0, 12]);

    sound.setMusicEnabled(true);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /bwv1043-ii-8bit\.ogg$/);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].loop, true);
    assert.equal(sources[0].loopStart, codecPreroll);
    assert.equal(sources[0].loopEnd, decodedDuration);
    assert.equal(sources[0].connectedTo, gainNodes[2]);
    assert.equal(sources[0].startedAt, 12);
    assert.equal(sources[0].startedOffset, codecPreroll);
    assert.deepEqual(gainNodes[2].events.slice(-3), [
      ['cancel', 12],
      ['set', 0, 12],
      ['ramp', 0.5, 13.5]
    ]);

    sound.setMusicEnabled(false);
    assert.equal(sound.getEffectsEnabled(), true, 'music never changes effects');
    assert.deepEqual(gainNodes[2].events.slice(-2), [
      ['hold', 12],
      ['ramp', 0, 12.2]
    ]);
    sound.setMusicEnabled(true);
    assert.deepEqual(gainNodes[2].events.slice(-2), [
      ['hold', 12],
      ['ramp', 0.5, 12.35]
    ]);

    // Repeated enable and pointer-lock init calls reuse the same source.
    sound.setMusicEnabled(true);
    sound.init();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requestedUrls.length, 1);
    assert.equal(sources.length, 1);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as any).window;
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
    else delete (globalThis as any).fetch;
  }
});

test('music disabled during loading stays silent and reuses the decoded buffer when enabled again', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const sources: any[] = [];
  let fetchCount = 0;
  let releaseFetch: (() => void) | null = null;

  class FakeAudioContext {
    currentTime = 4;
    state = 'running';
    destination = {};

    createGain() {
      const param: any = {
        value: 1,
        setValueAtTime(value: number) { this.value = value; },
        cancelScheduledValues() {},
        cancelAndHoldAtTime() {},
        linearRampToValueAtTime(value: number) { this.value = value; }
      };
      return { gain: param, connect() {} };
    }

    createBufferSource() {
      const source: any = {
        buffer: null,
        loop: false,
        connect() {},
        disconnect() {},
        start() { this.started = true; }
      };
      sources.push(source);
      return source;
    }

    async decodeAudioData() {
      return { duration: 30 };
    }

    async resume() {}
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: FakeAudioContext }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: () => {
      fetchCount++;
      return new Promise(resolve => {
        releaseFetch = () => resolve({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(8)
        });
      });
    }
  });

  try {
    const sound = new SoundManager();
    sound.init();
    sound.setMusicEnabled(true);
    assert.equal(fetchCount, 1);

    sound.setMusicEnabled(false);
    releaseFetch?.();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sources.length, 0, 'finishing a disabled load must not start playback');
    assert.ok((sound as any).musicBuffer, 'the decoded asset should remain cached');

    sound.setMusicEnabled(true);
    assert.equal(fetchCount, 1, 're-enabling must use the decoded asset');
    assert.equal(sources.length, 1);
    sound.setMusicEnabled(false);
    sound.setMusicEnabled(true);
    assert.equal(sources.length, 1, 'later toggles must reuse the looping source');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as any).window;
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
    else delete (globalThis as any).fetch;
  }
});

test('disabling effects gates every procedural sound without changing the music state', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const gainNodes: any[] = [];

  class FakeAudioContext {
    currentTime = 2;
    state = 'running';
    destination = {};

    createGain() {
      const events: any[] = [];
      const param: any = {
        value: 1,
        setValueAtTime(value: number) { this.value = value; },
        cancelScheduledValues() {},
        cancelAndHoldAtTime: (time: number) => events.push(['hold', time]),
        linearRampToValueAtTime(value: number, time: number) {
          this.value = value;
          events.push(['ramp', value, time]);
        }
      };
      const node = { gain: param, events, connect() {} };
      gainNodes.push(node);
      return node;
    }

    async resume() {}
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: FakeAudioContext }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: () => assert.fail('disabled-by-default music must not load')
  });

  try {
    const sound = new SoundManager();
    sound.init();
    const musicEvents = gainNodes[2].events.length;
    sound.setEffectsEnabled(false);
    assert.deepEqual(gainNodes[1].events.slice(-2), [
      ['hold', 2],
      ['ramp', 0, 2.02]
    ]);

    for (const method of [
      'playWrenchClick',
      'playGlueApply',
      'playAssemblyClack',
      'playDisassemblySound',
      'playSteamHiss',
      'playImpact',
      'playBlockPlace',
      'playBlockBreak'
    ]) {
      (sound as any)[method]();
    }

    assert.equal(gainNodes.length, 3, 'disabled effects must not create per-sound gain nodes');
    assert.equal(gainNodes[2].events.length, musicEvents, 'effects never touch the music bus');
    assert.equal(sound.getMusicEnabled(), false);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as any).window;
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
    else delete (globalThis as any).fetch;
  }
});

test('SoundManager plays cached, place-matched triangle fractures with bounded polyphony', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const gainNodes: any[] = [];
  const sources: any[] = [];
  const buffers: any[] = [];

  class FakeAudioContext {
    currentTime = 7;
    state = 'running';
    sampleRate = 48_000;
    destination = { kind: 'destination' };

    createGain() {
      const events: any[] = [];
      const param: any = {
        value: 1,
        setValueAtTime(value: number, time: number) {
          this.value = value;
          events.push(['set', value, time]);
        },
        linearRampToValueAtTime(value: number, time: number) {
          this.value = value;
          events.push(['linear', value, time]);
        },
        cancelScheduledValues: (time: number) => events.push(['cancel', time]),
        cancelAndHoldAtTime: (time: number) => events.push(['hold', time])
      };
      const node: any = {
        events,
        connectedTo: null,
        gain: param,
        connect(target: any) { this.connectedTo = target; },
        disconnect() { this.disconnected = true; }
      };
      gainNodes.push(node);
      return node;
    }

    createBuffer(_channels: number, frameCount: number, sampleRate: number) {
      const samples = new Float32Array(frameCount);
      const buffer = {
        duration: frameCount / sampleRate,
        length: frameCount,
        sampleRate,
        getChannelData: () => samples
      };
      buffers.push(buffer);
      return buffer;
    }

    createBufferSource() {
      const source: any = {
        buffer: null,
        connectedTo: null,
        startedAt: null,
        stopCalls: [] as number[],
        onended: null as null | (() => void),
        connect(target: any) { this.connectedTo = target; },
        start(time: number) { this.startedAt = time; },
        stop(time: number) { this.stopCalls.push(time); },
        disconnect() { this.disconnected = true; }
      };
      sources.push(source);
      return source;
    }

    async resume() {}
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: FakeAudioContext }
  });
  // Music is disabled by default, so this test should never request it.
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: () => new Promise(() => {})
  });

  try {
    const sound = new SoundManager();
    sound.init();
    sound.playBlockBreak({ kind: 'standard', count: 1 });

    assert.equal(sources.length, 1);
    assert.equal(buffers.length, 1);
    assert.equal(buffers[0].length, 5_520);
    assert.equal(sources[0].buffer, buffers[0]);
    assert.equal(sources[0].connectedTo, gainNodes[3]);
    assert.equal(gainNodes[3].connectedTo, gainNodes[1]);
    assert.equal(sources[0].startedAt, 7);
    assert.ok(Math.abs(sources[0].stopCalls[0] - 7.12) < 1e-9);
    assert.ok(Math.abs(gainNodes[3].events[0][1] - 0.194) < 1e-9);

    const standard = buffers[0].getChannelData(0);
    const peak = standard.reduce((highest: number, sample: number) => (
      Math.max(highest, Math.abs(sample))
    ), 0);
    assert.equal(standard[0], 0);
    assert.equal(standard.at(-1), 0);
    assert.ok(standard.every((sample: number) => Number.isFinite(sample)));
    assert.ok(peak > 0.87 && peak <= 0.89);
    const maxStep = standard.reduce((highest: number, sample: number, index: number) => (
      index === 0 ? highest : Math.max(highest, Math.abs(sample - standard[index - 1]))
    ), 0);
    assert.ok(maxStep < 0.1, 'the place-matched triangle must stay smooth and click-free');
    const rms = (values: Float32Array) => Math.sqrt(
      values.reduce((sum: number, sample: number) => sum + sample * sample, 0) / values.length
    );
    const quarter = Math.floor(standard.length / 4);
    assert.ok(
      rms(standard.slice(0, quarter)) > rms(standard.slice(-quarter)) * 2,
      'the baked envelope should decay like the placement sound'
    );

    const ctx = (sound as any).ctx;
    ctx.currentTime += 0.01;
    sound.playBlockBreak({ kind: 'micro' });
    sound.playBlockBreak({ kind: 'bulk', count: 64 });
    assert.equal(buffers[1].length, 3_072);
    assert.equal(buffers[2].length, 8_640);
    assert.ok(gainNodes[5].events[0][1] <= 0.21 * 1.18 * 1.03 + 1e-9);

    // Advance through the remaining variants. The seventh call reuses the
    // cached standard/variant-zero buffer, and active voices stay capped at 5.
    for (let index = 0; index < 4; index++) {
      sound.playBlockBreak({ kind: 'standard' });
    }
    assert.equal(buffers.length, 6);
    assert.equal(sources[6].buffer, buffers[0]);
    assert.equal((sound as any).activeBlockBreakVoices.size, 5);
    assert.equal(sources[0].stopCalls.length, 2);
    assert.deepEqual(gainNodes[3].events.slice(-3).map((event: any[]) => event[0]), [
      'cancel',
      'set',
      'linear'
    ]);
    assert.ok(Math.abs(sources[5].startedAt - 7.017) < 1e-9);
    assert.ok(Math.abs(sources[6].startedAt - 7.017) < 1e-9);

    // The evicted sources fade until the exact instant their replacements
    // start, so no event boundary has more than five live source nodes.
    const eventTimes = new Set<number>();
    for (const source of sources) {
      eventTimes.add(source.startedAt);
      eventTimes.add(source.stopCalls.at(-1));
    }
    for (const eventTime of eventTimes) {
      const live = sources.filter(source => (
        source.startedAt <= eventTime && eventTime < source.stopCalls.at(-1)
      ));
      assert.ok(live.length <= 5, `at most five sources may overlap at ${eventTime}`);
    }

    sources[6].onended();
    assert.equal((sound as any).activeBlockBreakVoices.size, 4);
    assert.equal(sources[6].disconnected, true);

    const sourceCount = sources.length;
    sound.setEffectsEnabled(false);
    assert.equal(sound.getMusicEnabled(), false);
    sound.playBlockBreak();
    assert.equal(sources.length, sourceCount);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as any).window;
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
    else delete (globalThis as any).fetch;
  }
});
