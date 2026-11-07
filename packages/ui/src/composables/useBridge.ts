/**
 * useBridge —— 封装 window.attic 桥面。
 * 浏览器直开（无 Electron preload）时返回降级 mock：列表类返回空、动作类返回 no-bridge 错误，
 * 保证 UI 不崩且走"空状态"分支（缺桥横幅由 App.vue 依 hasBridge 展示）。
 * dev 演示模式（?demo=1，见 dev/demo.ts）：无真桥且 isDemo() 时以假数据覆写
 * 列表/设置/Java 探测，供无宿主时浏览器内排版；动作类仍走 mock 的 no-bridge 错误（不伪装可启动）。
 */

import { computed, type ComputedRef } from 'vue';
import {
  IPC_EVENTS,
  type AccountView,
  type AppSettings,
  type AtticEventPayloads,
  type CrashBundleResult,
  type CustomInfoView,
  type CustomVersionView,
  type GameBacklog,
  type GameExit,
  type GameExitEvent,
  type GameSession,
  type GameStatus,
  type InstanceView,
  type IpcResult,
  type JavaDetectionReport,
  type LaunchConfig,
  type LaunchCancelResult,
  type ModCategoryView,
  type ModInstallRequest,
  type MsDeviceCode,
  type RendererBridge,
  type ServerListView,
  type SystemInfo,
  type UpdateCheckResult,
  type VersionJson,
} from '@attic/core-spec';
import { demoCrashExit, demoCrashMode, demoInstances, demoJavaInstall, demoJavaReport, demoModCategories, demoServers, demoSettings, demoSoCrashExit, demoSysInfo, demoSysInfoPortable, demoUpdateCheck, demoVersions, isDemo, isDemoPortable, isDemoUpdate } from '../dev/demo';
import { buildTauriBridge } from '../bridge/tauri';

const NO_BRIDGE = 'no-bridge';

/** demo 假安装目录（Electron 安装版典型落位）：供向导/设置页护栏拒绝演练。 */
const DEMO_INSTALL_DIR = 'C:\\Users\\Player\\AppData\\Local\\Programs\\Attic';

/** demo pickDirectory 轮转值：第 2 次起命中安装目录 → 护栏拒绝错误行可在浏览器里排练。 */
const DEMO_PICK_PATHS = ['D:\\Games\\AtticData', DEMO_INSTALL_DIR + '\\data'];

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}
function err<T>(error: string): IpcResult<T> {
  return { ok: false, error };
}

/** 降级 mock：形状与契约一致，数据为空/安全默认（全部 async 返回 Promise，对齐 RendererBridge）。 */
const mockBridge: RendererBridge = {
  ping: async () => ok<string>('mock'),
  listVersions: async () => ok([]),
  getVersionJson: async () => err<VersionJson>(NO_BRIDGE),
  // 降级 mock 无本地 jar 可言：探测恒 false（菜单项禁用 = 可见降级语义）。
  probeVersionClass: async () => ok(false),
  dryRunLaunch: async () => err<LaunchConfig>(NO_BRIDGE),
  launch: async () => err<GameSession>(NO_BRIDGE),
  cancelLaunch: async () => err<LaunchCancelResult>(NO_BRIDGE),
  kill: async () => err<GameExit>(NO_BRIDGE),
  status: async () =>
    ok<GameStatus>({ running: false, session: null, lastExit: null, lastError: null }),
  detectJava: async () =>
    ok<JavaDetectionReport>({
      requiredMajor: 8,
      platform: 'browser',
      installs: [],
      failures: [],
      selection: { install: null, usedFallback: false, reason: NO_BRIDGE },
      diagnostics: [],
      startedAt: 0,
      finishedAt: 0,
    }),
  listAccounts: async () => ok([]),
  addAccount: async () => err<AccountView>(NO_BRIDGE),
  removeAccount: async () => err<void>(NO_BRIDGE),
  renameAccount: async () => err<AccountView>(NO_BRIDGE),
  // 微软登录属宿主认证链语义（DPAPI 落盘 + 五域白名单出站）：浏览器 mock 无真值。
  msStartLogin: async () => err<MsDeviceCode>(NO_BRIDGE),
  msCancelLogin: async () => err<void>(NO_BRIDGE),
  msRefreshAccount: async () => err<AccountView>(NO_BRIDGE),
  getSettings: async () => ok<AppSettings>({}),
  setSettings: async (s) => ok(s),
  listInstances: async () => ok([]),
  saveInstance: async (i) => ok(i),
  // 删除与保存同族（表单可用性：UI 就地更新清单，不依赖假 fs）；打开目录是 fs 动作，浏览器无意义。
  deleteInstance: async () => ok<void>(undefined),
  // 改名同族：UI 本地就地换名，返回值不参与渲染，回个合法形状即可。
  renameInstance: async (_name: string, newName: string) => ok<InstanceView>({ name: newName, version: '' }),
  // 选中即写回：浏览器 mock 无 fs，就地回声入参形状（UI upsert 语义成立）。
  setInstanceVersion: async (_name: string | null, versionId: string) =>
    ok<InstanceView>({ name: _name || 'default instance', version: versionId }),
  // addons 即落盘：同款回声（勾选集原样带回）。
  setInstanceAddons: async (_name: string | null, addons: string[]) =>
    ok<InstanceView>({ name: _name || 'default instance', version: '', addons }),
  openInstanceDir: async () => err<void>(NO_BRIDGE),
  windowControl: async () => ok<void>(undefined), // 浏览器无窗可控：no-op
  openConsoleWindow: async () => err<void>(NO_BRIDGE),
  // backlog 属宿主事件缓存，浏览器 mock 无真值（控制台窗 mock 链路本就不存在）。
  getGameBacklog: async () => err<GameBacklog>(NO_BRIDGE),
  listCustomVersions: async () => ok<CustomVersionView[]>([]),
  getCustomVersionInfo: async () => err<CustomInfoView>(NO_BRIDGE),
  saveCustomVersionInfo: async () => err<CustomVersionView>(NO_BRIDGE),
  importCustomJar: async () => err<CustomVersionView | null>(NO_BRIDGE),
  removeCustomVersion: async () => err<void>(NO_BRIDGE),
  // Mods 仓库属网络 + fs 宿主语义：mock 列表回空（空态分支可排），安装可见失败。
  listMods: async () => ok<ModCategoryView[]>([]),
  installMod: async () => err<void>(NO_BRIDGE),
  // 服务器列表属网络宿主语义：mock 回空（空态+重试分支可排）。
  listServers: async () => ok<ServerListView[]>([]),
  // —— 设置页宿主能力面：fs/对话框/内存/检查更新属宿主语义，浏览器无真值（err 可见失败）——
  getSystemInfo: async () => err<SystemInfo>(NO_BRIDGE),
  checkUpdate: async () => err<UpdateCheckResult>(NO_BRIDGE),
  openSpecialDir: async () => err<void>(NO_BRIDGE),
  clearLogs: async () => err<number>(NO_BRIDGE),
  pickJavaExecutable: async () => err<string | null>(NO_BRIDGE),
  pickDirectory: async () => err<string | null>(NO_BRIDGE),
  pickImageFile: async () => err<string | null>(NO_BRIDGE),
  readImageAsDataUrl: async () => err<string>(NO_BRIDGE),
  // 外链是唯一浏览器可忠实实现的"宿主动作"：window.open 即系统默认浏览器行为，照常放行。
  openExternalUrl: async (url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`仅允许 http/https：${parsed.protocol}`);
      // 弹窗被拦截时 window.open 返回 null：如实报失败（与宿主无浏览器 reject 同弹窗呈现）
      if (!window.open(url, '_blank', 'noopener')) throw new Error('弹窗被浏览器拦截（popup blocked）');
      return ok<void>(undefined);
    } catch (error) {
      return err<void>(error instanceof Error ? error.message : String(error));
    }
  },
  // 崩溃上报与诊断包属宿主 fs/环境语义：浏览器 mock 无真值（CrashPanel 三按钮走可见失败）。
  reportRendererError: async () => err<void>(NO_BRIDGE),
  getCrashBundle: async () => err<CrashBundleResult>(NO_BRIDGE),
  on: () => () => {},
};

export interface BridgeHandle {
  bridge: RendererBridge;
  hasBridge: ComputedRef<boolean>;
}

/** 演示覆写：只改"读"侧数据源与可演练的写侧护栏，其余动作/窗控沿用 mock（假数据不伪装成真宿主行为）。 */
function demoBridge(): RendererBridge {
  // pickDirectory 轮转计数（每次建桥一个闭包，页面刷新即重置 = demo 无持久化语义）
  let pickCount = 0;
  return {
    ...mockBridge,
    listVersions: async () => ok(demoVersions),
    // 演示假探测：infdev 行（in-20100223）视为含 isom 类，让「≡」菜单的 visualizer 项可演练；
    // 其余版本 false，展示"探测不中即禁用"两态。
    probeVersionClass: async (versionId) => ok(versionId === 'in-20100223'),
    listInstances: async () => ok(demoInstances),
    getSettings: async () => ok<AppSettings>(demoSettings),
    detectJava: async () => ok<JavaDetectionReport>(demoJavaReport),
    // 假宿主快照：让设置页通用/内存/关于栏在浏览器里排出真稿（动作类仍走 mock err）。
    getSystemInfo: async () => ok<SystemInfo>(isDemoPortable() ? demoSysInfoPortable : demoSysInfo),
    // 假检查更新：?demo=1&update=1 才回假 update 包（三钮弹窗/忽略账演练面），
    // 日常 demo 回 upToDate——自动检查链不被弹窗打扰（手动按钮仍可排四分支）。
    checkUpdate: async () =>
      ok<UpdateCheckResult>(
        isDemoUpdate() ? demoUpdateCheck : { status: 'upToDate', current: demoSysInfo.launcherVersion },
      ),
    // 首启向导演练面：建号/目录选择器/Java 选择器给假值可走通三步。
    addAccount: async (name: string) => ok<AccountView>({ id: `demo-${name.toLowerCase()}`, name, type: 'offline' }),
    // 设备码弹窗排版面：start 回假码（demo 无事件流，停在等待态可排；cancel 可关）。
    msStartLogin: async () =>
      ok<MsDeviceCode>({ userCode: 'ABCD-EFGH', verificationUri: 'https://www.microsoft.com/link', expiresIn: 900, interval: 5 }),
    msCancelLogin: async () => ok<void>(undefined),
    // demo 假安装目录护栏：rootOverride 落进它内即拒绝（文案与 runtime 护栏一致；
    // 前缀比对去掉尾部分隔符再拼 sep，兄弟前缀不误判，与 isPathWithin 同规则）。
    setSettings: async (s: AppSettings) => {
      if (s.rootOverride) {
        const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
        const parent = norm(DEMO_INSTALL_DIR);
        const child = norm(s.rootOverride);
        const hit = child === parent || child.startsWith(parent + '\\') || child.startsWith(parent + '/');
        if (hit) {
          return err<AppSettings>(
            '游戏数据不能放进安装目录——卸载时会连同整个安装目录删除，存档不可恢复。' +
              '请选安装目录之外的位置；想要「一切随一个文件夹」请用便携版构件（attic-*-portable.zip）。',
          );
        }
      }
      return ok(s);
    },
    pickDirectory: async () => ok<string | null>(DEMO_PICK_PATHS[pickCount++ % DEMO_PICK_PATHS.length] ?? null),
    pickJavaExecutable: async () => ok<string | null>(demoJavaInstall.executable),
    // 事件面：默认沿用 mock 的恒不发射；唯一例外 = 崩溃演练（?demo=1&crash=1|2），
    // GAME_EXIT 订阅后 1.2s 发对应假退出，让崩溃弹窗排版可看（退订即撤销）。
    on: <E extends keyof AtticEventPayloads>(event: E, cb: (payload: AtticEventPayloads[E]) => void): (() => void) => {
      const mode = event === IPC_EVENTS.GAME_EXIT ? demoCrashMode() : null;
      if (mode) {
        const payload = mode === 'a123' ? demoSoCrashExit : demoCrashExit;
        const timer = window.setTimeout(
          () => (cb as (payload: GameExitEvent) => void)(payload),
          1200,
        );
        return () => window.clearTimeout(timer);
      }
      return () => {};
    },
    // 背景图演练面：选择器回假路径，读取回 1px 透明 PNG（链路可通；遮罩+暗上下文覆写真实生效）。
    pickImageFile: async () => ok<string | null>('D:\\Pictures\\background.png'),
    readImageAsDataUrl: async () =>
      ok<string>('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
    // Mods 页演示：假仓库「现拉现发」= 每次深拷贝返回（与真宿主语义一致——直接回原数组引用时，
    // installMod 的原地改写落在 raw 对象上、绕过 Vue reactive 代理，installed 徽标不刷新）。
    listMods: async () => ok<ModCategoryView[]>(structuredClone(demoModCategories)),
    // 服务器页演示：假列表「现拉现发」深拷贝（面板就地改写不污染 raw 源）。
    listServers: async () => ok<ServerListView[]>(structuredClone(demoServers)),
    installMod: async (request: ModInstallRequest) => {
      for (const cat of demoModCategories) {
        for (const mod of cat.mods) {
          if (mod.fullName === request.fullName) mod.installed = true;
        }
      }
      return ok<void>(undefined);
    },
    // 自定义页演示：mod 托管项随假仓库派生（installed 即入列，jar 恒未合成）；
    // 删除联动翻回未安装 → Mods 页徽标恢复「下载」，卸载链路可演练。
    listCustomVersions: async () =>
      ok<CustomVersionView[]>(
        demoModCategories
          .flatMap((c) => c.mods)
          .filter((m) => m.installed)
          .map((m) => ({ id: m.fullName, installed: false, configured: true, mod: true })),
      ),
    removeCustomVersion: async (id: string) => {
      let hit = false;
      for (const cat of demoModCategories) {
        for (const mod of cat.mods) {
          if (mod.fullName === id) {
            mod.installed = false;
            hit = true;
          }
        }
      }
      return hit ? ok<void>(undefined) : err<void>(NO_BRIDGE);
    },
    // 已安装 mod 的详情 = 托管只读态演示（props 为假 .info 形状）；其余 id 维持 mock err。
    getCustomVersionInfo: async (id: string) => {
      for (const cat of demoModCategories) {
        for (const mod of cat.mods) {
          if (mod.fullName === id && mod.installed) {
            return ok<CustomInfoView>({
              id,
              configured: true,
              mod: true,
              launchMethods: [],
              props: {
                'base-version': 'b1.7.3',
                url: `http://files.betacraft.uk/repository/${encodeURIComponent(mod.fullName)}.jar`,
                sha1: '0'.repeat(40),
              },
            });
          }
        }
      }
      return err<CustomInfoView>(NO_BRIDGE);
    },
  };
}

export function useBridge(): BridgeHandle {
  // 真桥两级探测：Electron preload 注入的 window.attic 优先；
  // Tauri 壳（withGlobalTauri）以 __TAURI__ 全局面适配出同款 RendererBridge。
  const real =
    typeof window !== 'undefined'
      ? window.attic ?? (window.__TAURI__ ? buildTauriBridge(window.__TAURI__) : undefined)
      : undefined;
  const bridge = real ?? (isDemo() ? demoBridge() : mockBridge);
  return {
    bridge,
    hasBridge: computed(() => real !== undefined),
  };
}
