<script setup lang="ts">
/**
 * 游戏崩溃弹窗（2026-11-07）：GAME_EXIT 带 crash 即弹，与控制台窗开闭无关
 * （主窗全局挂载，状态源 useGameCrash 单例）。内容 = 分类标题 + 死因 headline +
 * Java 堆栈全文（签名命中才有；规则命中/退出码兜底只显 headline）+ 解决方案提示。
 * 提示纪律 = **有确定解才写**，无提示类别整段隐藏（不放「无」占位）：
 * tim-sort 全版本通用一条；stack-overflow 仅钉 a1.2.3（树叶枯萎官方缺陷，见
 * minecraft-alpha-leaf-decay-analysis.md——守卫被通知链归零 → 进树区 100% SOE，
 * JVM 参数无法规避，出路只有换版本）；null-pointer 多因不同解，刻意不写。
 */
import { computed } from 'vue';
import type { GameExitEvent } from '@attic/core-spec';
import { useI18n } from '../i18n';
import { useGameCrash } from '../composables/useGameCrash';
import AppDialog from './AppDialog.vue';

const { t } = useI18n();
const { crash, dismiss } = useGameCrash();

function resolveHintKey(e: GameExitEvent | null): string | null {
  const crashInfo = e?.crash;
  if (!crashInfo) return null;
  // 指纹优先（runtime 消息指纹表命中即挂 fingerprint，唯一性有源码案卷背书）。
  if (crashInfo.fingerprint) return `crashHint.${crashInfo.fingerprint}`;
  if (crashInfo.category === 'tim-sort') return 'crashHint.tim-sort';
  if (crashInfo.category === 'stack-overflow' && e?.versionId === 'a1.2.3') return 'crashHint.stack-overflow-a123';
  return null;
}

const hintKey = computed(() => resolveHintKey(crash.value));
</script>

<template>
  <AppDialog :open="crash !== null" :z-index="200" @close="dismiss">
    <template v-if="crash?.crash">
      <header class="head">
        <h3 class="title">{{ t('gameCrash.title') }}</h3>
        <span class="cat">{{ t(`crash.${crash.crash.category}`) }}</span>
      </header>
      <p class="headline mono">{{ crash.crash.headline }}</p>
      <pre v-if="crash.crash.stack" class="stack mono">{{ crash.crash.stack }}</pre>
      <section v-if="hintKey" class="hint">
        <h4 class="hint-label">{{ t('gameCrash.hint') }}</h4>
        <p class="hint-text">{{ t(hintKey) }}</p>
      </section>
      <footer class="foot">
        <button class="ghost" type="button" @click="dismiss">{{ t('gameCrash.close') }}</button>
      </footer>
    </template>
  </AppDialog>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 700;
  color: var(--danger);
}
.cat {
  padding: 2px var(--space-3);
  background: var(--danger-soft);
  border-radius: var(--radius-pill);
  color: var(--danger);
  font-size: var(--fs-sm);
  font-weight: 600;
  white-space: nowrap;
}
.headline {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.stack {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  max-height: 38vh;
  overflow: auto;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.hint {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.hint-label {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 700;
  color: var(--text-primary);
}
.hint-text {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.6;
  /* 文案内 \n = 原因/方法分段（三语 crashHint 统一在解法句前换行） */
  white-space: pre-line;
}
.foot {
  display: flex;
  justify-content: flex-end;
}
.ghost {
  padding: var(--space-2) var(--space-5);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-md);
  cursor: pointer;
  box-shadow: var(--inset-bottom);
  transition: background var(--dur-fast) var(--ease-out);
}
.ghost:hover {
  background: var(--surface-4);
}
</style>
