/**
 * Rendering one sync round for a human: startup log line and `/model-catalog`.
 *
 * A plugin whose whole value proposition is "you can fix it yourself" has to
 * say what it actually did. Every round carries the same account, so a silent
 * no-op and a broken contract look different at a glance.
 *
 * @module dsh-live-model-catalog/report
 */
import { SNAPSHOT_BOUND } from './constants.js';

const STATUS_LABEL = {
  written: '已写入',
  unchanged: '无变化',
  skipped: '已跳过',
  failed: '失败',
  conflict: '写入冲突',
  unavailable: '不可用',
};

/** One route's line in the report. */
function routeLines(entry) {
  const label = STATUS_LABEL[entry.status] ?? entry.status;
  const degraded = entry.degraded === true ? '（新增被拒，已保住补齐）' : '';
  const source = entry.endpointSource === undefined ? '' : `［端点: ${entry.endpointSource}］`;
  const notAdvertised = entry.notAdvertised ?? [];
  const aliases = entry.aliases ?? [];
  const lines = [
    `- ${entry.route}${source}：${label}${degraded}${entry.detail === undefined ? '' : `（${entry.detail}）`}`,
  ];
  if (entry.liveCount !== undefined) {
    const refused = entry.refused === undefined || entry.refused.length === 0 ? '' : `（被拒 ${entry.refused.length}）`;
    const needsProtocol = entry.needsProtocol === undefined || entry.needsProtocol.length === 0 ? '' : `；需声明协议 ${entry.needsProtocol.length}`;
    const aliasCount = aliases.length === 0 ? '' : `；跳过别名 ${aliases.length}`;
    lines.push(
      `    线上 ${entry.liveCount} 个模型；新增 ${entry.added.length}${refused}；补齐 ${entry.filled.length}；` +
        `未列出 ${notAdvertised.length}；白名单外 ${entry.skipped ?? 0}` +
        `${entry.tooOld === undefined ? '' : `；早于 addSince ${entry.tooOld}`}${aliasCount}${needsProtocol}`,
    );
  }
  for (const id of entry.added) lines.push(`    + ${id}`);
  for (const id of entry.refused ?? []) lines.push(`    ✗ ${id}（新增被拒，未被写入）`);
  // The per-fill notes are the translation's own account ("no effort list
  // published; preset applied", "unsupported effort \"ultra\" ignored"), which is
  // the only way a reader learns an endpoint moved rather than that a level
  // quietly vanished. Indented under the fill they belong to.
  for (const item of entry.filled) {
    lines.push(`    ~ ${item.id} → ${item.fields.join(', ')}`);
    for (const note of item.notes ?? []) lines.push(`      ! ${note}`);
  }
  if (entry.protocolNote !== undefined) lines.push(`    * ${entry.protocolNote}`);
  if (entry.needsProtocol !== undefined && entry.needsProtocol.length > 0) {
    lines.push(`    ! 需声明协议：${entry.needsProtocol.join('、')} —— ${entry.protocolAdvice ?? ''}`.trimEnd());
  }
  if (aliases.length > 0) {
    lines.push(`    ! 端点的移动别名（未写入配置，可在 skipAliases: false 下照收）：${aliases.join('、')}`);
  }
  // Named, not counted: an id the endpoint dropped is the one bucket the reader
  // can act on (delete it, or exclude the route), so a number is not enough.
  if (notAdvertised.length > 0) {
    lines.push(`    ! 端点已不再列出（保留未删除）：${notAdvertised.join('、')}`);
  }
  for (const note of entry.notes ?? []) lines.push(`    ! ${note}`);
  return lines.join('\n');
}

/**
 * How the add gate reads in the header.
 * @param addSince - the configured bound.
 * @returns the parenthetical, or an empty string when there is no bound.
 */
function sinceLabel(addSince) {
  if (!addSince) return '';
  if (addSince === SNAPSHOT_BOUND) return '（仅新增 pi-ai 快照之后发布）';
  return `（仅新增 ${addSince} 之后发布）`;
}

/**
 * Render a sync report as plain text.
 * @param report - the round report assembled by the plugin.
 * @returns the text shown in the command result and startup log.
 */
export function renderReport(report) {
  const lines = [`live-model-catalog —— 触发：${report.trigger}`];
  lines.push(
    `白名单：${report.config.include.length > 0 ? report.config.include.join(', ') : '（空，仅补齐不新增）'}` +
      `${sinceLabel(report.config.addSince)}` +
      `　补齐字段：${report.config.fill.join(', ') || '（无）'}` +
      `　修按钮：${report.config.fixDiscovery ? '开' : '关'}`,
  );

  if (report.endpoints !== undefined) lines.push(`内置端点：${report.endpoints}`);
  if (report.routes.length === 0) {
    lines.push('没有可管理的 llm-pi-ai 路由（auto 模式下应有；检查 exclude 与 llm-pi-ai.providers）。');
  }
  for (const entry of report.routes) lines.push(routeLines(entry));

  if (report.discovery !== undefined) {
    // The scope is named because it answers the one question a broken button
    // raises: 0 means the plugin owns no route at all, and a number below what
    // the Models page shows means pi-ai could not be located for the rest.
    const scope = report.discovery.scope === undefined ? '' : `（接管 ${report.discovery.scope} 条路由）`;
    lines.push(`发现按钮：${report.discovery.status}${scope}${report.discovery.detail === undefined ? '' : ` — ${report.discovery.detail}`}`);
  }
  return lines.join('\n');
}
