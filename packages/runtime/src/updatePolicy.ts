/**
 * 更新打扰门（纯函数，零 Node 依赖）。
 * 本模块独立于 updateCheck.ts：updateCheck.ts 的 `import type { FetchImpl } from './betacraft'`
 * 会把 betacraft 的 node: 依赖面带进类型图，UI 经 vite alias 直消费源码时
 * vue-tsc（无 @types/node）必炸；与 updateCheck 数据面同目录同纪律，
 * runtime 测试面经 dist/index.js 覆盖。
 * 语义：
 * - policy='off' → 恒 false（start 侧本就不发自动检查，此为双保险）；
 * - status='update' ∧ version ≠ 忽略账 → true（弹更新弹窗 + 红点）；
 * - 命中忽略账或其余分支（upToDate/unconfigured/error）→ false 全静默。
 * 手动检查（关于页按钮入口）不走本门——无视策略与忽略账，恒显结果弹窗。
 */

import type { UpdateCheckResult, UpdatePolicy } from '@attic/core-spec';

export function shouldPromptUpdate(
  result: UpdateCheckResult,
  ignoreVersion: string | undefined,
  policy: UpdatePolicy,
): boolean {
  if (policy === 'off') return false;
  return result.status === 'update' && result.version !== ignoreVersion;
}
