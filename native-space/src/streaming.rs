use crate::world::{Chunk, WorldSource};
use anyhow::{Context, Result, ensure};
use crossbeam_channel::{Receiver, Sender, bounded};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Write},
    process::{Child, Stdio},
    thread,
};

type Key = (i32, i32);
pub struct Streaming {
    requests: Sender<Key>,
    pub responses: Receiver<(Key, Result<Chunk>)>,
    pub pending: HashSet<Key>,
}
struct Generator {
    child: Child,
    output: BufReader<std::process::ChildStdout>,
}
impl Generator {
    fn new(source: &WorldSource) -> Result<Self> {
        let mut child = crate::node_command()
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tools/terrain.ts"))
            .arg("--worker")
            .arg(format!("--world={}", source.manifest.world))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context(
                "Start production terrain adapter; Node 24 is required until generators are ported",
            )?;
        let output = BufReader::new(child.stdout.take().unwrap());
        Ok(Self { child, output })
    }
    fn generate(&mut self, key: Key) -> Result<()> {
        let input = self
            .child
            .stdin
            .as_mut()
            .context("Generator input closed")?;
        writeln!(input, "{{\"x\":{},\"z\":{}}}", key.0, key.1)?;
        input.flush()?;
        let mut line = String::new();
        self.output.read_line(&mut line)?;
        let response: serde_json::Value =
            serde_json::from_str(&line).context("Invalid terrain adapter response")?;
        ensure!(
            response["ok"] == true,
            "Terrain adapter: {}",
            response["error"]
        );
        Ok(())
    }
}
impl Drop for Generator {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Streaming {
    pub fn new(source: WorldSource) -> Self {
        let (tx, rx) = bounded::<Key>(32);
        let (output, input) = bounded(8);
        thread::Builder::new()
            .name("space-terrain".into())
            .spawn(move || {
                let mut generator: Option<Generator> = None;
                while let Ok(key) = rx.recv() {
                    let result = (|| {
                        if !source.available(key) {
                            if generator.is_none() {
                                generator = Some(Generator::new(&source)?);
                            }
                            generator.as_mut().unwrap().generate(key)?;
                        }
                        source.load(key)
                    })();
                    if output.send((key, result)).is_err() {
                        break;
                    }
                }
            })
            .expect("start terrain thread");
        Self {
            requests: tx,
            responses: input,
            pending: HashSet::new(),
        }
    }
    pub fn request(&mut self, key: Key) {
        if !self.pending.contains(&key) && self.requests.try_send(key).is_ok() {
            self.pending.insert(key);
        }
    }
}
