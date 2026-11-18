import { Button, SegmentedControl, Surface, TextArea } from "../../shared/ui/ios/controls";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, APP_VERSION, BUILD_STAMP, hostOf, isMobile, logLine, platform, type UpdateInfo } from "../../shared/api/api";
import { useStore } from "../../shared/model/store";
import { Modal, Toggle } from "../../shared/ui/ui";
import LinePicker from "./LinePicker";
import ProxySettings from "./ProxySettings";
import ContentPreferencesSettings from "./ContentPreferencesSettings";
import SettingsSection from "./SettingsSection";
import { UsageAgreementText } from "../../shared/ui/UsageAgreement";
import { USAGE_AGREEMENT_VERSION } from "../../shared/storage/usageAgreement";
import { autoLineEnabled, setAutoLine } from "../../shared/network/autoLine";
import { initPlaybackLog } from "../../shared/diagnostics/playbackDiagnostics";
import { buildDiagnosticReport } from "../../shared/diagnostics/diagnosticReport";
import { copyText } from "../../shared/lib/clipboard";
import { Loader } from "../../shared/ui/ios/effects";
import { IBack, IBoltF, IBroom, IChevR, ICompress, IHeart, IInfo, ILink, ILockF, IMoon, IRefresh, ISparkF, ISun, IVolMute } from "../../shared/ui/icons";

const SETTING_GROUPS = ["外观", "播放", "内容偏好", "本地数据", "网络", "诊断", "其他"] as const;
type SettingGroup = typeof SETTING_GROUPS[number];

/* 独立设置页：线路 / 外观 / 播放 / 本地数据 / 清理缓存 / 网络诊断 / 关于
   入口：Windows 侧栏「设置」、Android「我的」右上角齿轮 */
export default function Settings({ onBack, initialSection }: { onBack: () => void; wide: boolean; initialSection?: "内容偏好" }) {
  const { theme, themePreference, setTheme, favs, history, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity, toast, srPref, setSrPref, fsIdleSecs, setFsIdleSecs } = useStore();
  const [about, setAbout] = useState(false);
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const [lineBase, setLineBase] = useState("");
  const [autoLineOn, setAutoLineOn] = useState(autoLineEnabled);
  const clearBusy = useRef(false);
  const [clearError, setClearError] = useState("");
  const [lineError, setLineError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagReport, setDiagReport] = useState<string | null>(null);
  const [copyingReport, setCopyingReport] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<SettingGroup>>(() => new Set(initialSection ? [initialSection] : []));
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!initialSection) return;
    const frame = requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(`#settings-${initialSection}`);
      target?.scrollIntoView({ block: "start", behavior: "instant" });
      target?.querySelector<HTMLElement>(".ios-settings-trigger")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialSection]);
  const section = (title: SettingGroup, children: ReactNode) => <SettingsSection title={title}
    open={openGroups.has(title)} onToggle={() => setOpenGroups(previous => {
      const next = new Set(previous);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    })}>{children}</SettingsSection>;

  useEffect(() => { void initPlaybackLog(); }, []);

  const readLine = () => { api.lineState().then((state) => { setLineBase(state.base); setLineError(""); }).catch(() => setLineError("线路读取失败，点击重新选择")); };
  useEffect(() => {
    const sync = () => { readLine(); setAutoLineOn(autoLineEnabled()); };
    sync();
    window.addEventListener("hg:line-changed", sync);
    window.addEventListener("hg:auto-line-changed", sync);
    return () => {
      window.removeEventListener("hg:line-changed", sync);
      window.removeEventListener("hg:auto-line-changed", sync);
    };
  }, []);

  return (
    <div className="ios-page ios-settings-page absolute inset-0 bg-bg flex flex-col">
      <div data-settings-header className="ios-settings-header shrink-0">
        <div className="ios-settings-column">
          <Button onClick={onBack} aria-label="返回" className="ios-icon-button"><IBack size={20} /></Button>
        </div>
      </div>
      <div data-settings-scroll className="ios-page-body flex-1 min-h-0 scroll-y">
        <div ref={contentRef} className="ios-settings-column ios-settings-content">
          <div className="pt-1 pb-4">
            <h1 className="ios-page-title text-on">设置</h1>
          </div>
          {section("外观", <>
            <div className="ios-appearance-row items-center">
              <span className="ios-setting-icon">{themePreference === "system" ? <IRefresh size={16} /> : theme === "dark" ? <IMoon size={16} /> : <ISun size={16} />}</span>
              <div className="flex-1">
                <div className="text-[14px] text-on">外观</div>
                <div className="text-[12px] text-mut">{themePreference === "system" ? `跟随系统（当前${theme === "dark" ? "深色" : "浅色"}）` : theme === "dark" ? "深色外观" : "浅色外观"}</div>
              </div>
              <SegmentedControl className="ios-appearance-picker" aria-label="外观模式" activeIndex={(["system", "light", "dark"] as const).indexOf(themePreference)}>
                {([['system', '跟随'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => (
                  <Button key={value} type="button" aria-pressed={themePreference === value}
                    onClick={() => setTheme(value)}>
                    {label}
                  </Button>
                ))}
              </SegmentedControl>
            </div>
          </>)}

          {section("播放", <>
            {/* 超分全自动的唯一覆盖项（2026-11-18 用户裁定）：播放界面入口已全撤，
                这里只留 自动/关闭 两档；具体档位按源分辨率自动选，用户不再选档 */}
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><ISparkF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">画质超分</div>
                <div className="text-[12px] text-mut">自动：按源分辨率＋码率密度选档（低清/糊源强效 · 真高清直通）；关闭：原画直通</div>
              </div>
              <SegmentedControl aria-label="画质超分模式" activeIndex={srPref === "auto" ? 0 : 1}>
                {([["auto", "自动"], ["off", "关闭"]] as const).map(([value, label]) => (
                  <Button key={value} type="button" aria-pressed={srPref === value}
                    onClick={() => setSrPref(value)}>
                    {label}
                  </Button>
                ))}
              </SegmentedControl>
            </div>
            {isMobile && <div className="ios-settings-row flex-wrap">
              <span className="ios-setting-icon"><ICompress size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">全屏无操作自动隐藏控件</div>
                <div className="text-[12px] text-mut">全屏播放时控件闲置后自动隐藏，单击画面可再显示</div>
              </div>
              <SegmentedControl className="w-full" aria-label="全屏无操作自动隐藏控件" activeIndex={[0, 3, 5, 10].indexOf(fsIdleSecs)}>
                {([[0, "关"], [3, "3秒"], [5, "5秒"], [10, "10秒"]] as const).map(([secs, label]) => (
                  <Button key={secs} type="button" aria-pressed={fsIdleSecs === secs} onClick={() => setFsIdleSecs(secs)}>{label}</Button>
                ))}
              </SegmentedControl>
            </div>}
          </>)}

          {section("内容偏好", <ContentPreferencesSettings />)}

          {section("本地数据", <>
            <div className="ios-settings-row">
              <span className="ios-setting-icon"><IHeart size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">本地片库</div>
                <div className="text-[12px] text-mut">{favs.length} 部收藏 · {history.length} 条观看记录</div>
              </div>
            </div>
            <Button onClick={() => { setClearError(""); setClearOpen(true); }} className="ios-settings-row text-left pressable">
              <span className="ios-setting-icon"><IBroom size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">清理缓存</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </>)}

          {section("网络", <>
            <ProxySettings />
            <Button onClick={() => setLineOpen(true)} className="ios-settings-row text-left pressable">
              <span className="ios-setting-icon"><IBoltF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">播放源</div>
                <div className="text-[12px] text-mut truncate">{lineError || (lineBase ? hostOf(lineBase) : "读取中…")}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
            <div className="ios-settings-row">
              <span className="ios-setting-icon"><IRefresh size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">自动选择线路</div>
                <div className="text-[12px] text-mut">主站不可用时检测已发布镜像；关闭后保留手动选择</div>
              </div>
              <Toggle desktop label="自动选择线路" on={autoLineOn} onChange={(on) => {
                void setAutoLine(on).catch(() => toast("自动选线暂停失败，请重试", "info"));
                setAutoLineOn(on);
                toast(on ? "已开启自动选择线路" : "已关闭自动选线，可手动选择播放源", "info");
              }} />
            </div>
            <div className="ios-settings-row">
              <span className="ios-setting-icon"><ILockF size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">严格安全模式</div>
                <div className="text-[12px] text-mut">
                  {cliRelaxed
                    ? "已由启动参数 --no-strict 切换为兼容模式；可手动重新开启"
                    : "默认开启，防上游投毒与内网探测；若导致正文或特殊代理异常可关闭（或用 --no-strict 启动）"}
                </div>
              </div>
              <Toggle desktop
                on={strictSecurity}
                disabled={!strictSecurityReady || securityPending}
                onChange={(on) => {
                  void setStrictSecurity(on).then(() => {
                    toast(on ? "已开启严格安全模式" : "已切换为兼容模式（关闭激进清洗与守卫）", "info");
                  }).catch(() => toast("安全设置保存失败，已保持原模式", "info"));
                }}
                label="严格安全模式"
              />
            </div>
          </>)}

          {section("诊断", <>
            {/* 收官批 D 合并：原「网络诊断」行与整个「播放诊断」区（含日志
                开关与日志路径）全部删除，只剩这一个入口——点开即生成
                （网络探测 + 最近播放流水 + 当前线路/超分/源规格），页面内
                预览全文 + 一个「复制报告」按钮。记录始终开启、无开关。 */}
            <Button disabled={diagnosing} onClick={async () => {
              setDiagnosing(true);
              try { setDiagReport(await buildDiagnosticReport()); }
              catch (e) { toast(`诊断报告生成失败：${e instanceof Error ? e.message : "请稍后重试"}`, "info"); }
              finally { setDiagnosing(false); }
            }} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="ios-setting-icon"><IInfo size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">{diagnosing ? "正在生成…" : "诊断报告"}</div>
                <div className="text-[12px] text-mut">网络探测＋最近播放流水＋当前线路/超分，一键生成可复制全文</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
            {/* 构建戳（Muse 2026-11-18 U6a）：与诊断报告头同一行，帮助对
                报告时先对构建——版本同为 2.2.0 的不同构建靠它区分。 */}
            <div className="px-3.5 py-2 text-[12px] text-mut">构建 {BUILD_STAMP}</div>
          </>)}

          {section("其他", <>
            
            <Button onClick={() => setAgreementOpen(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="ios-setting-icon"><ILockF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">使用条款与免责声明</div>
                <div className="text-[12px] text-mut">查看完整协议与中国大陆下载传播限制</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
            <Button onClick={() => setAbout(true)} className="ios-settings-row text-left pressable">
              <span className="ios-setting-icon"><IInfo size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">关于 HGhubX</div>
                <div className="text-[12px] text-mut">版本 {APP_VERSION} · 仅限非商业使用</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </>)}

          <div className="text-center text-[12px] text-dim mt-5">HGhubX {APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} 客户端</div>
        </div>
      </div>

      <LinePicker open={lineOpen} onClose={() => { setLineOpen(false); readLine(); }} />

      <Modal label="使用条款与免责声明" open={agreementOpen} onClose={() => setAgreementOpen(false)} width={680}>
        <div className="flex flex-col min-h-0 max-h-[78dvh]">
          <div className="shrink-0 flex items-center justify-between gap-3 p-4 border-b border-s3">
            <h2 className="text-[17px] font-bold text-on">使用条款与免责声明</h2>
            <Button className="min-h-11 px-3 shrink-0" onClick={() => setAgreementOpen(false)}>关闭</Button>
          </div>
          <div className="flex-1 min-h-0 scroll-y p-4 select-text" tabIndex={0} aria-label="协议正文">
            <p className="text-[12px] text-mut mb-4">协议版本 {USAGE_AGREEMENT_VERSION} · 查看协议不会更改本机确认记录</p>
            <UsageAgreementText />
          </div>
        </div>
      </Modal>

      <Modal label="诊断报告" open={diagReport !== null} onClose={() => setDiagReport(null)} width={520}>
        <div className="p-5">
          <h2 className="text-[15px] font-bold text-on">诊断报告</h2>
          <p className="text-[13px] text-mut mt-2">结论先行：网络、线路与最近播放卡点都在开头。整篇复制发给维护者即可一次定位。</p>
          <TextArea readOnly aria-label="诊断报告" value={diagReport ?? ""}
            className="w-full h-64 mt-3 p-3 rounded-(--r-sm) bg-s3 text-[12px] text-on resize-none" />
          <div className="flex gap-2 mt-4">
            <Button onClick={() => setDiagReport(null)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on pressable">关闭</Button>
            <Button disabled={copyingReport} onClick={async () => {
              if (diagReport === null) return;
              setCopyingReport(true);
              try { await copyText(diagReport); toast("诊断报告已复制", "ok"); setDiagReport(null); }
              catch { toast("复制失败，请选择报告文字手动复制", "info"); }
              finally { setCopyingReport(false); }
            }} className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[14px] pressable disabled:opacity-60">{copyingReport ? "正在复制…" : "复制报告"}</Button>
          </div>
        </div>
      </Modal>

      <Modal label="关于 HGhubX" open={about} onClose={() => setAbout(false)} width={392}>
        <div className="p-5">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-(--r-sm) brand-grad glow-neon flex items-center justify-center text-on-primary text-[17px] font-black">H</span>
            <div>
              <div className="text-[16px] font-bold text-on leading-tight">HGhubX</div>
              <div className="text-[12px] text-mut mt-0.5">HGhubX 客户端 v{APP_VERSION}</div>
            </div>
          </div>

          <p className="text-[13px] text-on/70 leading-relaxed mt-4">
            基于 Rust + Tauri 2 构建的跨平台客户端，支持 Windows、macOS、Linux、Android 与 iOS。
          </p>

          <Surface className="mt-4 rounded-(--r-sm) bg-s3/60 p-3 text-[12px] text-mut leading-relaxed">
            仅限符合使用条款的成年人使用；禁止在中国大陆地区下载和传播本软件及相关资源。
            第三方内容的权利属于各自权利人，访问内容不代表获得下载或传播授权。
          </Surface>

          <div className="mt-4 divide-y divide-s3">
            <Button aria-label="打开项目仓库" onClick={() => { api.openUrl("https://github.com/zxsos/HGhubX").catch(() => { copyText("https://github.com/zxsos/HGhubX").then(() => toast("仓库地址已复制", "ok")).catch(() => {}); }); }}
              className="w-full flex items-center gap-2 py-2.5 text-left pressable">
              <ILink size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">github.com/zxsos/HGhubX</span>
              <span className="ml-auto text-[12px] text-primary">打开</span>
            </Button>
            <Button onClick={() => { copyText("https://huangguoai.com").then(() => toast("站点地址已复制", "ok")).catch(() => {}); }}
              className="w-full flex items-center gap-2 py-2.5 text-left pressable">
              <ILink size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">huangguoai.com</span>
              <span className="ml-auto text-[12px] text-primary">复制</span>
            </Button>
            <div className="flex items-center gap-2 py-2.5">
              <IInfo size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">PolyForm Noncommercial 1.0.0</span>
              <span className="ml-auto text-[12px] text-mut">仅限非商业</span>
            </div>
          </div>

          <Button onClick={() => setAbout(false)} className="mt-4 w-full h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on pressable">知道了</Button>
        </div>
      </Modal>

      <Modal label="清理缓存" open={clearOpen} onClose={() => { if (!clearBusy.current) setClearOpen(false); }} width={330}>
        <div className="p-5">
          <div className="text-[15px] font-bold text-on">清理缓存</div>
          <p className="text-[13px] text-mut leading-relaxed mt-2">
            清除封面、播放列表、Key/分片缓存；Linux 桌面版还会选择性清理 WebKit HTTP/媒体磁盘缓存。登录、收藏、观看记录与本地设置都会保留。
          </p>
          {clearError && <p role="alert" className="text-[13px] text-danger mt-3">{clearError}</p>}
          <div className="flex gap-2 mt-5">
            <Button disabled={clearing} onClick={() => setClearOpen(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on/80 pressable">取消</Button>
            <Button disabled={clearing} onClick={async () => {
              if (clearBusy.current) return;
              clearBusy.current = true;
              setClearing(true); setClearError("");
              try {
                const cleared = await api.clearCache();
                setClearOpen(false);
                toast(cleared.webCache ? "缓存已清理（含 WebKit 媒体缓存）" : "应用内缓存已清理", "ok");
              } catch (error) {
                setClearError(error instanceof Error ? error.message : String(error || "清理失败，请重试"));
              } finally { clearBusy.current = false; setClearing(false); }
            }} className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[14px] font-semibold text-on-primary pressable disabled:opacity-60">
              {clearing ? "清理中…" : "确定清理"}
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  );
}
