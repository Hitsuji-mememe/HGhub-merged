use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<Avproto<R>> {
  Ok(Avproto(app.clone()))
}

/// Access to the avproto APIs. The prototype is iOS-only: every call on
/// desktop returns an explicit error instead of pretending to work.
pub struct Avproto<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Avproto<R> {
  pub fn proto_load(&self, _payload: ProtoLoadRequest) -> crate::Result<ProtoLoadResponse> {
    Err(crate::Error::IosOnly)
  }

  pub fn proto_status(&self, _payload: ProtoEmptyRequest) -> crate::Result<ProtoStatusResponse> {
    Err(crate::Error::IosOnly)
  }

  pub fn proto_close(&self, _payload: ProtoEmptyRequest) -> crate::Result<ProtoStatusResponse> {
    Err(crate::Error::IosOnly)
  }
}
