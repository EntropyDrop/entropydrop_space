/// Count actual submissions over wall time. Averaging 1/dt overweights short
/// frames when the GPU queue alternates between bursts and blocking waits.
#[derive(Default)]
pub struct FrameRate {
    window_start: f64,
    submitted: u64,
    rate: f64,
}
impl FrameRate {
    pub fn record(&mut self, seconds: f64, submitted: bool) {
        self.submitted += u64::from(submitted);
        let elapsed = seconds - self.window_start;
        if elapsed >= 0.5 {
            self.rate = self.submitted as f64 / elapsed;
            self.window_start = seconds;
            self.submitted = 0;
        }
    }
    pub fn fps(&self) -> f64 {
        self.rate
    }
}
#[cfg(test)]
mod tests {
    use super::FrameRate;
    #[test]
    fn alternating_queue_bursts_do_not_inflate_fps() {
        let mut metric = FrameRate::default();
        let mut now = 0.0;
        // 100 submissions in one second, alternating 1 ms and 19 ms.
        // The old average of reciprocals would claim roughly 526 FPS.
        for i in 0..100 {
            now += if i % 2 == 0 { 0.001 } else { 0.019 };
            metric.record(now, true);
        }
        assert!((metric.fps() - 100.0).abs() < 0.01);
    }
    #[test]
    fn missing_drawables_and_pauses_do_not_count_as_frames() {
        let mut metric = FrameRate::default();
        for i in 1..=50 {
            metric.record(i as f64 / 100.0, i % 2 == 0);
        }
        assert_eq!(metric.fps(), 50.0);
        metric.record(1.5, false);
        assert_eq!(metric.fps(), 0.0);
    }
}
