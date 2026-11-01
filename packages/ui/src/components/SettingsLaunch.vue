<script setup lang="ts">
/**
 * 设置页 · 启动与内存栏：
 * 启动行为开关（完整性复核/缺失补全联动、启动后最小化、服务器地址收编 levelServer）+
 * 内存（auto/manual + 滑杆 + 系统内存摘要）+ 全局 JVM 参数。
 * 明示不提供：全屏启动（老游戏不认启动参数）、pre/post 命令（价值低）。
 */
import { computed } from 'vue';
import { useI18n } from '../i18n';
import { useSettings } from '../composables/useSettings';
import { useSysInfo } from '../composables/useSysInfo';
import { useDebouncedField } from '../composables/useDebouncedField';
import SettingToggle from './SettingToggle.vue';
import AppSelect from './AppSelect.vue';

const { t } = useI18n();
const { settings, patch } = useSettings();
const { info } = useSysInfo();

const checkIntegrity = computed(() => settings.value.checkIntegrity ?? true);
const fixMissing = computed(() => settings.value.fixMissing ?? true);
const minimize = computed(() => settings.value.minimizeOnLaunch ?? false);
const consoleOnLaunch = computed(() => settings.value.consoleOnLaunch ?? true);

const memoryMode = computed(() => settings.value.memoryMode ?? 'manual');

const totalMemMb = computed(() => info.value?.totalMemMb ?? 0);

/** 滑杆上限：min(总-2GB, 75%总)，取 128 对齐；无宿主数据回退 8192 */
const sliderMax = computed(() => {
  if (totalMemMb.value <= 0) return 8192;
  const cap = Math.min(totalMemMb.value - 2048, Math.floor((totalMemMb.value * 3) / 4));
  return Math.max(Math.floor(cap / 128) * 128, 512);
});

/** auto 模式显示估算值——与宿主 estimateMaxMemoryMb 同一公式（数字改动须双侧同步）。 */
const estimatedMb = computed(() => {
  const total = totalMemMb.value;
  if (!(total > 0)) return 1024;
  const want = Math.round((total * 0.4) / 128) * 128;
  return Math.min(Math.max(want, 512), 2048);
});

const memLocal = useDebouncedField(
  () => settings.value.maxMemoryMb ?? 1024,
  (v) => void patch({ maxMemoryMb: v }),
);
const serverLocal = useDebouncedField(
  () => settings.value.levelServer ?? '',
  (v) => void patch({ levelServer: v.trim() || undefined }),
);
const jvmLocal = useDebouncedField(
  () => settings.value.jvmArgs ?? '',
  (v) => void patch({ jvmArgs: v.trim() || undefined }),
);

function setMemoryMode(mode: 'auto' | 'manual'): void {
  void patch({ memoryMode: mode });
}
</script>

<template>
  <section class="pane">
    <h3 class="pane-title">{{ t('settings.sectionLaunch') }}</h3>

    <!-- 启动行为 -->
    <div class="card">
      <SettingToggle
        :model-value="checkIntegrity"
        :label="t('settings.launch.integrity')"
        :desc="t('settings.launch.integrityDesc')"
        @update:model-value="patch({ checkIntegrity: $event })"
      />
      <SettingToggle
        :model-value="fixMissing"
        :desc="t('settings.launch.fixMissingDesc')"
        :label="t('settings.launch.fixMissing')"
        :disabled="!checkIntegrity"
        @update:model-value="patch({ fixMissing: $event })"
      />
      <SettingToggle
        :model-value="minimize"
        :label="t('settings.launch.minimize')"
        :desc="t('settings.launch.minimizeDesc')"
        @update:model-value="patch({ minimizeOnLaunch: $event })"
      />
      <SettingToggle
        :model-value="consoleOnLaunch"
        :label="t('settings.launch.consoleOnLaunch')"
        :desc="t('settings.launch.consoleOnLaunchDesc')"
        @update:model-value="patch({ consoleOnLaunch: $event })"
      />
      <div class="field">
        <label class="label" for="server">{{ t('settings.launch.server') }}</label>
        <input
          id="server"
          v-model="serverLocal.local.value"
          class="input mono"
          type="text"
          :placeholder="t('settings.launch.serverPlaceholder')"
        />
        <span v-if="serverLocal.savedFlash.value" class="saved-flash">{{ t('settings.saved') }}</span>
        <p class="desc">{{ t('settings.launch.serverDesc') }}</p>
      </div>
    </div>

    <!-- 内存 -->
    <div class="card">
      <div class="field">
        <label class="label" for="memmode">{{ t('settings.launch.memory') }}</label>
        <AppSelect
          id="memmode"
          :model-value="memoryMode"
          :options="[
            { value: 'manual', label: t('settings.launch.memoryManual') },
            { value: 'auto', label: t('settings.launch.memoryAuto') },
          ]"
          @update:model-value="setMemoryMode($event as 'auto' | 'manual')"
        />
      </div>

      <div v-if="memoryMode === 'manual'" class="field">
        <div class="slider-head">
          <span class="label">{{ t('settings.launch.memoryMax') }}</span>
          <span class="mem-value tabular">{{ memLocal.local.value }} MB</span>
        </div>
        <input
          v-model.number="memLocal.local.value"
          class="slider"
          type="range"
          min="256"
          :max="sliderMax"
          step="128"
        />
        <p class="desc">{{ t('settings.launch.sysMem', { total: totalMemMb, free: info?.freeMemMb ?? 0 }) }}</p>
      </div>
      <p v-else class="desc">{{ t('settings.launch.memoryAutoEst', { mb: estimatedMb }) }}</p>
    </div>

    <!-- 全局 JVM 参数 -->
    <div class="card">
      <div class="field">
        <label class="label" for="jvm">{{ t('settings.launch.jvmGlobal') }}</label>
        <input
          id="jvm"
          v-model="jvmLocal.local.value"
          class="input mono"
          type="text"
          :placeholder="t('settings.launch.jvmGlobalPlaceholder')"
        />
        <span v-if="jvmLocal.savedFlash.value" class="saved-flash">{{ t('settings.saved') }}</span>
        <p class="desc">{{ t('settings.launch.jvmGlobalDesc') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.pane-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-5);
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.field {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
/* 即改即存回执徽标（label 行右侧绝对定位零抖动） */
.saved-flash {
  position: absolute;
  top: 0;
  right: 0;
  font-size: var(--fs-xs);
  color: var(--ok);
  animation: saved-in var(--dur-fast) var(--ease-out);
}
@keyframes saved-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.label {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.desc {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.input {
  padding: var(--space-3) var(--space-4);
  background: var(--surface-3);
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  box-shadow: var(--input-inset);
}
.input:focus-visible {
  outline: none;
  box-shadow: var(--input-focus-shadow);
}
.mono {
  font-family: var(--font-mono);
}
.tabular {
  font-variant-numeric: tabular-nums;
}
.slider-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.mem-value {
  color: var(--accent);
  font-weight: 600;
}
/* 内存滑杆：accent 进度段 + 圆形 thumb（零依赖实现） */
.slider {
  appearance: none;
  width: 100%;
  height: 6px;
  background: var(--surface-1);
  border-radius: var(--radius-pill);
  box-shadow: var(--input-inset);
  cursor: pointer;
}
.slider::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid var(--surface-1);
  box-shadow: 0 1px 3px rgb(0 0 0 / 30%);
}
</style>
