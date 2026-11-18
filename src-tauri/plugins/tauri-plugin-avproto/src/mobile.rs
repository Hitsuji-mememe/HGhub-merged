use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_avproto);

// initializes the Swift plugin class (iOS only; other mobile targets have no
// implementation in this prototype and fail explicitly at setup)
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<Avproto<R>> {
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_avproto)?;
  #[cfg(not(target_os = "ios"))]
  let handle = {
    let _ = api;
    return Err(crate::Error::IosOnly);
  };
  Ok(Avproto(handle))
}

/// Access to the avproto APIs.
pub struct Avproto<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Avproto<R> {
  pub fn proto_load(&self, payload: ProtoLoadRequest) -> crate::Result<ProtoLoadResponse> {
    self
      .0
      .run_mobile_plugin("protoLoad", payload)
      .map_err(Into::into)
  }

  pub fn proto_status(&self, payload: ProtoEmptyRequest) -> crate::Result<ProtoStatusResponse> {
    self
      .0
      .run_mobile_plugin("protoStatus", payload)
      .map_err(Into::into)
  }

  pub fn proto_close(&self, payload: ProtoEmptyRequest) -> crate::Result<ProtoStatusResponse> {
    self
      .0
      .run_mobile_plugin("protoClose", payload)
      .map_err(Into::into)
  }
}
