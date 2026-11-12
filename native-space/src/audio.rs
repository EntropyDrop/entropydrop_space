//! Local audio transport; decoding and synthesis do not involve the browser.
use anyhow::{Context, Result};
use objc2::{AnyThread, rc::Retained};
use objc2_app_kit::NSSound;
use objc2_foundation::NSData;
use std::{io::Cursor, time::Instant};

#[derive(Clone, Copy)]
pub enum Effect {
    Click,
    Place,
    Break,
    Assemble,
    Glue,
}
#[derive(Default)]
pub struct Audio {
    music: Option<Retained<NSSound>>,
    loading: Option<crossbeam_channel::Receiver<Result<Vec<u8>>>>,
    effects: Vec<Retained<NSSound>>,
    last_effect: Option<Instant>,
    failed: bool,
}
fn wav(samples: &[i16], channels: u16, rate: u32) -> Vec<u8> {
    let bytes = samples.len() as u32 * 2;
    let mut out = Vec::with_capacity(bytes as usize + 44);
    out.extend(b"RIFF");
    out.extend((bytes + 36).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(channels.to_le_bytes());
    out.extend(rate.to_le_bytes());
    out.extend((rate * u32::from(channels) * 2).to_le_bytes());
    out.extend((channels * 2).to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend(bytes.to_le_bytes());
    for sample in samples {
        out.extend(sample.to_le_bytes());
    }
    out
}
fn sound(bytes: &[u8]) -> Result<Retained<NSSound>> {
    NSSound::initWithData(NSSound::alloc(), &NSData::with_bytes(bytes))
        .context("Decode local audio")
}
impl Audio {
    pub fn update(&mut self, enabled: bool) -> Result<()> {
        if enabled && self.music.is_none() && self.loading.is_none() && !self.failed {
            let (tx, rx) = crossbeam_channel::bounded(1);
            self.loading = Some(rx);
            std::thread::spawn(move || {
                let result = (|| -> Result<_> {
                    let bytes = include_bytes!("../../client/src/assets/audio/orbital-drift.ogg");
                    let mut reader = lewton::inside_ogg::OggStreamReader::new(Cursor::new(bytes))?;
                    let channels = u16::from(reader.ident_hdr.audio_channels);
                    let rate = reader.ident_hdr.audio_sample_rate;
                    let mut samples = Vec::new();
                    while let Some(packet) = reader.read_dec_packet_itl()? {
                        samples.extend(packet);
                    }
                    // Match the source player's Vorbis preroll trim.
                    Ok(wav(
                        &samples[(8192 * usize::from(channels)).min(samples.len())..],
                        channels,
                        rate,
                    ))
                })();
                let _ = tx.send(result);
            });
        }
        if let Some(result) = self.loading.as_ref().and_then(|rx| rx.try_recv().ok()) {
            self.loading = None;
            match result.and_then(|bytes| sound(&bytes)) {
                Ok(s) => {
                    s.setLoops(true);
                    s.setVolume(0.5);
                    self.music = Some(s);
                }
                Err(e) => {
                    self.failed = true;
                    return Err(e);
                }
            }
        }
        if let Some(s) = &self.music {
            if enabled && !s.isPlaying() {
                s.play();
            } else if !enabled && s.isPlaying() {
                s.pause();
            }
        }
        self.effects.retain(|s| s.isPlaying());
        Ok(())
    }
    pub fn effect(&mut self, effect: Effect, enabled: bool) {
        if !enabled
            || self
                .last_effect
                .is_some_and(|t| t.elapsed().as_millis() < 45)
        {
            return;
        }
        self.last_effect = Some(Instant::now());
        let (start, end, duration, volume) = match effect {
            Effect::Click => (800.0, 300.0, 0.07, 0.25),
            Effect::Place => (180.0, 70.0, 0.09, 0.22),
            Effect::Break => (110.0, 35.0, 0.13, 0.23),
            Effect::Assemble => (140.0, 50.0, 0.20, 0.30),
            Effect::Glue => (220.0, 440.0, 0.13, 0.20),
        };
        let rate = 48000;
        let mut phase = 0.0f64;
        let samples: Vec<_> = (0..(duration * f64::from(rate)) as usize)
            .map(|i| {
                let t = i as f64 / f64::from(rate) / duration;
                phase += start * f64::powf(end / start, t) / f64::from(rate);
                let triangle = 1.0 - 4.0 * (phase.fract() - 0.5).abs();
                (triangle * volume * f64::powf(0.004, t) * 32767.0) as i16
            })
            .collect();
        if let Ok(s) = sound(&wav(&samples, 1, rate)) {
            s.play();
            self.effects.push(s);
        }
    }
}
impl Drop for Audio {
    fn drop(&mut self) {
        if let Some(s) = &self.music {
            s.stop();
        }
        for s in &self.effects {
            s.stop();
        }
    }
}
