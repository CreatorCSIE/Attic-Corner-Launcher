<script setup lang="ts">
/**
 * 应用壳 —— 顶栏 + 缺桥横幅 + 左侧图标+文字侧栏 + 主体（ui-design.md §3 布局范式）。
 * 侧栏最上端 = BrandWordmark（≡ + 完整名称双行）；底部保留作者头像。
 * 启动视图：主区左上 = AccountHero（皮肤头+用户名+欢迎语）；版本列表 | 启动面板（Play 右下）。
 * 控制台解耦（v1 语义）：主页不再内嵌 ConsolePanel；?window=console 的独立窗只渲染顶栏+全屏控制台。
 * view 切换仍是 ref 状态，零 vue-router；图标为内联 lucide 路径（MIT），零新依赖。
 */
import { onMounted, ref, watch } from 'vue';
import { useI18n } from './i18n';
import { useBridge } from './composables/useBridge';
import TitleBar from './components/TitleBar.vue';
import BrandWordmark from './components/BrandWordmark.vue';
import AccountHero from './components/AccountHero.vue';
import LaunchPanel from './components/LaunchPanel.vue';
import ConsolePanel from './components/ConsolePanel.vue';
import InstanceList from './components/InstanceList.vue';
import AccountsPanel from './components/AccountsPanel.vue';
import CustomVersionsPanel from './components/CustomVersionsPanel.vue';
import ModsPanel from './components/ModsPanel.vue';
import ServersPanel from './components/ServersPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import CrashPanel from './components/CrashPanel.vue';
import ExternalLinkErrorDialog from './components/ExternalLinkErrorDialog.vue';
import UpdateDialog from './components/UpdateDialog.vue';
import WelcomeWizard from './components/WelcomeWizard.vue';
import { goSection } from './composables/useSettingsNav';
import { useUpdateCheck } from './composables/useUpdateCheck';
import { useJava } from './composables/useJava';

/** 独立控制台窗模式：主进程以 ?window=console 加载同一 UI，只渲染控制台。 */
const isConsoleWindow =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('window') === 'console';

type View = 'launch' | 'instances' | 'accounts' | 'custom' | 'mods' | 'servers' | 'settings';
const view = ref<View>('launch');

// —— 页面切换方向（BlockHelm GetTransitionStartOffset 实测配方，用户指定）：
//    按导航序前进 → 新页自下方 +22px 浮现；后退 → 自上方 -22px。 ——
const VIEW_ORDER: readonly View[] = ['launch', 'instances', 'accounts', 'custom', 'mods', 'servers', 'settings'];
const pageDy = ref('22px');
watch(view, (next, prev) => {
  pageDy.value = VIEW_ORDER.indexOf(next) >= VIEW_ORDER.indexOf(prev) ? '22px' : '-22px';
});
const { t } = useI18n();
const { hasBridge } = useBridge();

// —— 侧栏折叠：≡ 切换 图标+文字 ↔ 窄图标 rail，偏好持久化 ——
const SIDEBAR_KEY = 'attic:sidebar-collapsed:v1';
const sidebarCollapsed = ref(false);
try {
  sidebarCollapsed.value = localStorage.getItem(SIDEBAR_KEY) === '1';
} catch {
  /* 隐私模式：默认展开 */
}
function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  try {
    localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed.value ? '1' : '0');
  } catch {
    /* 隐私模式 */
  }
}

// —— 侧栏底部作者头像：在线取 GitHub 头像，localStorage 缓存（TTL 7 天），失败回落旧缓存/占位 ——
const CREATOR_GITHUB = 'CreatorCSIE';
const AVATAR_CACHE_KEY = 'attic:creator-avatar:v1';
const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const avatarSrc = ref('');

function readAvatarCache(): { at: number; src: string } | null {
  try {
    const raw = localStorage.getItem(AVATAR_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { at?: unknown; src?: unknown };
    return typeof v.src === 'string' && typeof v.at === 'number' ? { at: v.at, src: v.src } : null;
  } catch {
    return null;
  }
}

async function loadCreatorAvatar(): Promise<void> {
  const cached = readAvatarCache();
  if (cached && Date.now() - cached.at < AVATAR_TTL_MS) {
    avatarSrc.value = cached.src;
    return;
  }
  try {
    // api.github.com 带 CORS；avatar_url（avatars.githubusercontent.com）同样允许跨域 fetch。
    const user = await fetch(`https://api.github.com/users/${CREATOR_GITHUB}`).then((r) => {
      if (!r.ok) throw new Error(`github api ${r.status}`);
      return r.json();
    });
    const blob = await fetch(`${user.avatar_url}&s=128`).then((r) => {
      if (!r.ok) throw new Error(`avatar ${r.status}`);
      return r.blob();
    });
    const src = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify({ at: Date.now(), src }));
    avatarSrc.value = src;
  } catch {
    if (cached) avatarSrc.value = cached.src; // 断网/限流：过期缓存兜底
  }
}

// 检查更新链（策略门控：startup = 启动自动查一次，off = 从不自动查；24h 轮询已删）：
// 只挂主页，控制台窗不重复发请求；自动结果过打扰门才打扰（弹窗+关于栏红点，
// useUpdateCheck 模块级单例共享，UpdateDialog 全局挂本层——关于页外也要能弹）。
const updateCheck = useUpdateCheck();

onMounted(() => {
  if (!isConsoleWindow) {
    void loadCreatorAvatar();
    updateCheck.start();
    // Java 探测启动预热（2026-10-31 用户拍板）：useJava 模块级缓存，进设置 Java 栏/向导
    // 直接命中不再干等扫描；「刷新检测」按钮强制重探行为不变。
    void useJava().detect();
  }
});
</script>

<template>
  <!-- 独立控制台窗：顶栏 + 全屏控制台，与主页完全解耦（v1 语义） -->
  <div v-if="isConsoleWindow" class="app console-app">
    <TitleBar />
    <div class="console-full"><ConsolePanel /></div>
  </div>

  <div v-else class="app">
    <TitleBar />

    <!-- Tailwind 试点：py-2/px-4/text-sm 经 tailwind.config.ts 映射到 var(--space-2)/var(--space-4)/var(--fs-sm) -->
    <div v-if="!hasBridge" class="banner py-2 px-4 text-sm">{{ t('bridge.missing') }}</div>

    <div class="shell">
      <nav class="sidebar" :class="{ 'sidebar--collapsed': sidebarCollapsed }" :aria-label="t('nav.menu')">
        <BrandWordmark :collapsed="sidebarCollapsed" @toggle="toggleSidebar" />

        <button
          class="nav-item"
          :class="{ 'nav-item--active': view === 'launch' }"
          :aria-current="view === 'launch' ? 'page' : undefined"
          :title="t('nav.launch')"
          @click="view = 'launch'"
        >
          <!-- lucide: rocket -->
          <svg
            class="nav-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
            <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
            <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
          </svg>
          <span class="nav-label">{{ t('nav.launch') }}</span>
        </button>

        <button
          class="nav-item"
          :class="{ 'nav-item--active': view === 'instances' }"
          :aria-current="view === 'instances' ? 'page' : undefined"
          :title="t('nav.instances')"
          @click="view = 'instances'"
        >
          <!-- lucide: archive -->
          <svg
            class="nav-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect width="20" height="5" x="2" y="3" rx="2" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
          </svg>
          <span class="nav-label">{{ t('nav.instances') }}</span>
        </button>

        <button
          class="nav-item"
          :class="{ 'nav-item--active': view === 'accounts' }"
          :aria-current="view === 'accounts' ? 'page' : undefined"
          :title="t('nav.accounts')"
          @click="view = 'accounts'"
        >
          <!-- lucide: user -->
          <svg
            class="nav-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <span class="nav-label">{{ t('nav.accounts') }}</span>
        </button>

        <button
          class="nav-item"
          :class="{ 'nav-item--active': view === 'custom' }"
          :aria-current="view === 'custom' ? 'page' : undefined"
          :title="t('nav.custom')"
          @click="view = 'custom'"
        >
          <!-- lucide: package -->
          <svg
            class="nav-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
            <path d="M12 22V12" />
            <path d="m3.3 7 8.7 5 8.7-5" />
            <path d="M7.5 4.27 16.5 9.5" />
          </svg>
          <span class="nav-label">{{ t('nav.custom') }}</span>
        </button>

        <button
          class="nav-item"
          :class="{ 'nav-item--active': view === 'mods' }"
          :aria-current="view === 'mods' ? 'page' : undefined"
          :title="t('nav.mods')"
          @click="view = 'mods'"
        >
          <!-- lucide: download -->
          <svg
            class="nav-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </svg>
          <span class="nav-label">{{ t('nav.mods') }}</span>
        </button>

        <button
          class="nav-item"
          :class="{ 'nav-item--active': view === 'servers' }"
          :aria-current="view === 'servers' ? 'page' : undefined"
          :title="t('nav.servers')"
          @click="view = 'servers'"
        >
          <!-- lucide: server -->
          <svg
            class="nav-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
            <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
            <line x1="6" x2="6" y1="6" y2="6" />
            <line x1="6" x2="6" y1="18" y2="18" />
          </svg>
          <span class="nav-label">{{ t('nav.servers') }}</span>
        </button>

        <button
          class="nav-item"
          :class="{ 'nav-item--active': view === 'settings' }"
          :aria-current="view === 'settings' ? 'page' : undefined"
          :title="t('nav.settings')"
          @click="view = 'settings'"
        >
          <!-- lucide: settings -->
          <svg
            class="nav-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span class="nav-label">{{ t('nav.settings') }}</span>
        </button>

        <!-- 侧栏底部作者头像（GitHub 在线获取 + 本地缓存；未就绪时保留圆形占位）；
             点击进入设置页·关于分区（BlockHelm 同款入口，GitHub 外链收进关于页） -->
        <div class="sidebar-foot">
          <button
            class="sidebar-avatar-btn"
            :title="t('settings.nav.about')"
            @click="goSection('about'); view = 'settings'"
          >
            <img
              v-if="avatarSrc"
              class="sidebar-avatar"
              :src="avatarSrc"
              :alt="`GitHub: ${CREATOR_GITHUB}`"
            />
            <span v-else class="sidebar-avatar" aria-hidden="true"></span>
          </button>
        </div>
      </nav>

      <main class="body">
        <!-- 页面切换浮现动画（BlockHelm PageTransitionService 实测配方，用户指定）：
             240ms ease-out，淡入 + Y 轴 22px 位移，方向随导航序（前进自下、后退自上）；
             key=view 保证每次切换都重新触发入场过渡。
             切页闪两段史（2026-10-23 逐帧取证）：①默认并发下新旧两页在流中共存
             ~2 帧，双 flex:1 各被压半高 → 滚动条闪现+组件位移（浏览器 rAF 取证）；
             ②改 mode="out-in" 后旧页先撤、新页再挂 → 中间 ~2-4 帧全空白，整卡
             「消失再淡入」又是一种闪（CDP 截屏流取证，f02-f04 空白帧）。
             终态方案 = 并发挂载 + 旧页 leave 期间脱离文档流（.page-leave-active
             绝对定位，见样式注）：无挤压、无空窗，新页与旧页同帧交接。 -->
        <Transition name="page">
          <div v-if="view === 'launch'" key="launch" class="launch-stage" :style="{ '--page-dy': pageDy }">
            <AccountHero class="stage-hero" @open-accounts="view = 'accounts'" />
            <div class="stage-main"><LaunchPanel @open-instances="view = 'instances'" /></div>
          </div>
          <div v-else :key="view" class="content" :style="{ '--page-dy': pageDy }">
            <InstanceList v-if="view === 'instances'" />
            <AccountsPanel v-else-if="view === 'accounts'" />
            <CustomVersionsPanel v-else-if="view === 'custom'" />
            <ModsPanel v-else-if="view === 'mods'" />
            <ServersPanel v-else-if="view === 'servers'" />
            <SettingsPanel v-else />
          </div>
        </Transition>
      </main>
    </div>

    <!-- 崩溃呈现模态弹窗（P2 现场 + P0 上次崩溃；栈先行 + 三按钮，win32 原生框同构，AppDialog 同款形态） -->
    <CrashPanel />

    <!-- 外链打开失败全局弹窗（useExternalLink 单例状态；Mods 页与关于页共用） -->
    <ExternalLinkErrorDialog />

    <!-- 更新结果全局弹窗（useUpdateCheck 单例弹窗状态；自动=打扰门裁决后弹，手动=恒弹） -->
    <UpdateDialog />

    <!-- 首启欢迎向导（三重门自判定，见组件头注；控制台窗不挂=主页 v-else 分支内） -->
    <WelcomeWizard />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--surface-1);
  color: var(--text-primary);
}
/* Tailwind 试点：原 padding: var(--space-2) var(--space-4) 与 font-size: var(--fs-sm)
   已替换为模板上的等效工具类 py-2 px-4 text-sm（映射同一组 token）。 */
.banner {
  background: var(--warn-soft);
  color: var(--warn);
  border-bottom: 1px solid var(--border);
}
.shell {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* —— 左侧图标+文字侧栏（BlockHelm 式：字标置顶、导航行全宽、激活态 overlay 底圆角高亮、作者头像沉底） —— */
.sidebar {
  flex: 0 0 var(--sidebar-width);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4) var(--space-3);
  background: var(--surface-2);
  border-right: 1px solid var(--border);
  -webkit-app-region: no-drag;
  transition:
    flex-basis var(--dur-base) var(--ease-out),
    padding var(--dur-base) var(--ease-out);
}
/* 折叠态：收窄为图标 rail（--rail-width）。
   零离散切换（用户报"折叠/展开抖动"根因）：display:none、justify-content、
   padding 瞬跳都会在 t=0 造成位置突变，再叠加 200ms 宽度过渡 = 两段式运动。
   文字收放走 nav-label 的 max-width/opacity/margin 过渡；图标"居中"由
   padding-inline 连续过渡达成——折叠态内容列宽 = rail - 2*space-2 = 44，
   nav-item 保持 space-3 padding 时图标中心 = 8+12+10 = 30 = rail 中心，天然成立；
   头像（rail-item-size=40）居中需 padding-inline = (44-40)/2，用 calc 表达 */
.sidebar--collapsed {
  flex-basis: var(--rail-width);
  padding-inline: var(--space-2);
}
.sidebar--collapsed .nav-label {
  margin-left: 0;
  max-width: 0;
  opacity: 0;
}
.sidebar--collapsed .sidebar-foot {
  padding-inline: calc((var(--rail-width) - 2 * var(--space-2) - var(--rail-item-size)) / 2);
}
.nav-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--fs-md);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.nav-item:hover:not(:disabled) {
  background-color: var(--surface-3);
}
.nav-item--active {
  background-color: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--surface-4);
  color: var(--text-primary);
}
.nav-icon {
  flex: 0 0 var(--rail-icon-size);
  width: var(--rail-icon-size);
  height: var(--rail-icon-size);
}
.nav-label {
  /* 图标-文字间距走自身 margin（flex gap 对零宽项仍生效，不能用）；
     max-width/margin 与宽度过渡同步同时长，opacity 提前淡出避免挤压残影 */
  margin-left: var(--space-3);
  max-width: 140px;
  opacity: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    max-width var(--dur-base) var(--ease-out),
    margin-left var(--dur-base) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}
.sidebar-foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  transition: padding-inline var(--dur-base) var(--ease-out);
}
.sidebar-avatar-btn {
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
  line-height: 0; /* 消除行内基线间隙，按钮与头像严丝合缝（零抖动延续） */
  transition: box-shadow var(--dur-fast) var(--ease-out);
}
.sidebar-avatar-btn:hover {
  box-shadow: 0 0 0 2px var(--surface-4);
}
.sidebar-avatar {
  width: var(--rail-item-size);
  height: var(--rail-item-size);
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  border: 1px solid var(--surface-4);
  object-fit: cover; /* img 态：头像裁正方形铺满圆 */
  display: block;
}
/* 主区裁剪：入场过渡的 translateY(+22px) 会短暂超出下缘，若不裁剪会泄漏成
   视口 scrollable overflow——切换瞬间闪出滚动条（浏览器实测：html 溢出 32px 随动衰减）。
   位移是装饰性溢出，理应 clip 在主区内（BlockHelm WPF 容器同为 ClipToBounds）。 */
.body {
  position: relative; /* 旧页 leave 脱离流后的包含块（.page-leave-active） */
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* —— 页面切换浮现（BlockHelm PageTransitionService 实测配方，用户指定）：仅入场过渡——
   新页淡入 + translateY(±22px→0)，240ms（--dur-page）ease-out；位移方向由 --page-dy
   注入（前进 +22 自下、后退 -22 自上）。只动 transform/opacity。
   "切换闪一下"真因（2026-10-23 浏览器 rAF 逐帧取证）：Transition 默认并发模式下
   新旧两页在流中共存 ~2 帧（leave 无动画也要等 nextFrame），双 flex:1 各被压成
   半高 → 新页内部滚动容器瞬时溢出闪出滚动条、组件位移，旧页撤除后回弹——
   三壳（Tauri/Electron/浏览器）皆可复现。修复 = <Transition mode="out-in">
   （见模板注），与合成层/窗底色无关（早先"WebView2 白闪"诊断为误判，已撤销）。
   二段修复（用户复报卡片右缘仍闪，CDP 真窗取证）：模组页数据到达时 .detail
   溢出从零变正，10px 经典滚动条出现致整列 440→430 reflow——修复见 base.css
   滚动条节的 .menu/.detail scrollbar-gutter: stable（槽位常留、零 reflow）。
   过渡元素垫不透明底色（.launch-stage/.content）保留：淡入期间背景不穿透，无害。—— */
.page-enter-active {
  transition:
    opacity var(--dur-page) var(--ease-out),
    transform var(--dur-page) var(--ease-out);
}
.page-enter-from {
  opacity: 0;
  transform: translateY(var(--page-dy, 22px));
}
/* 旧页交接帧：leave 无动画（配方「即刻替换」），但 DOM 移除要等 ~2 帧 nextFrame。
   并发改 key 时若旧页仍在流中 = 双 flex:1 挤压闪；out-in 先撤后挂 = 空白窗闪
   （两段史见模板注）。绝对定位让旧页原地脱流叠在包含块 .body 上：尺寸不变、
   不占流，新页同帧挂载淡入，交接零空窗。
   选择器须带 .body 前缀提权（CDP 截屏流取证：裸 .page-leave-active 与
   .launch-stage 同特异度且在前，被其 position: relative 覆盖 → 离开启动页时
   旧页未脱流、dock 被压到半高中部 = 用户所见「整个 card 在闪」）。 */
.body .page-leave-active {
  position: absolute;
  inset: 0;
}
@media (prefers-reduced-motion: reduce) {
  .page-enter-active {
    transition: none;
  }
}
/* —— 内容页容器（BlockHelm/图2 骨架，用户指定）：铺满主区，不整块居中——
   整块居中会把左菜单从侧栏旁拽走（"还是居中"根因）。行级排版归各页组件：
   左菜单贴左（SecondaryMenuFrame），详情列在剩余空间内浮中（DetailPageContentMaxWidth）。 —— */
.content {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  /* 淡入期间背景不穿透（见 .page-enter-active 注） */
  background: var(--surface-1);
}
/* —— 启动舞台：hero 左上角标式浮层，启动面板铺满，版本列表面板锚定左下 —— */
.launch-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: var(--space-5);
  /* 启动舞台背景（用户定稿 2026-10-31：仅配置背景图时启用，无内置默认图）：
     遮罩/图两变量由 useSettings 在图可用时成对写入（缺省 = none 回落纯色底）；
     末层 surface-1 色垫 = 淡入期间背景不穿透（原注释语义保留）。
     LaunchPanel .panel 透明即为此画布设计。 */
  background:
    var(--app-bg-overlay, none),
    var(--app-bg-image, none) center / cover no-repeat,
    var(--surface-1);
}
/* 背景图启用态 = 固定暗上下文（图 + 暗遮罩）：舞台浮空元素文字 token 局部重映射为
   暗主题亮值，否则浅色主题深字压暗图不可读（2026-10-31 用户实机报障）；
   无图时选择器不命中，全部回落主题值（浅底深字）。底部不透明卡片不在本子树，不受影响 */
html[data-bg-image] .stage-hero {
  --text-primary: #e8e4dc;
  --text-secondary: #a8a296;
}
.stage-hero {
  position: absolute;
  top: var(--space-5);
  left: var(--space-5);
  z-index: 5;
}
.stage-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-top: 96px; /* 给左上 AccountHero 让位 */
}
/* 版本 dock 已迁入 LaunchPanel 动作行（窄窗下与实例 dock 同 flex 流互斥，
   不再绝对定位压盖实例 dock——遮挡 bug 的根因即两套布局互不感知） */
/* —— 独立控制台窗：全屏控制台 —— */
.console-app {
  height: 100vh;
}
.console-full {
  flex: 1;
  min-height: 0;
  padding: var(--space-4);
}
</style>
