import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HubServer } from '../../src/hub/server.js';
import { hashSecret } from '../../src/hub/auth.js';
import { attachGateway } from '../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../src/core/runtime.js';
import { selectConversation, waitForClientOnline } from './fixtures/mobile.js';
import { colorPalettes } from '../src/palettes.js';
import { measureContrast, type ContrastTarget } from './fixtures/widget-contrast.js';

// Every palette x saved theme x device preference: text written with the App's
// theme variables and built-in classes stays readable inside the widget frame.
test.use({ serviceWorkers: 'block' });
async function fixture(page: Page, html: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-contrast-')), stateDir = path.join(root, 'bot'); await mkdir(stateDir);
  const hub = await HubServer.start({ stateDir: path.join(root, 'hub'), clientDir: path.resolve('dist') });
  const secret = randomBytes(32).toString('base64url'); await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', ['alpha', '可视化助手', hashSecret(secret)]);
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine: 'codex', locale: 'zh' }));
  const widget = { title: '对比度检查', summary: '示例数据：检查组件文字与底色的对比度。', html };
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace('http', 'ws') + '/instance', secret, botId: 'alpha', engine: 'codex', model: 'fixture', effort: 'high', runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async input => {
    await input.appPlatformTools!.call({ name: 'app_show_widget', arguments: widget, sessionId: 'fixture', callId: 'visual', abortSignal: input.abortSignal! }); return { text: '见组件。' };
  } } });
  const conv = await hub.store.createConversation('owner', ['alpha'], '对比度', 'contrast_chat');
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click(); await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner'); await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await waitForClientOnline(page); await selectConversation(page, conv.title);
  await page.getByLabel('消息', { exact: true }).fill('比较一下'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  return { dispose: async () => { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
const guest = (page: Page): FrameLocator => page.frameLocator('.widget-panel:visible > iframe').frameLocator('iframe');
// Mirrors appearance.ts: the CLI palette is dark-only whatever the saved theme.
async function appearance(page: Page, palette: string, theme: string, device: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: device });
  await page.evaluate(({ palette, theme }) => Object.assign(document.documentElement.dataset, { palette, theme: palette === 'cli' ? 'dark' : theme }), { palette, theme });
  const expected = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.inline-widget')!), expand = (v: string) => /^#[0-9a-f]{3}$/i.test(v) ? '#' + [...v.slice(1)].map(x => x + x).join('') : v;
    return { surface: expand(style.getPropertyValue('--raised').trim()), scheme: style.colorScheme === 'dark' ? 'dark' : 'light' };
  });
  await expect.poll(() => guest(page).locator('html').evaluate(node => ({ surface: (node as HTMLElement).style.getPropertyValue('--surface').trim(), scheme: (node as HTMLElement).style.colorScheme }))).toEqual(expected);
  return expected.scheme;
}
const minimum = { text: 4.5, large: 3, graphic: 3 };
const combinations = colorPalettes.flatMap(({ id }) => ['light', 'dark', 'system'].flatMap(theme => (['light', 'dark'] as const).map(device => ({ palette: id, theme, device }))));

const themed = `<style>
.custom{padding:10px;border-radius:8px;background:light-dark(#eef2ff,#1e293b);color:light-dark(#1e293b,#e2e8f0)}
.media{padding:10px;border-radius:8px;background:rgba(59,130,246,.12);color:#1e293b}.media small{color:#475569}
@media (prefers-color-scheme: dark){.media{color:#e2e8f0}.media small{color:#94a3b8}}
</style><section>
<p id="body">结论正文</p><p id="muted" class="muted">范围与单位</p>
<div class="grid"><div class="card"><div id="card-muted" class="muted">指标名称</div><div id="metric" class="metric">53.8 万</div><span id="badge" class="badge">46%</span><p id="card-body">卡片说明</p></div></div>
<div class="tabs"><button id="tab-on" aria-pressed="true">概览</button><button id="tab-off" aria-pressed="false">明细</button></div>
<div class="row"><button id="primary" class="primary">应用</button><button id="button">重置</button></div>
<table><thead><tr><th id="th">类别</th><th>数量</th></tr></thead><tbody><tr><td id="td">源码</td><td>537,749</td></tr></tbody></table>
<svg viewBox="0 0 320 70" width="320" height="70" role="img" aria-label="系列"><text id="svg-text" x="4" y="16" fill="var(--text)">标签</text><g style="color:var(--muted)"><text id="svg-current" x="4" y="40" fill="currentColor">次要标签</text></g>
<rect id="series-1" x="170" y="4" width="120" height="12" fill="var(--chart-series-1)"/><rect id="series-2" x="170" y="20" width="90" height="12" fill="var(--chart-series-2)"/><rect id="series-3" x="170" y="36" width="60" height="12" fill="var(--chart-series-3)"/><rect id="series-4" x="170" y="52" width="30" height="12" fill="var(--chart-series-4)"/></svg>
<div class="custom"><span id="light-dark">自定义 light-dark() 颜色</span></div>
<div class="media"><small id="media-label">自定义深色媒体查询</small><div id="media-value" style="font-size:1.4rem;font-weight:650">26.7 万</div></div>
</section>`;
const themedTargets: ContrastTarget[] = [
  ...['body', 'muted', 'card-muted', 'badge', 'card-body', 'tab-on', 'tab-off', 'primary', 'button', 'th', 'td', 'svg-text', 'svg-current', 'light-dark', 'media-label'].map(id => ({ id, kind: 'text' as const })),
  { id: 'metric', kind: 'large' }, { id: 'media-value', kind: 'large' },
  ...[1, 2, 3, 4].map(i => ({ id: `series-${i}`, kind: 'graphic' as const })),
];

test('theme variables, built-in classes and scheme-aware custom colours stay readable in every palette and mode', async ({ page }) => {
  test.setTimeout(300_000);
  const f = await fixture(page, themed);
  try {
    await expect(guest(page).locator('#body')).toBeVisible();
    const failures: string[] = [];
    for (const { palette, theme, device } of combinations) {
      const scheme = await appearance(page, palette, theme, device);
      // Authored prefers-color-scheme follows the App, not the device preference.
      expect(await guest(page).locator('#media-label').evaluate(node => getComputedStyle(node).color), `${palette}/${theme}/${device}`).toBe(scheme === 'dark' ? 'rgb(148, 163, 184)' : 'rgb(71, 85, 105)');
      for (const result of await guest(page).locator('#report-root').evaluate(measureContrast, themedTargets))
        if (result.ratio < minimum[result.kind]) failures.push(`${palette}/${theme}/device-${device} ${result.id} ${result.fg} on ${result.bg} = ${result.ratio}`);
    }
    expect(failures).toEqual([]);
  } finally { await f.dispose(); }
});
