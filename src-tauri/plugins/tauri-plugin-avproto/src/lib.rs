use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::Avproto;
#[cfg(mobile)]
use mobile::Avproto;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the avproto APIs.
pub trait AvprotoExt<R: Runtime> {
  fn avproto(&self) -> &Avproto<R>;
}

impl<R: Runtime, T: Manager<R>> crate::AvprotoExt<R> for T {
  fn avproto(&self) -> &Avproto<R> {
    self.state::<Avproto<R>>().inner()
  }
}

/// Initializes the plugin. AVFoundation 混合路线验证原型（Muse 2026-11-19）：
/// 只被设置页自检入口调用，正式播放路径不依赖本插件。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("avproto")
    .invoke_handler(tauri::generate_handler![
      commands::proto_load,
      commands::proto_status,
      commands::proto_close
    ])
    .setup(|app, api| {
      #[cfg(mobile)]
      let avproto = mobile::init(app, api)?;
      #[cfg(desktop)]
      let avproto = desktop::init(app, api)?;
      app.manage(avproto);
      Ok(())
    })
    .build()
}
