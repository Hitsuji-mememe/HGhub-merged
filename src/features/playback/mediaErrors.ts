import { isIos, isLinux } from "../../shared/api/api";

/* Muse 2026-11-18 (fe-audit): 文案即分类通道——Feed 的 onError 用英文 token 正则
   （decode/format/MEDIA_ERR/SRC_NOT_SUPPORTED 等）判定解码/格式类失败并按集锁 HEVC
   回退标准流（Feed.tsx）。hls.js 路径传的是 type/details 英文串，天然命中；原生路径
   只有 mediaErrorMessage 这条文案通道，纯中文文案永远命不中，HEVC 在原生引擎上
   解码失败也不会回退。故 code 3/4 必须带 token 后缀；code 2（网络）与 default
   绝不能带，否则网络错误会误锁 HEVC。 */
export function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 2:
      return "网络错误，视频加载失败，请检查网络后重试";
    case 3:
      return "视频解码失败，请重试 (decode)";
    case 4:
      return isLinux
        ? "当前系统缺少 H.264/AAC 解码器，请安装 gstreamer1.0-libav 和 gstreamer1.0-plugins-bad 后重试 (format)"
        : isIos
          ? "视频资源加载失败或格式不受支持，请重试 (format)"
          : "当前视频格式不受支持 (format)";
    default:
      return "视频加载失败，请重试";
  }
}
