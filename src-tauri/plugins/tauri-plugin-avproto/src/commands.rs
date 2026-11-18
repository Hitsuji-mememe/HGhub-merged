use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::AvprotoExt;
use crate::Result;

#[command]
pub(crate) async fn proto_load<R: Runtime>(
  app: AppHandle<R>,
  payload: ProtoLoadRequest,
) -> Result<ProtoLoadResponse> {
  app.avproto().proto_load(payload)
}

#[command]
pub(crate) async fn proto_status<R: Runtime>(
  app: AppHandle<R>,
  payload: ProtoEmptyRequest,
) -> Result<ProtoStatusResponse> {
  app.avproto().proto_status(payload)
}

#[command]
pub(crate) async fn proto_close<R: Runtime>(
  app: AppHandle<R>,
  payload: ProtoEmptyRequest,
) -> Result<ProtoStatusResponse> {
  app.avproto().proto_close(payload)
}
