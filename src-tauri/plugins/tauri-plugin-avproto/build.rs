const COMMANDS: &[&str] = &["proto_load", "proto_status", "proto_close"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .ios_path("ios")
    .build();
}
