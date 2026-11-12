#!/usr/bin/env python3
"""Render "Orbital Drift", the original 8-bit background music for Space.

Every melody, chord, bass line and drum pattern in this file was composed for
Space. The renderer emulates a Famicom-style sound chip instead of using any
recording or sample: two 2A03 pulse channels plus one expansion pulse, the
4-bit stepped triangle, and the 15-bit LFSR noise channel. A 60 Hz driver tick
updates volumes, duty cycles, vibrato, chord arpeggios and drum macros the way
console music engines did. Pitches go through the 2A03 period registers, so
tuning and vibrato step like the hardware. The render is deterministic.

The piece loops every 96 bars (3:25) at 112.5 BPM, i.e. driver speed 8 with
one sixteenth note per row. Twelve eight-bar sections move from a shimmering
launch through the main theme, a B-minor verse and a catchy hook, into a
deep-space breakdown, an ignition build, a final hook and a wind-down that
leads straight back into the launch. Every channel is rendered with
continuous phase across the loop point, and the loop is mastered as a circular
signal, so it repeats without a seam. A short copy of the loop tail primes the
Vorbis decoder; playback starts after that hidden codec preroll.

Usage:
    python3 client/tools/generate-bgm.py orbital-drift.wav
    ffmpeg -i orbital-drift.wav -c:a vorbis -strict experimental \\
        -metadata title="Orbital Drift" -metadata artist="Space" -metadata album="Space" \\
        client/src/assets/audio/orbital-drift.ogg

The loop is mastered to -19.6 LUFS integrated (BS.1770), matching the
previous soundtrack so the in-game music and effect buses keep their balance.
"""

from __future__ import annotations

import argparse
import math
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


SAMPLE_RATE = 48_000
CPU_CLOCK = 1_789_773  # NTSC 2A03
TICK_RATE = 60
FRAMES_PER_TICK = SAMPLE_RATE // TICK_RATE
TICKS_PER_STEP = 8  # driver speed 8: one sixteenth note per row
STEPS_PER_BAR = 16
TICKS_PER_BAR = TICKS_PER_STEP * STEPS_PER_BAR
BARS_PER_SECTION = 8
BAR_COUNT = 96
LOOP_TICKS = TICKS_PER_BAR * BAR_COUNT
LOOP_FRAMES = LOOP_TICKS * FRAMES_PER_TICK
BPM = TICK_RATE * 60 / (TICKS_PER_STEP * 4)
CODEC_PREROLL_FRAMES = 8_192
FRAME_COUNT = CODEC_PREROLL_FRAMES + LOOP_FRAMES
# The loop end keeps playing into a short continuation of the opening, which is
# crossfaded over the first frames so every oscillator meets its own phase.
SEAM_TICKS = 6
SEAM_FRAMES = SEAM_TICKS * FRAMES_PER_TICK
assert SAMPLE_RATE % TICK_RATE == 0
assert FRAME_COUNT % 64 == 0
LOOP_SECONDS = LOOP_FRAMES / SAMPLE_RATE
DURATION_SECONDS = FRAME_COUNT / SAMPLE_RATE
TITLE = "Orbital Drift"

# Linearized 2A03 mixer weight per DAC step for each channel family.
PULSE_UNIT = 0.00752
TRIANGLE_UNIT = 0.00851
NOISE_UNIT = 0.00494
NOISE_PERIODS = (4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068)


# ---------------------------------------------------------------------------
# Composition
# ---------------------------------------------------------------------------

PITCH_CLASSES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6,
                 "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def note(name: str) -> int:
    return (int(name[-1]) + 1) * 12 + PITCH_CLASSES[name[:-1]]


# (step, length in steps, MIDI note) relative to an eight-bar phrase.
Note = tuple[int, int, int]


def phrase(*bars: str) -> tuple[Note, ...]:
    """Parse bars written as "NOTE:steps" tokens; "r" is a rest."""
    notes: list[Note] = []
    for bar, text in enumerate(bars):
        step = 0
        for token in text.split():
            name, length = token.split(":")
            if name != "r":
                notes.append((bar * STEPS_PER_BAR + step, int(length), note(name)))
            step += int(length)
        if step != STEPS_PER_BAR:
            raise ValueError(f"Bar {bar + 1} lasts {step} steps: {text}")
    return tuple(notes)


# name -> (triangle bass root, arpeggio chord tones)
CHORDS: dict[str, tuple[int, tuple[int, ...]]] = {
    "D": (38, (62, 66, 69)),
    "E/D": (38, (64, 68, 71)),
    "Bm": (35, (59, 62, 66)),
    "G": (43, (62, 67, 71)),
    "Em": (40, (64, 67, 71)),
    "A": (33, (61, 64, 69)),
    "F#m": (42, (61, 66, 69)),
    "F#": (42, (61, 66, 70)),
    "Gmaj7": (43, (62, 66, 67, 71)),
    "F#sus4": (42, (61, 66, 71)),
    "C": (36, (60, 64, 67)),
}

# Home: D with the bright Lydian E-over-D lift.
HOME = ("D", "D", "E/D", "E/D", "Bm", "G", "Em", "A")
# Verse: B minor with a major dominant for the classic console drama.
MINOR = ("Bm", "G", "A", "F#m", "Bm", "G", "Em", "F#")
HOOK_CHORDS = ("G", "A", "F#m", "Bm", "G", "A", "D", "D")
DEEP = ("Bm", "Bm", "Gmaj7", "Gmaj7", "Em", "Em", "F#sus4", "F#")
# Ignition climbs through the flat-seven C before the dominant.
IGNITION = ("G", "G", "A", "A", "Bm", "Bm", "C", "A")

THEME_A_OPENING = (
    "D5:3 A5:3 F#5:2 E5:4 D5:2 E5:2",
    "F#5:6 A4:2 D5:4 E5:4",
    "E5:3 B5:3 G#5:2 F#5:4 E5:2 F#5:2",
    "G#5:6 B4:2 E5:4 F#5:4",
)
THEME_A = phrase(
    *THEME_A_OPENING,
    "F#5:3 D5:3 B4:2 C#5:2 D5:2 F#5:4",
    "G5:3 D5:3 B4:2 A4:2 B4:2 D5:4",
    "E5:2 G5:2 B5:4 A5:2 G5:2 F#5:2 G5:2",
    "A5:8 r:4 C#5:2 E5:2",
)
THEME_A_ANSWER = phrase(
    *THEME_A_OPENING,
    "D5:3 F#5:3 B5:2 A5:2 F#5:2 D5:4",
    "B4:3 D5:3 G5:2 F#5:2 G5:2 B5:4",
    "A5:2 G5:2 F#5:2 E5:2 F#5:2 G5:2 E5:4",
    "C#5:2 D5:2 E5:4 A4:6 r:2",
)
THEME_B = phrase(
    "B4:4 F#5:4 D5:2 C#5:2 B4:4",
    "D5:4 G5:4 F#5:2 E5:2 D5:4",
    "C#5:4 E5:4 A5:6 G5:2",
    "F#5:8 E5:2 C#5:2 A4:4",
    "B4:2 D5:2 F#5:4 B5:4 A5:2 F#5:2",
    "G5:4 B5:4 D6:4 B5:4",
    "E5:4 G5:2 B5:2 A5:2 G5:2 F#5:2 E5:2",
    "A#4:4 C#5:4 F#5:8",
)
THEME_B_DRIVE = phrase(
    "F#5:3 D5:3 B4:2 F#5:3 D5:3 B4:2",
    "G5:3 D5:3 B4:2 G5:3 D5:3 B4:2",
    "A5:3 E5:3 C#5:2 A5:3 E5:3 C#5:2",
    "F#5:3 C#5:3 A4:2 C#5:2 E5:2 F#5:4",
    "B5:6 A5:2 F#5:4 D5:4",
    "G5:6 F#5:2 D5:4 B4:4",
    "E5:2 F#5:2 G5:2 A5:2 B5:4 G5:4",
    "F#5:4 A#5:4 C#6:6 r:2",
)
HOOK_OPENING = (
    "B5:2 B5:2 A5:2 B5:4 D6:2 B5:2 A5:2",
    "A5:2 A5:2 G5:2 A5:4 C#6:2 A5:2 E5:2",
    "F#5:2 F#5:2 E5:2 F#5:4 A5:2 C#6:2 A5:2",
    "B5:8 A5:4 F#5:4",
    "B5:2 B5:2 A5:2 B5:4 D6:4 B5:2",
    "C#6:4 B5:2 A5:2 E5:4 A5:4",
)
# The first hook lifts into its repeat; the second lands and winds down.
HOOK = phrase(*HOOK_OPENING, "D6:6 C#6:2 A5:4 F#5:4", "D6:8 r:4 A5:2 B5:2")
HOOK_LANDING = phrase(*HOOK_OPENING, "F#5:2 A5:2 D6:4 C#6:2 A5:2 F#5:4", "D6:4 A5:4 F#5:4 D5:4")
DEEP_LEAD = phrase(
    "F#5:8 D5:4 B4:4",
    "D5:8 E5:4 F#5:4",
    "F#5:12 E5:2 D5:2",
    "B4:12 r:4",
    "G5:8 E5:4 B4:4",
    "D5:8 E5:4 G5:4",
    "F#5:8 C#5:4 B4:4",
    "A#4:12 r:4",
)
IGNITION_LEAD = phrase(
    "G5:4 D5:2 G5:2 A5:4 B5:4",
    "B5:6 A5:2 G5:4 D5:4",
    "A5:4 E5:2 A5:2 B5:4 C#6:4",
    "C#6:6 B5:2 A5:4 E5:4",
    "B5:4 F#5:2 B5:2 C#6:2 D6:6",
    "D6:6 C#6:2 B5:4 F#5:4",
    "C6:4 G5:2 C6:2 D6:4 E6:4",
    "A5:2 r:2 A5:2 r:2 A5:2 C#6:2 E6:4",
)
OUTRO_LEAD = phrase(
    THEME_A_OPENING[0],
    "F#5:8 r:8",
    THEME_A_OPENING[2],
    "G#5:8 r:8",
    "r:16", "r:16", "r:16", "r:16",
)


@dataclass(frozen=True)
class Section:
    name: str
    chords: tuple[str, ...]
    lead: tuple[Note, ...]
    voice: str
    level: float
    second: str  # what pulse 2 plays: echo, harmony or none
    arp: str  # expansion pulse: pad, broken16, broken8 or stab ("a|b" splits halves)
    bass: str
    drums: str
    crash: bool = False
    echo_steps: int = 3


SECTIONS: tuple[Section, ...] = (
    Section("launch", HOME, (), "lead50", 0.0, "none", "pad", "hold", "intro"),
    Section("theme", HOME, THEME_A, "lead50", 1.0, "echo", "broken16", "octaves", "groove",
            crash=True),
    Section("answer", HOME, THEME_A_ANSWER, "lead50", 1.0, "echo", "broken16", "octaves", "groove"),
    Section("nebula", MINOR, THEME_B, "lead25", 0.95, "echo", "pad", "drive", "half"),
    Section("current", MINOR, THEME_B_DRIVE, "lead25", 1.0, "harmony", "broken16", "drive", "groove"),
    Section("hook", HOOK_CHORDS, HOOK, "lead25", 1.0, "harmony", "stab", "gallop", "drive",
            crash=True),
    Section("hook-landing", HOOK_CHORDS, HOOK_LANDING, "lead25", 1.0, "harmony", "stab",
            "gallop", "drive"),
    Section("deep-space", DEEP, DEEP_LEAD, "lead12", 1.0, "echo", "pad", "hold", "none",
            echo_steps=6),
    Section("ignition", IGNITION, IGNITION_LEAD, "lead25", 0.95, "echo", "broken16", "pulse",
            "build"),
    Section("return", HOME, THEME_A_ANSWER, "lead50", 1.0, "harmony", "broken16", "octaves",
            "groove", crash=True),
    Section("finale", HOOK_CHORDS, HOOK_LANDING, "lead25", 1.0, "harmony", "stab", "gallop",
            "drive", crash=True),
    Section("orbit", HOME, OUTRO_LEAD, "lead50", 0.75, "echo", "broken8|pad", "octaves|hold",
            "light|none"),
)
assert all(len(section.chords) == BARS_PER_SECTION for section in SECTIONS)
assert len(SECTIONS) * BARS_PER_SECTION == BAR_COUNT

PATTERN_16 = (0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 2, 1)
PATTERN_8 = (0, 1, 2, 3, 2, 1, 2, 3)

# (step, length, interval above the root) for the triangle bass.
BASS_PATTERNS: dict[str, tuple[tuple[int, int, int], ...]] = {
    "hold": ((0, 16, 0),),
    "octaves": ((0, 3, 0), (3, 3, 12), (6, 2, 0), (8, 3, 0), (11, 3, 12), (14, 2, 0)),
    "drive": ((0, 2, 0), (2, 2, 0), (4, 2, 7), (6, 2, 0), (8, 2, 0), (10, 2, 0), (12, 2, 7),
              (14, 2, 12)),
    "gallop": ((0, 2, 0), (2, 1, 12), (3, 1, 12), (4, 2, 0), (6, 2, 12), (8, 2, 0),
               (10, 1, 12), (11, 1, 12), (12, 2, 0), (14, 2, 12)),
    "pulse": tuple((step, 2, 0) for step in range(0, 16, 2)),
    "pulse16": tuple((step, 1, 0) for step in range(16)),
}


def section_spans() -> list[tuple[Section, int]]:
    return [(section, index * BARS_PER_SECTION) for index, section in enumerate(SECTIONS)]


def bar_chords() -> list[str]:
    return [chord for section in SECTIONS for chord in section.chords]


def half_mode(spec: str, bar: int) -> str:
    parts = spec.split("|")
    return parts[0] if len(parts) == 1 or bar < BARS_PER_SECTION // 2 else parts[1]


def harmonize(notes: tuple[Note, ...], chords: tuple[str, ...]) -> list[Note]:
    """Shadow each melody note with the nearest chord tone a third to a sixth below."""
    voices = []
    for step, length, midi in notes:
        tones = {tone % 12 for tone in CHORDS[chords[step // STEPS_PER_BAR]][1]}
        below = [midi - interval for interval in range(3, 10) if (midi - interval) % 12 in tones]
        if below:
            voices.append((step, length, below[0]))
    return voices


# ---------------------------------------------------------------------------
# Driver: instruments, events and per-tick channel registers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Instrument:
    attack: tuple[int, ...]
    sustain: int
    release: tuple[int, ...] = ()
    fade_every: int = 0
    floor: int = 0
    duty: tuple[float, ...] = (0.5,)
    vibrato: tuple[int, float, int] | None = None  # delay ticks, depth cents, period ticks


INSTRUMENTS = {
    "lead50": Instrument((14, 13, 12, 11), 10, (6, 3, 1), 24, 8, (0.5,), (14, 18.0, 9)),
    "lead25": Instrument((14, 13, 12, 11), 10, (6, 3, 1), 24, 8, (0.5, 0.25), (14, 15.0, 9)),
    "lead12": Instrument((11, 10, 9), 8, (4, 2, 1), 20, 5, (0.25, 0.125), (12, 22.0, 10)),
    "pluck16": Instrument((11, 9, 8, 7, 6, 5, 4, 3), 3, duty=(0.25,)),
    "pluck8": Instrument((11, 10, 9, 8, 7, 6, 6, 5, 5, 4, 4, 4, 3), 3, duty=(0.25,)),
    "pad": Instrument((10, 9, 8, 8), 8, (3, 1), 16, 6, (0.25,)),
    "stab": Instrument((11, 10, 8, 6, 3), 0, duty=(0.125,)),
    "bass": Instrument((15,), 15),
}

# Triangle kick: a fast pitch drop that briefly takes over the bass channel.
TRIANGLE_KICK = (55, 47, 40, 35)

# name -> (volumes, noise periods, short mode, priority); the last period holds.
NOISE_KIT: dict[str, tuple[tuple[int, ...], tuple[int, ...], bool, int]] = {
    "kick": ((12, 9, 5, 2), (11, 12, 13, 14), False, 2),
    "snare": ((15, 13, 11, 9, 8, 7, 6, 5, 4, 3, 3, 2, 2, 1, 1), (5, 6, 6, 6, 7), False, 3),
    "hat": ((8, 5, 3, 1), (3,), False, 1),
    "open": ((8, 7, 6, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1), (3,), False, 1),
    "crash": (tuple(max(0, 15 - i // 3) for i in range(46)), (2, 2, 3), False, 4),
}


@dataclass
class Event:
    start: int
    pitch: np.ndarray
    volume: np.ndarray
    duty: np.ndarray
    priority: int = 0
    period: np.ndarray | None = None
    short: bool = False


@dataclass
class Registers:
    pitch: np.ndarray
    volume: np.ndarray
    duty: np.ndarray
    period: np.ndarray
    short: np.ndarray


def tone_event(start: int, gate: int, instrument: Instrument, tones: tuple[int, ...],
               level: float, arp_ticks: int = 2) -> Event:
    gate = max(1, gate)
    length = gate + len(instrument.release)
    volume = np.empty(length)
    for tick in range(gate):
        if tick < len(instrument.attack):
            volume[tick] = instrument.attack[tick]
        elif instrument.fade_every:
            faded = instrument.sustain - (tick - len(instrument.attack)) // instrument.fade_every
            volume[tick] = max(instrument.floor, faded)
        else:
            volume[tick] = instrument.sustain
    held = volume[gate - 1]
    for offset, value in enumerate(instrument.release):
        volume[gate + offset] = min(value, held)
    volume = np.floor(volume * level + 0.5)

    ticks = np.arange(length)
    pitch = np.asarray(tones, dtype=np.float64)[(ticks // arp_ticks) % len(tones)]
    if instrument.vibrato and len(tones) == 1:
        delay, cents, period = instrument.vibrato
        phase = ticks - delay
        pitch = pitch + np.where(phase >= 0, cents / 100.0 * np.sin(2.0 * math.pi * phase / period), 0.0)
    duty = np.asarray(instrument.duty)[np.minimum(ticks, len(instrument.duty) - 1)]
    return Event(start, pitch, volume, duty)


def noise_event(start: int, kind: str, level: float) -> Event:
    volumes, periods, short, priority = NOISE_KIT[kind]
    volume = np.floor(np.asarray(volumes, dtype=np.float64) * level + 0.5)
    period = np.asarray(periods)[np.minimum(np.arange(len(volumes)), len(periods) - 1)]
    return Event(start, np.zeros(len(volumes)), volume, np.zeros(len(volumes)), priority,
                 period, short)


def riser_event(start: int, ticks: int) -> Event:
    progress = np.arange(ticks) / (ticks - 1)
    volume = np.floor(2.0 + 10.0 * progress ** 1.5 + 0.5)
    period = np.round(14.0 - 13.0 * progress).astype(int)
    return Event(start, np.zeros(ticks), volume, np.zeros(ticks), 3, period, False)


def resolve(events: list[Event]) -> Registers:
    """Play events monophonically: each one runs until the next one starts."""
    registers = Registers(np.full(LOOP_TICKS, np.nan), np.zeros(LOOP_TICKS),
                          np.full(LOOP_TICKS, 0.5), np.zeros(LOOP_TICKS, dtype=np.int64),
                          np.zeros(LOOP_TICKS, dtype=bool))
    chosen: dict[int, Event] = {}
    for event in events:
        start = event.start % LOOP_TICKS
        if start not in chosen or event.priority > chosen[start].priority:
            chosen[start] = event
    starts = sorted(chosen)
    for index, start in enumerate(starts):
        event = chosen[start]
        span = (starts[(index + 1) % len(starts)] - start) % LOOP_TICKS or LOOP_TICKS
        count = min(len(event.volume), span)
        ticks = (start + np.arange(count)) % LOOP_TICKS
        registers.pitch[ticks] = event.pitch[:count]
        registers.volume[ticks] = event.volume[:count]
        registers.duty[ticks] = event.duty[:count]
        if event.period is not None:
            registers.period[ticks] = event.period[:count]
            registers.short[ticks] = event.short
    return registers


# ---------------------------------------------------------------------------
# Arrangement
# ---------------------------------------------------------------------------


@dataclass
class Score:
    lead: list[Event]
    second: list[Event]
    arp: list[Event]
    bass: list[Event]
    kicks: list[int]
    noise: list[Event]


def add_melody(score: Score, section: Section, first_bar: int) -> None:
    if not section.lead:
        return
    instrument = INSTRUMENTS[section.voice]
    base = first_bar * TICKS_PER_BAR
    end = base + BARS_PER_SECTION * TICKS_PER_BAR
    for step, steps, midi in section.lead:
        gate = steps * TICKS_PER_STEP - 2
        score.lead.append(tone_event(base + step * TICKS_PER_STEP, gate, instrument, (midi,),
                                     section.level))
    if section.second == "echo":
        for step, steps, midi in section.lead:
            start = base + (step + section.echo_steps) * TICKS_PER_STEP
            if start < end:
                score.second.append(tone_event(start, steps * TICKS_PER_STEP - 2, instrument,
                                               (midi,), section.level * 0.42))
    elif section.second == "harmony":
        # A contrasting duty keeps the harmony distinct from the lead.
        voice = INSTRUMENTS["lead25" if instrument.duty[-1] == 0.5 else "lead50"]
        for step, steps, midi in harmonize(section.lead, section.chords):
            score.second.append(tone_event(base + step * TICKS_PER_STEP,
                                           steps * TICKS_PER_STEP - 2, voice, (midi,),
                                           section.level * 0.62))


def add_arpeggios(score: Score, section: Section, first_bar: int) -> None:
    for bar, chord in enumerate(section.chords):
        tones = CHORDS[chord][1]
        broken = tones + (tones[0] + 12,)
        base = (first_bar + bar) * TICKS_PER_BAR
        mode = half_mode(section.arp, bar)
        if mode == "pad":
            for half in (0, TICKS_PER_BAR // 2):
                score.arp.append(tone_event(base + half, TICKS_PER_BAR // 2, INSTRUMENTS["pad"],
                                            tones, 1.0, arp_ticks=2))
        elif mode == "broken16":
            for step, index in enumerate(PATTERN_16):
                accent = 1.0 if step % 4 == 0 else 0.85
                score.arp.append(tone_event(base + step * TICKS_PER_STEP, TICKS_PER_STEP,
                                            INSTRUMENTS["pluck16"], (broken[index],), accent))
        elif mode == "broken8":
            for step, index in enumerate(PATTERN_8):
                score.arp.append(tone_event(base + step * 2 * TICKS_PER_STEP, 2 * TICKS_PER_STEP,
                                            INSTRUMENTS["pluck8"], (broken[index],), 1.0))
        elif mode == "stab":
            # Off-beat chord stabs, each a 60 Hz arpeggio across the triad.
            for step in range(0, STEPS_PER_BAR, 2):
                accent = 1.0 if step % 4 == 2 else 0.75
                score.arp.append(tone_event(base + step * TICKS_PER_STEP, 5, INSTRUMENTS["stab"],
                                            tones, accent, arp_ticks=1))


def add_bass(score: Score, section: Section, first_bar: int) -> None:
    for bar, chord in enumerate(section.chords):
        root = CHORDS[chord][0]
        mode = half_mode(section.bass, bar)
        if mode == "pulse" and bar == BARS_PER_SECTION - 1:
            mode = "pulse16"
        base = (first_bar + bar) * TICKS_PER_BAR
        for step, steps, interval in BASS_PATTERNS[mode]:
            score.bass.append(tone_event(base + step * TICKS_PER_STEP,
                                         steps * TICKS_PER_STEP - 1, INSTRUMENTS["bass"],
                                         (root + interval,), 1.0))


def drum_bar(mode: str, bar: int) -> list[tuple[int, str, float]]:
    last = bar == BARS_PER_SECTION - 1
    hits: list[tuple[int, str, float]] = []

    def fill(start: int, levels: tuple[float, ...]) -> None:
        nonlocal hits
        hits = [hit for hit in hits if hit[0] < start]
        hits += [(start + offset, "snare", level) for offset, level in enumerate(levels)]

    if mode == "intro":
        if bar >= BARS_PER_SECTION // 2:
            hits += [(0, "kick", 0.85)] + [(step, "hat", 0.6) for step in (2, 6, 10, 14)]
            if last:
                fill(12, (0.55, 0.65, 0.8, 0.95))
    elif mode == "light":
        hits += [(0, "kick", 0.9), (8, "kick", 0.75)]
        hits += [(step, "hat", 0.6) for step in (2, 6, 10, 14)]
    elif mode == "groove":
        hits += [(0, "kick", 1.0), (8, "kick", 0.9), (11, "kick", 0.7)]
        hits += [(4, "snare", 1.0), (12, "snare", 1.0)]
        hits += [(step, "hat", 0.7) for step in (2, 6, 10, 14)]
        if last:
            fill(12, (0.8, 0.7, 0.85, 1.0))
        elif bar == BARS_PER_SECTION // 2 - 1:
            fill(14, (0.55, 0.7))
    elif mode == "half":
        hits += [(0, "kick", 1.0), (10, "kick", 0.8), (8, "snare", 1.0)]
        hits += [(step, "hat", 0.6) for step in (2, 4, 6, 12, 14)]
        if last:
            fill(12, (0.6, 0.0, 0.8, 0.95))
    elif mode == "drive":
        hits += [(step, "kick", 1.0) for step in (0, 4, 8, 12)]
        hits += [(4, "snare", 1.0), (12, "snare", 1.0)]
        hits += [(step, "open" if step % 4 == 2 else "hat", 0.75 if step % 4 == 2 else 0.45)
                 for step in range(STEPS_PER_BAR) if step % 4]
        if last:
            hits = [hit for hit in hits if hit[0] < 13 or hit[1] == "kick"]
            hits += [(13, "snare", 0.7), (14, "snare", 0.85), (15, "snare", 1.0)]
    elif mode == "build":
        if bar < 2:
            hits += [(0, "kick", 0.9), (8, "kick", 0.8)]
        elif bar < 4:
            hits += [(0, "kick", 0.95), (8, "kick", 0.85), (12, "snare", 0.7)]
            hits += [(step, "hat", 0.5) for step in (2, 6, 10, 14)]
        elif bar < 6:
            hits += [(step, "kick", 1.0) for step in (0, 4, 8, 12)]
            hits += [(4, "snare", 0.9), (12, "snare", 0.9)]
            hits += [(step, "hat", 0.6) for step in (2, 6, 10, 14)]
        elif bar == 6:
            # The noise channel sweeps up while the triangle keeps the beat.
            hits += [(0, "riser", 1.0)] + [(step, "tkick", 1.0) for step in (0, 4, 8, 12)]
        else:
            hits += [(step, "tkick", 1.0) for step in (0, 4, 8, 12)]
            hits += [(step, "snare", 0.35 + 0.65 * step / 15.0) for step in range(STEPS_PER_BAR)]
    return [hit for hit in hits if hit[2] > 0.0]


def add_drums(score: Score, section: Section, first_bar: int) -> None:
    for bar in range(BARS_PER_SECTION):
        hits = drum_bar(half_mode(section.drums, bar), bar)
        if section.crash and bar == 0:
            hits = [hit for hit in hits if not 1 <= hit[0] <= 3 or hit[1] == "kick"]
            hits.append((0, "crash", 1.0))
        base = (first_bar + bar) * TICKS_PER_BAR
        for step, kind, level in hits:
            start = base + step * TICKS_PER_STEP
            if kind in ("kick", "tkick"):
                score.kicks.append(start)
            if kind == "riser":
                score.noise.append(riser_event(start, TICKS_PER_BAR))
            elif kind != "tkick":
                score.noise.append(noise_event(start, kind, level))


def compose() -> Score:
    score = Score([], [], [], [], [], [])
    for section, first_bar in section_spans():
        add_melody(score, section, first_bar)
        add_arpeggios(score, section, first_bar)
        add_bass(score, section, first_bar)
        add_drums(score, section, first_bar)
    return score


# ---------------------------------------------------------------------------
# Sound chip
# ---------------------------------------------------------------------------


def lfsr_sequence(short_mode: bool) -> np.ndarray:
    tap = 6 if short_mode else 1
    register = 1
    bits = []
    for _ in range(40_000):
        bits.append(register & 1)
        feedback = (register & 1) ^ ((register >> tap) & 1)
        register = (register >> 1) | (feedback << 14)
        if register == 1:
            break
    return np.asarray(bits, dtype=np.float64)


LONG_NOISE = lfsr_sequence(False)
SHORT_NOISE = lfsr_sequence(True)


def period_hz(midi: np.ndarray, divider: int) -> np.ndarray:
    """Round to the nearest 11-bit period register, as the hardware plays it."""
    frequency = 440.0 * np.power(2.0, (midi - 69.0) / 12.0)
    timer = np.clip(np.round(CPU_CLOCK / (divider * frequency) - 1.0), 8, 2047)
    return CPU_CLOCK / (divider * (timer + 1.0))


def with_seam(values: np.ndarray) -> np.ndarray:
    return np.concatenate((values, values[:SEAM_TICKS]))


def per_sample(values: np.ndarray) -> np.ndarray:
    return np.repeat(values, FRAMES_PER_TICK)


def smooth_steps(level: np.ndarray, width: int = 24) -> np.ndarray:
    """Soften the 60 Hz volume steps just enough to keep them click-free."""
    return np.convolve(level, np.ones(width) / width, mode="same")


def fold_seam(signal: np.ndarray) -> np.ndarray:
    """Crossfade the loop end's continuation into the opening frames."""
    loop = signal[:LOOP_FRAMES].copy()
    continuation = signal[LOOP_FRAMES:]
    weight = np.sin(np.linspace(0.0, math.pi / 2.0, SEAM_FRAMES)) ** 2
    loop[:SEAM_FRAMES] = continuation * (1.0 - weight) + loop[:SEAM_FRAMES] * weight
    return loop


def poly_blep(phase: np.ndarray, increment: np.ndarray) -> np.ndarray:
    correction = np.zeros_like(phase)
    leading = phase < increment
    x = phase[leading] / increment[leading]
    correction[leading] = x + x - x * x - 1.0
    trailing = phase > 1.0 - increment
    x = (phase[trailing] - 1.0) / increment[trailing]
    correction[trailing] = x * x + x + x + 1.0
    return correction


def render_pulse(registers: Registers) -> np.ndarray:
    pitch = with_seam(registers.pitch)
    active = ~np.isnan(pitch)
    hz = np.zeros_like(pitch)
    hz[active] = period_hz(pitch[active], 16)
    increment = per_sample(hz / SAMPLE_RATE)
    phase = np.mod(np.cumsum(increment) - increment, 1.0)
    duty = per_sample(with_seam(registers.duty))
    wave = np.where(phase < duty, 1.0, -1.0)
    safe = np.maximum(increment, 1e-12)
    wave += poly_blep(phase, safe)
    wave -= poly_blep(np.mod(phase - duty, 1.0), safe)
    wave -= 2.0 * duty - 1.0  # zero-mean, so volume steps never thump
    level = smooth_steps(per_sample(np.where(active, with_seam(registers.volume), 0.0)))
    return fold_seam(wave * level * 0.5 * PULSE_UNIT)


def render_triangle(registers: Registers) -> np.ndarray:
    pitch = with_seam(registers.pitch)
    active = ~np.isnan(pitch) & (with_seam(registers.volume) > 0)
    hz = np.zeros_like(pitch)
    hz[active] = period_hz(pitch[active], 32)
    # A halted triangle holds its current step, so gaps never click.
    increment = per_sample(hz / SAMPLE_RATE)
    phase = np.mod(np.cumsum(increment) - increment, 1.0)
    step = np.floor(phase * 32.0)
    level = np.where(step < 16, 15.0 - step, step - 16.0)
    return fold_seam((level - 7.5) * TRIANGLE_UNIT)


def render_noise(registers: Registers) -> np.ndarray:
    rate = CPU_CLOCK / np.asarray(NOISE_PERIODS, dtype=np.float64)[with_seam(registers.period)]
    clocks = np.floor(np.cumsum(per_sample(rate / SAMPLE_RATE))).astype(np.int64)
    short = per_sample(with_seam(registers.short))
    bits = np.where(short, SHORT_NOISE[clocks % len(SHORT_NOISE)],
                    LONG_NOISE[clocks % len(LONG_NOISE)])
    level = smooth_steps(per_sample(with_seam(registers.volume)))
    return fold_seam((2.0 * bits - 1.0) * level * 0.5 * NOISE_UNIT)


# ---------------------------------------------------------------------------
# Mix and master
# ---------------------------------------------------------------------------


def equal_power_pan(pan: float) -> tuple[float, float]:
    angle = (pan + 1.0) * math.pi / 4.0
    return math.cos(angle), math.sin(angle)


def spectral_filter(signal: np.ndarray, response) -> np.ndarray:
    """Zero-phase circular filter; preserves the loop boundary exactly."""
    frequencies = np.fft.rfftfreq(len(signal), d=1.0 / SAMPLE_RATE)
    gains = response(np.maximum(frequencies, 1e-9))
    if signal.ndim == 1:
        return np.fft.irfft(np.fft.rfft(signal) * gains, n=len(signal))
    out = np.empty_like(signal)
    for channel in range(signal.shape[1]):
        out[:, channel] = np.fft.irfft(np.fft.rfft(signal[:, channel]) * gains, n=len(signal))
    return out


def lowpass(cutoff: float, order: int = 2):
    return lambda f: 1.0 / np.sqrt(1.0 + np.power(f / cutoff, 2 * order))


def highpass(cutoff: float, order: int = 2):
    return lambda f: 1.0 / np.sqrt(1.0 + np.power(cutoff / f, 2 * order))


def k_weighting(f: np.ndarray) -> np.ndarray:
    """BS.1770 K-weighting magnitude from the standard 48 kHz biquads."""
    z = np.exp(-2j * math.pi * f / SAMPLE_RATE)

    def biquad(b: tuple[float, ...], a: tuple[float, ...]) -> np.ndarray:
        return np.abs((b[0] + b[1] * z + b[2] * z * z) / (a[0] + a[1] * z + a[2] * z * z))

    shelf = biquad((1.53512485958697, -2.69169618940638, 1.19839281085285),
                   (1.0, -1.69065929318241, 0.73248077421585))
    rlb = biquad((1.0, -2.0, 1.0), (1.0, -1.99004745483398, 0.99007225036621))
    return shelf * rlb


def integrated_loudness(mix: np.ndarray) -> float:
    weighted = spectral_filter(mix.astype(np.float64), k_weighting)
    block = round(0.4 * SAMPLE_RATE)
    hop = round(0.1 * SAMPLE_RATE)
    power = np.sum(np.square(weighted), axis=1)
    cumulative = np.concatenate(([0.0], np.cumsum(power)))
    starts = np.arange(0, len(power) - block, hop)
    blocks = (cumulative[starts + block] - cumulative[starts]) / block
    loud = -0.691 + 10.0 * np.log10(np.maximum(blocks, 1e-12))
    gated = blocks[loud > -70.0]
    relative = -0.691 + 10.0 * np.log10(np.mean(gated)) - 10.0
    gated = blocks[(loud > -70.0) & (loud > relative)]
    return float(-0.691 + 10.0 * np.log10(np.mean(gated)))


def master(mix: np.ndarray) -> np.ndarray:
    mix = mix - np.mean(mix, axis=0, keepdims=True)
    # A console-style output stage: DC blocking and the gentle analog top end.
    mix = spectral_filter(mix, lambda f: highpass(30.0, 2)(f) * lowpass(14_000.0, 1)(f))
    gain = 10.0 ** ((-19.6 - integrated_loudness(mix)) / 20.0)
    peak_limit = 10.0 ** (-1.0 / 20.0)
    gain = min(gain, peak_limit / max(float(np.max(np.abs(mix))), 1e-9))
    return np.clip(mix * gain, -1.0, 1.0).astype(np.float32)


# Pulse 1 leads in the centre; its echo/harmony and the expansion arpeggios
# sit to either side, as many modern chip releases widen the mono console.
PANS = {"lead": 0.0, "second": 0.45, "arp": -0.45, "triangle": 0.0, "noise": 0.1}
# The hardware triangle has no volume control; trim it and lift the noise
# slightly so bass, lead and drums balance on small speakers.
MIX_GAINS = {"lead": 1.0, "second": 1.0, "arp": 1.0, "triangle": 0.75, "noise": 1.3}


def render() -> tuple[np.ndarray, dict[str, np.ndarray]]:
    score = compose()
    triangle = resolve(score.bass)
    for start in score.kicks:
        ticks = (start + np.arange(len(TRIANGLE_KICK))) % LOOP_TICKS
        triangle.pitch[ticks] = TRIANGLE_KICK
        triangle.volume[ticks] = 15
    voices = {
        "lead": render_pulse(resolve(score.lead)),
        "second": render_pulse(resolve(score.second)),
        "arp": render_pulse(resolve(score.arp)),
        "triangle": render_triangle(triangle),
        "noise": render_noise(resolve(score.noise)),
    }
    stems = {}
    for name, mono in voices.items():
        left, right = equal_power_pan(PANS[name])
        stems[name] = np.stack((mono * left, mono * right), axis=1) * MIX_GAINS[name]
    mix = master(sum(stems.values()))
    audio = np.concatenate((mix[-CODEC_PREROLL_FRAMES:], mix), axis=0)
    return audio, stems


def rms_db(values: np.ndarray) -> float:
    rms = math.sqrt(float(np.mean(np.square(values, dtype=np.float64))))
    return 20.0 * math.log10(max(rms, 1e-12))


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
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("output", type=Path, help="24-bit stereo WAV destination")
    parser.add_argument("--stems", action="store_true", help="print pre-master channel levels")
    args = parser.parse_args()

    audio, stems = render()
    write_pcm24(args.output, audio)
    if args.stems:
        for name, stem in stems.items():
            print(f"  {name:>8}: {rms_db(stem):6.1f} dBFS RMS")
    loop = audio[CODEC_PREROLL_FRAMES:]
    peak_db = 20.0 * math.log10(max(float(np.max(np.abs(audio))), 1e-9))
    print(
        f"Rendered {TITLE}: {DURATION_SECONDS:.6f}s file / {LOOP_SECONDS:.6f}s loop / "
        f"{FRAME_COUNT} frames, {BAR_COUNT} bars at {BPM:g} BPM, "
        f"{integrated_loudness(loop):.1f} LUFS (peak {peak_db:.2f} dBFS) -> {args.output}"
    )


if __name__ == "__main__":
    main()
