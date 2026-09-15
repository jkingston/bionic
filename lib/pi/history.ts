import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Json } from '../contracts.ts';
import type { RunRecord, RunsRequest, RunQuery } from '../runs.ts';

export function safeText(text: string) {
  return text.replace(
    /[^\x20-\x7e\n]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
export function runSummary(run: RunRecord) {
  return (
    `${run.status.toUpperCase()} ${run.path} @${run.ref.revision} · ${run.durationMs === undefined ? 'in progress' : `${run.durationMs} ms`}\n` +
    `${run.callCount} calls · ${run.childCount} child runs · output ${run.outputInfo.state} (${run.outputInfo.bytes} bytes)\n` +
    `Started ${run.startedAt}\nRun ${run.runId}` +
    (run.error ? `\n${run.error.code}: ${run.error.message}` : '')
  );
}
export function historySummary(value: any) {
  if (value?.runId && value?.inputInfo) {
    return runSummary(value);
  }
  if (Array.isArray(value?.items)) {
    return (
      value.items
        .map(
          (run: RunRecord) =>
            `${run.startedAt}  ${run.status}  ${run.path} @${run.ref.revision}\n  ${run.runId}`,
        )
        .join('\n') || 'No matching runs.'
    );
  }
  return JSON.stringify(value, null, 2);
}
type Query = (request: RunsRequest) => Promise<Json>;
export async function browseRuns(ctx: ExtensionContext, query: Query, filter: RunQuery = {}) {
  let cursor: string | undefined;
  while (true) {
    const page = (await query({ action: 'list', ...filter, limit: 10, cursor })) as any;
    if (!ctx.hasUI) {
      ctx.ui.notify(safeText(historySummary(page)), 'info');
      return;
    }
    const rows: string[] = page.items.map((r: RunRecord) =>
      safeText(`${r.startedAt}  ${r.status}  ${r.path} @${r.ref.revision}  ${r.runId}`),
    );
    const choice = await ctx.ui.select('Run history', [
      ...rows,
      ...(page.nextCursor ? ['Next page'] : []),
      'Refresh',
      'Back',
    ]);
    if (!choice || choice === 'Back') {
      return;
    }
    if (choice === 'Next page') {
      cursor = page.nextCursor;
      continue;
    }
    if (choice === 'Refresh') {
      cursor = undefined;
      continue;
    }
    const run = page.items[rows.indexOf(choice)];
    if (run) {
      await inspectRun(ctx, query, run.runId);
    }
  }
}
export async function inspectRun(ctx: ExtensionContext, query: Query, runId: string) {
  while (true) {
    const run = (await query({ action: 'get', runId })) as any;
    ctx.ui.notify(safeText(runSummary(run)), 'info');
    if (!ctx.hasUI) {
      return;
    }
    const choice = await ctx.ui.select('Inspect run', [
      'Output',
      'Input',
      'Calls',
      'Children',
      'Refresh',
      'Back',
    ]);
    if (!choice || choice === 'Back') {
      return;
    }
    try {
      if (choice === 'Output' || choice === 'Input') {
        const pointer = await ctx.ui.input(
          'JSON Pointer (empty for full value)',
          '/optional/field',
        );
        if (pointer === undefined) {
          continue;
        }
        const value = await query({
          action: choice === 'Output' ? 'output' : 'input',
          runId,
          pointer,
        });
        ctx.ui.notify(safeText(JSON.stringify(value, null, 2)), 'info');
      } else if (choice === 'Children') {
        await browseRuns(ctx, query, { parentRunId: runId, kind: 'all' });
      } else if (choice === 'Calls') {
        let detail = run;
        while (true) {
          ctx.ui.notify(safeText(JSON.stringify(detail.calls, null, 2)), 'info');
          if (
            !detail.calls.nextCursor ||
            (await ctx.ui.select('Call history', ['Next page', 'Back'])) !== 'Next page'
          ) {
            break;
          }
          detail = await query({ action: 'get', runId, cursor: detail.calls.nextCursor });
        }
      }
    } catch (e) {
      ctx.ui.notify(safeText(String(e)), 'error');
    }
  }
}
