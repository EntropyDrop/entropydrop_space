#!/usr/bin/env python3
"""Render an 8-bit arrangement of Bach's BWV 1043, movement II.

The notes and rhythms come from the public-domain 1874 Bach-Gesellschaft
score distributed by the Mutopia Project.  This renderer uses no third-party
recording or samples: it reads the bundled MIDI score and synthesizes every
sound with pulse, triangle, and deterministic LFSR-noise channels.

The Largo ma non tanto keeps the public-domain score's pitches and relative
rhythms, transposed one octave down, while using a dotted-quarter pulse of
48 BPM. Bars 1-49 form the loop;
their closing dominant resolves into the opening F-major chord, which replaces
the score's redundant final tonic bar. A short copy of the loop tail primes the
Vorbis decoder; playback starts after that hidden codec-preroll.
"""

from __future__ import annotations

import argparse
import hashlib
import math
import struct
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


SAMPLE_RATE = 48_000
FRAMES_PER_BEAT = 40_000
BPM = 60.0 * SAMPLE_RATE / FRAMES_PER_BEAT
BEAT_SECONDS = FRAMES_PER_BEAT / SAMPLE_RATE
TICKS_PER_QUARTER = 384
TICKS_PER_EIGHTH = TICKS_PER_QUARTER // 2
PICKUP_TICKS = 0
TICKS_PER_BAR = TICKS_PER_QUARTER * 6
BAR_COUNT = 49
SCORE_END_TICK = BAR_COUNT * TICKS_PER_BAR
SCORE_FRAME_COUNT = round(SCORE_END_TICK * FRAMES_PER_BEAT / TICKS_PER_QUARTER)
CODEC_PREROLL_FRAMES = 8_192
FRAME_COUNT = CODEC_PREROLL_FRAMES + SCORE_FRAME_COUNT
assert FRAME_COUNT % 64 == 0
DURATION_SECONDS = FRAME_COUNT / SAMPLE_RATE
LOOP_DURATION_SECONDS = SCORE_FRAME_COUNT / SAMPLE_RATE
RNG_SEED = 0x0B1043
SOURCE_MIDI = Path(__file__).with_name("sources") / "bwv1043-ii.mid"
SOURCE_SHA256 = "563120106bd3d51335a51f156c810f4fd3ed631d521f353adf50036541854ebd"
PITCH_TRANSPOSE = -12


@dataclass(frozen=True)
class MidiNote:
    track: int
    channel: int
    pitch: int
    velocity: int
    start_tick: int
    end_tick: int


@dataclass(frozen=True)
class MidiScore:
    ticks_per_quarter: int
    tracks: tuple[tuple[MidiNote, ...], ...]
    tempos: tuple[tuple[int, int], ...]
    time_signatures: tuple[tuple[int, int, int], ...]


def read_vlq(data: bytes, position: int) -> tuple[int, int]:
    value = 0
    while True:
        byte = data[position]
        position += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, position


def read_midi(path: Path) -> MidiScore:
    """Read the small subset of Standard MIDI needed by the bundled score."""
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError(f"Unexpected score checksum: {digest}")
    if data[:4] != b"MThd":
        raise ValueError("Source is not a Standard MIDI file")

    header_length = struct.unpack(">I", data[4:8])[0]
    midi_format, track_count, division = struct.unpack(">HHH", data[8:14])
    if midi_format != 1 or division & 0x8000:
        raise ValueError("Expected format-1 MIDI with ticks-per-quarter timing")

    position = 8 + header_length
    all_tracks: list[tuple[MidiNote, ...]] = []
    tempos: list[tuple[int, int]] = []
    signatures: list[tuple[int, int, int]] = []

    for track_index in range(track_count):
        if data[position : position + 4] != b"MTrk":
            raise ValueError(f"Missing MTrk chunk at track {track_index}")
        chunk_length = struct.unpack(">I", data[position + 4 : position + 8])[0]
        track_data = data[position + 8 : position + 8 + chunk_length]
        position += 8 + chunk_length

        cursor = 0
        absolute_tick = 0
        running_status: int | None = None
        active: dict[tuple[int, int], list[tuple[int, int]]] = {}
        notes: list[MidiNote] = []

        while cursor < len(track_data):
            delta, cursor = read_vlq(track_data, cursor)
            absolute_tick += delta
            status = track_data[cursor]
            if status < 0x80:
                if running_status is None:
                    raise ValueError("Invalid MIDI running status")
                status = running_status
            else:
                cursor += 1
                if status < 0xF0:
                    running_status = status

            if status == 0xFF:
                meta_type = track_data[cursor]
                cursor += 1
                payload_length, cursor = read_vlq(track_data, cursor)
                payload = track_data[cursor : cursor + payload_length]
                cursor += payload_length
                if meta_type == 0x51 and payload_length == 3:
                    tempos.append((absolute_tick, int.from_bytes(payload, "big")))
                elif meta_type == 0x58 and payload_length >= 2:
                    signatures.append((absolute_tick, payload[0], 2 ** payload[1]))
                continue

            if status in (0xF0, 0xF7):
                payload_length, cursor = read_vlq(track_data, cursor)
                cursor += payload_length
                running_status = None
                continue

            message_type = status & 0xF0
            channel = status & 0x0F
            payload_length = 1 if message_type in (0xC0, 0xD0) else 2
            payload = track_data[cursor : cursor + payload_length]
            cursor += payload_length

            if message_type == 0x90 and payload[1] > 0:
                key = (channel, payload[0])
                active.setdefault(key, []).append((absolute_tick, payload[1]))
            elif message_type == 0x80 or (message_type == 0x90 and payload[1] == 0):
                key = (channel, payload[0])
                starts = active.get(key)
                if starts:
                    start_tick, velocity = starts.pop()
                    if absolute_tick > start_tick:
                        notes.append(
                            MidiNote(
                                track_index,
                                channel,
                                payload[0],
                                velocity,
                                start_tick,
                                absolute_tick,
                            )
                        )

        dangling = sum(len(starts) for starts in active.values())
        if dangling:
            raise ValueError(f"Track {track_index} has {dangling} unterminated notes")
        notes.sort(key=lambda note: (note.start_tick, note.pitch, note.end_tick))
        all_tracks.append(tuple(notes))

    score = MidiScore(division, tuple(all_tracks), tuple(tempos), tuple(signatures))
    expected_counts = (0, 575, 624, 218, 217, 212, 387)
    actual_counts = tuple(len(track) for track in score.tracks)
    if score.ticks_per_quarter != TICKS_PER_QUARTER or actual_counts != expected_counts:
        raise ValueError(
            f"Unexpected score structure: division={score.ticks_per_quarter}, notes={actual_counts}"
        )
    if (0, 1_250_000) not in score.tempos or (0, 12, 8) not in score.time_signatures:
        raise ValueError("Expected Mutopia tempo marker and 12/8 time signature")
    if max(note.end_tick for track in score.tracks for note in track) != 113_472:
        raise ValueError("Unexpected source-score ending")
    first_solo_one = score.tracks[1][0]
    first_solo_two = score.tracks[2][0]
    if (first_solo_one.start_tick, first_solo_one.end_tick, first_solo_one.pitch) != (4_608, 5_376, 84):
        raise ValueError("Unexpected Solo Violin I entrance")
    if (first_solo_two.start_tick, first_solo_two.end_tick, first_solo_two.pitch) != (0, 768, 77):
        raise ValueError("Unexpected Solo Violin II opening")
    if any((track[-1].start_tick, track[-1].end_tick) != (112_896, 113_472) for track in score.tracks[1:]):
        raise ValueError("Unexpected final tonic chord")
    return score


def midi_frequency(note: float) -> float:
    return 440.0 * (2.0 ** ((note - 69.0) / 12.0))


def tick_to_frame(tick: int) -> int:
    return round(tick * FRAMES_PER_BEAT / TICKS_PER_QUARTER)


def equal_power_pan(pan: float) -> tuple[float, float]:
    angle = (np.clip(pan, -1.0, 1.0) + 1.0) * math.pi / 4.0
    return math.cos(angle), math.sin(angle)


def wrapped_add(
    destination: np.ndarray,
    mono: np.ndarray,
    start_frame: int,
    gain: float = 1.0,
    pan: float = 0.0,
) -> None:
    """Add an event and fold any tail crossing the loop boundary."""
    left, right = equal_power_pan(pan)
    loop_frames = len(destination)
    offset = start_frame % loop_frames
    consumed = 0
    remaining = len(mono)
    while remaining:
        count = min(remaining, loop_frames - offset)
        part = mono[consumed : consumed + count] * gain
        destination[offset : offset + count, 0] += part * left
        destination[offset : offset + count, 1] += part * right
        consumed += count
        remaining -= count
        offset = 0


def raised_cosine_envelope(
    length: int,
    attack_seconds: float,
    release_seconds: float,
) -> np.ndarray:
    envelope = np.ones(length, dtype=np.float32)
    attack = min(length, max(1, round(attack_seconds * SAMPLE_RATE)))
    release = min(length, max(1, round(release_seconds * SAMPLE_RATE)))
    envelope[:attack] *= np.sin(np.linspace(0.0, math.pi / 2.0, attack)) ** 2
    envelope[-release:] *= np.sin(np.linspace(math.pi / 2.0, 0.0, release)) ** 2
    return envelope


def normalize_peak(values: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(values)))
    return (values / max(peak, 1e-9)).astype(np.float32)


def poly_blep(phase: np.ndarray, phase_increment: float) -> np.ndarray:
    """Return a PolyBLEP correction for one discontinuity in a unit phase."""
    correction = np.zeros_like(phase)
    leading = phase < phase_increment
    x = phase[leading] / phase_increment
    correction[leading] = x + x - x * x - 1.0
    trailing = phase > 1.0 - phase_increment
    x = (phase[trailing] - 1.0) / phase_increment
    correction[trailing] = x * x + x + x + 1.0
    return correction


def pulse_wave(frequency: float, length: int, duty: float) -> np.ndarray:
    """Generate an anti-aliased, phase-reset pulse wave with no DC offset."""
    phase_increment = frequency / SAMPLE_RATE
    phase = np.mod(np.arange(length, dtype=np.float64) * phase_increment, 1.0)
    wave = np.where(phase < duty, 1.0, -1.0)
    wave += poly_blep(phase, phase_increment)
    wave -= poly_blep(np.mod(phase - duty, 1.0), phase_increment)
    wave -= np.mean(wave)

    # Equal-RMS duty normalization keeps the two soloists balanced. The 0.55
    # scale leaves headroom for the taller peaks of the narrow pulse channel.
    rms = math.sqrt(float(np.mean(np.square(wave, dtype=np.float64))))
    return (wave * (0.55 / max(rms, 1e-9))).astype(np.float32)


def triangle_wave(frequency: float, length: int) -> np.ndarray:
    """Generate the console-style triangle channel and quantize it to 32 levels."""
    phase = np.mod(np.arange(length, dtype=np.float64) * frequency / SAMPLE_RATE, 1.0)
    wave = 1.0 - 4.0 * np.abs(phase - 0.5)
    wave = np.round((wave + 1.0) * 15.5) / 15.5 - 1.0
    return wave.astype(np.float32)


def stepped_envelope(length: int, profile: str) -> np.ndarray:
    """Create a 240 Hz, 4-bit APU envelope with click-safe short slews."""
    control_frames = SAMPLE_RATE // 240
    if profile == "pulse25":
        attack_levels, sustain_level, release_levels = (15, 14, 13, 12), 10, (8, 5, 2, 0)
        attack_seconds, release_seconds = 0.0010, 0.012
    elif profile == "pulse50":
        attack_levels, sustain_level, release_levels = (14, 13, 12), 11, (8, 4, 0)
        attack_seconds, release_seconds = 0.0010, 0.010
    elif profile == "pulse12":
        attack_levels, sustain_level, release_levels = (15, 13), 9, (6, 2, 0)
        attack_seconds, release_seconds = 0.0008, 0.007
    else:  # triangle
        attack_levels, sustain_level, release_levels = (15, 14), 13, (9, 5, 2, 0)
        attack_seconds, release_seconds = 0.0012, 0.014

    control_count = max(1, math.ceil(length / control_frames))
    levels = np.full(control_count, sustain_level, dtype=np.float32)
    attack_count = min(control_count, len(attack_levels))
    levels[:attack_count] = attack_levels[:attack_count]
    release_count = min(control_count, len(release_levels))
    levels[-release_count:] = release_levels[-release_count:]
    envelope = np.repeat(levels / 15.0, control_frames)[:length]

    # Smooth only the first 12 samples after each control step. The levels stay
    # audibly discrete, while their edges do not become louder than the notes.
    for boundary in np.flatnonzero(np.diff(envelope)) + 1:
        end = min(length, boundary + 12)
        envelope[boundary:end] = np.linspace(
            envelope[boundary - 1], envelope[boundary], end - boundary, endpoint=False
        )
    envelope *= raised_cosine_envelope(length, attack_seconds, release_seconds)
    return envelope.astype(np.float32)


def chip_note(frequency: float, score_seconds: float, profile: str) -> np.ndarray:
    """Synthesize one retriggered pulse or triangle-channel score note."""
    gate = 0.985 if profile in ("pulse25", "pulse50", "triangle") else 1.0
    length = max(16, round(score_seconds * gate * SAMPLE_RATE))
    if profile == "triangle":
        tone = triangle_wave(frequency, length)
        if frequency < 65.0:
            # Preserve the low-octave fundamental while giving phone speakers
            # a quiet octave harmonic to reproduce below-bass continuo notes.
            tone = normalize_peak(tone + 0.18 * triangle_wave(frequency * 2.0, length))
    else:
        duty = {"pulse25": 0.25, "pulse50": 0.50, "pulse12": 0.125}[profile]
        tone = pulse_wave(frequency, length, duty)
    return tone * stepped_envelope(length, profile)


def lfsr_noise(length: int, hold_frames: int, seed: int, short_mode: bool) -> np.ndarray:
    """Generate a deterministic 15-bit console noise channel."""
    count = math.ceil(length / hold_frames)
    register = seed & 0x7FFF or 1
    values = np.empty(count, dtype=np.float32)
    tap = 6 if short_mode else 1
    for index in range(count):
        feedback = (register & 1) ^ ((register >> tap) & 1)
        register = (register >> 1) | (feedback << 14)
        values[index] = 1.0 - 2.0 * (register & 1)
    return np.repeat(values, hold_frames)[:length]


def stepped_decay(length: int, levels: tuple[int, ...]) -> np.ndarray:
    positions = np.minimum(
        np.arange(length, dtype=np.int64) * len(levels) // max(length, 1),
        len(levels) - 1,
    )
    return np.asarray(levels, dtype=np.float32)[positions] / 15.0


def chip_kick(seed: int) -> np.ndarray:
    length = round(0.115 * SAMPLE_RATE)
    step_frames = round(0.0065 * SAMPLE_RATE)
    frequencies = np.asarray((145.0, 110.0, 82.0, 62.0, 52.0), dtype=np.float64)
    indices = np.minimum(np.arange(length) // step_frames, len(frequencies) - 1)
    phase = np.mod(np.cumsum(frequencies[indices]) / SAMPLE_RATE, 1.0)
    body = 1.0 - 4.0 * np.abs(phase - 0.5)
    click = lfsr_noise(length, 4, seed, False)
    click *= (np.arange(length) < round(0.006 * SAMPLE_RATE)) * 0.055
    sound = (body + click) * stepped_decay(length, (15, 15, 12, 8, 4, 0))
    return (normalize_peak(sound) * raised_cosine_envelope(length, 0.0008, 0.012)).astype(np.float32)


def chip_snare(seed: int) -> np.ndarray:
    length = round(0.092 * SAMPLE_RATE)
    noise = lfsr_noise(length, 5, seed, False)
    body = pulse_wave(180.0, length, 0.5) * 0.17
    sound = (noise + body) * stepped_decay(length, (15, 12, 9, 6, 3, 0))
    return (normalize_peak(sound) * raised_cosine_envelope(length, 0.0007, 0.010)).astype(np.float32)


def chip_hat(seed: int) -> np.ndarray:
    length = round(0.028 * SAMPLE_RATE)
    noise = lfsr_noise(length, 2, seed, True)
    smooth = np.convolve(noise, np.ones(17) / 17.0, mode="same")
    sound = (noise - smooth) * stepped_decay(length, (10, 7, 4, 1, 0))
    return (normalize_peak(sound) * raised_cosine_envelope(length, 0.0004, 0.004)).astype(np.float32)


def metric_accent(start_tick: int) -> float:
    position = start_tick % TICKS_PER_BAR
    if position == 0:
        return 1.12
    if position % (3 * TICKS_PER_EIGHTH) == 0:
        return 1.02
    return 0.90


def velocity_gain(velocity: int) -> float:
    if velocity < 72:
        return 0.60
    if velocity < 88:
        return 0.73
    if velocity < 100:
        return 0.86
    return 1.00


def add_score_notes(leads: np.ndarray, bass: np.ndarray, score: MidiScore) -> None:
    # The two printed solo parts remain note-for-note intact on separate pulse
    # channels. Continuo occupies the console triangle channel.
    track_settings = {
        1: (leads, "pulse25", 0.115, -0.28),
        2: (leads, "pulse50", 0.105, 0.28),
        6: (bass, "triangle", 0.075, -0.02),
    }
    for track_index, (destination, profile, track_gain, pan) in track_settings.items():
        notes = score.tracks[track_index]
        for note in notes:
            if note.start_tick >= SCORE_END_TICK:
                continue
            score_seconds = (
                (note.end_tick - note.start_tick) * BEAT_SECONDS / TICKS_PER_QUARTER
            )
            sound = chip_note(
                midi_frequency(note.pitch + PITCH_TRANSPOSE), score_seconds, profile
            )
            wrapped_add(
                destination,
                sound,
                tick_to_frame(note.start_tick),
                track_gain * velocity_gain(note.velocity) * metric_accent(note.start_tick),
                pan,
            )


def pitch_at_or_above(pitch_class: int, floor: int) -> int:
    return floor + ((pitch_class - floor) % 12)


def add_support_arpeggio(mix: np.ndarray, score: MidiScore) -> None:
    """Reduce the ripieno harmony to one fast 12.5%-pulse game channel."""
    accompaniment = tuple(
        note
        for track in score.tracks[3:]
        for note in track
        if note.start_tick < SCORE_END_TICK
    )

    dotted_quarter_ticks = 3 * TICKS_PER_EIGHTH
    thirty_second_ticks = TICKS_PER_QUARTER // 8
    for group_tick in range(0, SCORE_END_TICK, dotted_quarter_ticks):
        active = [
            note
            for note in accompaniment
            if note.start_tick <= group_tick < note.end_tick
        ]
        if not active:
            continue
        bass_notes = [note.pitch for note in active if note.track == 6]
        root_class = (min(bass_notes) if bass_notes else min(note.pitch for note in active)) % 12
        pitch_classes = {note.pitch % 12 for note in active}
        intervals = sorted((pitch_class - root_class) % 12 for pitch_class in pitch_classes)
        if 0 not in intervals:
            intervals.insert(0, 0)

        non_root = [interval for interval in intervals if interval]
        third = min(non_root, key=lambda interval: abs(interval - 4), default=0)
        remaining = [interval for interval in non_root if interval != third]
        fifth = min(remaining, key=lambda interval: abs(interval - 7), default=third)
        chord_intervals = [0]
        for interval in (fifth, third):
            if interval not in chord_intervals:
                chord_intervals.append(interval)
        if len(chord_intervals) == 1:
            chord_intervals.append(12)

        root_pitch = pitch_at_or_above(root_class, 52)
        chord = tuple(root_pitch + interval for interval in chord_intervals)
        pattern = (0, len(chord) - 1, min(1, len(chord) - 1), len(chord) - 1)
        exposed = sum(
            group_tick <= note.start_tick < group_tick + dotted_quarter_ticks
            for note in accompaniment
        ) < 7
        step_ticks = thirty_second_ticks * (2 if exposed else 1)
        gate_seconds = 0.074 if not exposed else 0.115
        for step, note_tick in enumerate(
            range(group_tick, min(group_tick + dotted_quarter_ticks, SCORE_END_TICK), step_ticks)
        ):
            pitch = chord[pattern[step % len(pattern)]]
            wrapped_add(
                mix,
                chip_note(
                    midi_frequency(pitch + PITCH_TRANSPOSE), gate_seconds, "pulse12"
                ),
                tick_to_frame(note_tick),
                0.0185 if not exposed else 0.015,
                0.05,
            )


def add_chip_percussion(mix: np.ndarray, score: MidiScore, rng: np.random.Generator) -> None:
    accompaniment = tuple(
        note
        for track in score.tracks[3:]
        for note in track
        if note.start_tick < SCORE_END_TICK
    )
    solo_notes = tuple(
        note
        for track in score.tracks[1:3]
        for note in track
        if note.start_tick < SCORE_END_TICK
    )

    for bar in range(BAR_COUNT):
        start_tick = PICKUP_TICKS + bar * TICKS_PER_BAR
        end_tick = start_tick + TICKS_PER_BAR
        ensemble_density = sum(start_tick <= note.start_tick < end_tick for note in accompaniment)
        solo_density = sum(start_tick <= note.start_tick < end_tick for note in solo_notes)
        active = ensemble_density + solo_density > 0
        if not active:
            continue

        # The long/short LFSR modes articulate the four 12/8 triplet groups.
        # Full textures get a busier kick/snare grid; duet passages stay light.
        tutti = ensemble_density >= 16
        seed = int(rng.integers(1, 0x7FFF))
        wrapped_add(mix, chip_kick(seed), tick_to_frame(start_tick), 0.052, 0.0)
        if tutti:
            wrapped_add(
                mix,
                chip_kick(seed ^ 0x2D31),
                tick_to_frame(start_tick + 6 * TICKS_PER_EIGHTH),
                0.038,
                0.0,
            )
        snare_indices = (3, 9) if tutti else (6,)
        for eighth_index in snare_indices:
            wrapped_add(
                mix,
                chip_snare(seed ^ (eighth_index * 0x191)),
                tick_to_frame(start_tick + eighth_index * TICKS_PER_EIGHTH),
                0.020 if tutti else 0.016,
                0.02,
            )
        hat_indices = (2, 5, 8, 11) if tutti else (5, 11)
        hat_weights = (1.0, 0.55, 0.72, 0.50)
        for eighth_index in hat_indices:
            weight = hat_weights[(eighth_index - 2) // 3] if tutti else 0.58
            wrapped_add(
                mix,
                chip_hat(seed ^ (eighth_index * 0x3D5)),
                tick_to_frame(start_tick + eighth_index * TICKS_PER_EIGHTH),
                0.0085 * weight,
                -0.12 if eighth_index % 2 else 0.12,
            )


def chip_colour(bus: np.ndarray, amount: float = 0.24) -> np.ndarray:
    """Blend in a 24 kHz sample-held, 10-bit copy without quantizing silence."""
    held = np.repeat(bus[::2], 2, axis=0)[: len(bus)]
    coloured = np.round(held * 511.0) / 511.0
    return (bus * (1.0 - amount) + coloured * amount).astype(np.float32)


def retro_echo(mix: np.ndarray, source: np.ndarray) -> np.ndarray:
    """Add two circular, tempo-synced chip echoes instead of diffuse reverb."""
    filtered = (
        np.roll(source, -2, axis=0)
        + 2.0 * np.roll(source, -1, axis=0)
        + 3.0 * source
        + 2.0 * np.roll(source, 1, axis=0)
        + np.roll(source, 2, axis=0)
    ) / 9.0
    mix += np.roll(filtered[:, ::-1], 10_000, axis=0) * 0.078
    mix += np.roll(filtered, 20_000, axis=0) * 0.035
    return mix


def master(mix: np.ndarray) -> np.ndarray:
    mix -= np.mean(mix, axis=0, keepdims=True)
    mix = np.tanh(mix * 0.22) / np.tanh(0.22)

    # Periodic filtering preserves the exact loop boundary and catches the
    # images created by the held/quantized chip channels.
    loop_frames = len(mix)
    frequencies = np.fft.rfftfreq(loop_frames, d=1.0 / SAMPLE_RATE)
    safe = np.maximum(frequencies, 1e-9)
    highpass = 1.0 / np.sqrt(1.0 + np.power(30.0 / safe, 4.0))
    lowpass = 1.0 / np.sqrt(1.0 + np.power(frequencies / 12_400.0, 6.0))
    presence_dip = 1.0 - 0.055 * np.exp(-0.5 * np.square(np.log(safe / 3_400.0) / 0.55))
    response = highpass * lowpass * presence_dip
    response[0] = 0.0
    for channel in range(2):
        spectrum = np.fft.rfft(mix[:, channel])
        mix[:, channel] = np.fft.irfft(spectrum * response, n=loop_frames).astype(np.float32)

    rms = math.sqrt(float(np.mean(np.square(mix, dtype=np.float64))))
    peak = float(np.max(np.abs(mix)))
    target_rms = 10.0 ** (-22.0 / 20.0)
    peak_limit = 10.0 ** (-2.2 / 20.0)
    gain = min(target_rms / max(rms, 1e-9), peak_limit / max(peak, 1e-9))
    mix *= gain
    mix -= np.mean(mix, axis=0, keepdims=True)
    return np.clip(mix, -1.0, 1.0).astype(np.float32)


def render(score_path: Path = SOURCE_MIDI) -> tuple[np.ndarray, int]:
    score = read_midi(score_path)
    rng = np.random.default_rng(RNG_SEED)
    leads = np.zeros((SCORE_FRAME_COUNT, 2), dtype=np.float32)
    bass = np.zeros_like(leads)
    support = np.zeros_like(leads)
    percussion = np.zeros_like(leads)
    add_score_notes(leads, bass, score)
    add_support_arpeggio(support, score)
    add_chip_percussion(percussion, score, rng)
    leads = chip_colour(leads)
    support = chip_colour(support)
    mix = leads + bass + support + percussion
    mix = retro_echo(mix, leads + support)
    mix = master(mix)
    audio = np.concatenate((mix[-CODEC_PREROLL_FRAMES:], mix), axis=0)
    rendered_note_count = sum(
        note.start_tick < SCORE_END_TICK for track in score.tracks for note in track
    )
    return audio, rendered_note_count


def write_pcm24(path: Path, stereo: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    integer = np.rint(np.clip(stereo, -1.0, 1.0).reshape(-1) * 8_388_607.0).astype(np.int32)
    packed = np.empty((integer.size, 3), dtype=np.uint8)
    packed[:, 0] = integer & 0xFF
    packed[:, 1] = (integer >> 8) & 0xFF
    packed[:, 2] = (integer >> 16) & 0xFF
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(3)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(packed.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="24-bit stereo WAV destination")
    parser.add_argument("--midi", type=Path, default=SOURCE_MIDI, help="bundled BWV 1043 II MIDI")
    args = parser.parse_args()

    audio, note_count = render(args.midi)
    write_pcm24(args.output, audio)
    peak_db = 20.0 * math.log10(max(float(np.max(np.abs(audio))), 1e-9))
    rms_db = 20.0 * math.log10(
        max(math.sqrt(float(np.mean(np.square(audio, dtype=np.float64)))), 1e-9)
    )
    print(
        f"Rendered BWV 1043 II octave-down 8-bit arrangement: "
        f"{DURATION_SECONDS:.6f}s file / "
        f"{LOOP_DURATION_SECONDS:.6f}s loop / {FRAME_COUNT} frames / "
        f"{note_count} score notes at {SAMPLE_RATE} Hz, "
        f"dotted-quarter {BPM / 1.5:.1f} BPM (peak {peak_db:.2f} dBFS, "
        f"RMS {rms_db:.2f} dBFS) -> {args.output}"
    )


if __name__ == "__main__":
    main()
