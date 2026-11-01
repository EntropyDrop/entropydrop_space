fn main() {
    println!("cargo:rerun-if-env-changed=SPACE_NODE");
    let node = std::env::var("SPACE_NODE")
        .ok()
        .or_else(|| {
            std::process::Command::new("node")
                .args(["-p", "process.execPath"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        })
        .unwrap_or_else(|| "node".to_owned());
    println!("cargo:rustc-env=SPACE_BUILD_NODE={node}");
    let files = [
        "../proto/inventory.proto",
        "../proto/backpack.proto",
        "../proto/space_api.proto",
    ];
    for file in files {
        println!("cargo:rerun-if-changed={file}");
    }
    let mut config = prost_build::Config::new();
    config.type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]");
    config
        .compile_protos(&files, &["../proto"])
        .expect("compile canonical Space protobufs (requires protoc)");
}
