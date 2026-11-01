/**
 * i18n —— 手写深合并（零依赖）。
 * en 为 base/fallback，zh-CN/zh-TW 覆盖同名键；settings.language 缺席时做
 * **一次性**系统语言侦测（zh-TW/HK/MO → 繁體中文，其余 zh* → 简体中文，其他 → English），
 * 结果由 useSettings 写回 settings.language 落盘、本层同步落 localStorage 缓存——此后不再自动改。
 * t(key) 走点路径；缺键回落 en，仍缺则原样返回路径。
 * 词典为 JSON 文件（locales/*.json，翻译贡献者零工具链直接 PR）；
 * 外挂语言包通道（launcher/lang/<locale>.json 运行期覆盖层）与仓内词典同形同校验。
 */

import { ref, computed, type Ref } from 'vue';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';

export type Locale = 'en' | 'zh-CN' | 'zh-TW';

/** 可选界面语言（自名形态，不随 locale 翻译）；语言栏下拉的唯一数据源。 */
export const AVAILABLE_LOCALES: { code: Locale; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
];

const LOCALE_KEY = 'attic.locale';

type Dict = Record<string, unknown>;

/** 深合并：override 的同名叶子覆盖 base，对象递归合并。 */
function deepMerge(base: Dict, override: Dict): Dict {
  const out: Dict = { ...base };
  for (const key of Object.keys(override)) {
    const b = out[key];
    const o = override[key];
    if (isDict(b) && isDict(o)) {
      out[key] = deepMerge(b, o);
    } else {
      out[key] = o;
    }
  }
  return out;
}

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const dicts: Record<Locale, Dict> = {
  en,
  'zh-CN': deepMerge(en, zhCN),
  'zh-TW': deepMerge(en, zhTW),
};

/** 系统语言侦测（webview 的 navigator.language 跟随 OS locale）：
 *  zh-TW/zh-HK/zh-MO（含 -Hant 变体）→ 繁體中文；其余 zh* → 简体中文；其他 → English。 */
function detectSystemLocale(): Locale {
  const nav = typeof navigator !== 'undefined' ? navigator.language ?? 'en' : 'en';
  if (/^zh-(TW|HK|MO)/i.test(nav) || /zh.*Hant/i.test(nav)) return 'zh-TW';
  if (/^zh/i.test(nav)) return 'zh-CN';
  return 'en';
}

function readStoredLocale(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    if (v === 'en' || v === 'zh-CN' || v === 'zh-TW') return v;
    // 侦测同样落缓存 = 只发生一次（settings.language 缺席时 useSettings 会再把结果写回落盘）
    const detected = detectSystemLocale();
    localStorage.setItem(LOCALE_KEY, detected);
    return detected;
  } catch {
    /* 浏览器隐私模式可能禁 storage，每次回落侦测 */
    return detectSystemLocale();
  }
}

/** 当前 locale（响应式；useSettings 缺省侦测回写用）。 */
export const locale: Ref<Locale> = ref(readStoredLocale());

const activeDict = computed<Dict>(() => dicts[locale.value]);

/** 点路径取值。 */
function lookup(dict: Dict, path: string): string | undefined {
  let cur: unknown = dict;
  for (const seg of path.split('.')) {
    if (isDict(cur) && seg in cur) {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** 翻译：当前 locale → 回落 en → 原样路径；支持 {name} 插值。 */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = lookup(activeDict.value, key) ?? lookup(en, key) ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

export function setLocale(next: Locale): void {
  locale.value = next;
  try {
    localStorage.setItem(LOCALE_KEY, next);
  } catch {
    /* 忽略持久化失败 */
  }
}

/** 组合式入口。 */
export function useI18n() {
  return { t, locale, setLocale };
}
