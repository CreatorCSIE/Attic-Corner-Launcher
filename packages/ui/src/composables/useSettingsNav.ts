/**
 * useSettingsNav —— 设置页分区导航状态（模块级单例）。
 * 存在的全部理由：侧栏头像（App.vue）要跨组件把「跳到关于分区」的意图传进 SettingsPanel，
 * 除此之外无处需要它；页面切换（view）仍归 App.vue 自己管。
 */

import { ref, type Ref } from 'vue';

export type SettingsSection =
  | 'general'
  | 'language'
  | 'launch'
  | 'java'
  | 'theme'
  | 'about'
  | 'developer';

const activeSection: Ref<SettingsSection> = ref('general');

/** 请求跳转分区（App.vue 头像跨组件直用；SettingsPanel 读同一 activeSection 即切）。 */
export function goSection(section: SettingsSection): void {
  activeSection.value = section;
}

export function useSettingsNav() {
  return { activeSection, goSection };
}
