import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conversationSchema } from '../client-protocol/index.js';
import { CONVERSATION_BATCH_CAPABILITY, CONVERSATION_RESTORE_CAPABILITY, conversationBatchSchema, conversationBatchResultSchema } from '../client-protocol/conversation-batch.js';
import { createBotSchema } from '../client-protocol/bots.js';
import { hostResourcesSchema } from '../client-protocol/host-resources.js';
import { selectBalancedHost, type HostBalanceCandidate } from '../client-protocol/host-balancer.js';
import { HostCliError, type LocalHostClient } from './client.js';

export async function runConversationsCommand(client: Pick<LocalHostClient, 'request' | 'ready'>, action: string | undefined,
  flags: { ids?: string; yes?: boolean; folder?: string; unfiled?: boolean; newFolder?: string; revision?: string; requestId?: string; host?: string; engine?: string; model?: string; title?: string; workspace?: string; bot?: string },
  announce: (requestId: string) => void = () => undefined) {
  if (action === 'local') {
    if (Object.values(flags).some(value => value !== undefined)) throw new Error('conversations local 不接受修改参数。');
    return z.array(conversationSchema).parse(await client.request('/api/conversations'));
  }
  if (action === 'create') {
    const engine = flags.engine?.trim();
    const requestId = flags.requestId ?? `cc_${randomUUID()}`;
    if (flags.host && flags.host !== 'auto' && flags.host !== 'local') {
      throw new Error('conversations create 目前支持 --host auto 或本地主机（省略 --host）。');
    }
    const profile = await client.request('/api/host-profile').catch(() => ({ name: 'local' })) as { name?: string };
    const resources = await client.request('/api/host-resources').then(raw => hostResourcesSchema.parse(raw)).catch(() => undefined);
    const bots = (client.ready.bots ?? []).filter(bot => !bot.deletedAt && bot.role !== 'worker');
    let chosenBot = flags.bot ? bots.find(b => b.id === flags.bot) : undefined;
    if (!chosenBot && engine) {
      chosenBot = bots.find(b => b.engine === engine && b.online) ?? bots.find(b => b.engine === engine);
    }
    let engineAvailable = Boolean(chosenBot);
    if (engine && !engineAvailable) {
      const catalog = await client.request('/api/bots/catalog').catch(() => undefined) as { engines?: Array<{ id?: string; engine?: string; available?: boolean; installed?: boolean }> } | undefined;
      const item = catalog?.engines?.find(e => (e.id ?? e.engine) === engine);
      if (item) engineAvailable = item.available !== false && item.installed !== false;
    }
    if (flags.host === 'auto') {
      const candidates: HostBalanceCandidate[] = [{
        hostId: 'local',
        hostName: profile.name ?? 'local',
        online: true,
        preference: 'normal',
        engineAvailable: engine ? engineAvailable : bots.length > 0,
        quotaExhausted: false,
        latencyMs: 1,
        resources,
        ...(chosenBot ? { matchingBotId: chosenBot.id, matchingBotName: chosenBot.name } : {}),
      }];
      const selection = selectBalancedHost(candidates);
      if (!selection.selected) {
        throw new Error(`自动选择主机失败（${selection.excluded.map(e => `${e.hostName}:${e.reason}`).join(', ') || 'no_eligible_host'}），请手动指定主机或检查引擎状态。`);
      }
    }
    let botId = chosenBot?.id;
    let botName = chosenBot?.name;
    let createdBot = false;
    if (!botId) {
      if (!engine) throw new Error('conversations create 需要 --bot ID 或 --engine ENGINE。');
      const botInput = createBotSchema.parse({
        requestId: `bot_${requestId}`,
        name: engine,
        engine,
        model: flags.model ?? '',
        effort: '',
        workspace: flags.workspace ?? '',
      });
      const res = await client.request('/api/bots', 'POST', botInput) as { bot?: { id: string; name: string }; id?: string; name?: string };
      botId = res.bot?.id ?? res.id;
      botName = res.bot?.name ?? res.name ?? engine;
      createdBot = true;
      if (!botId) throw new Error('自动创建 Bot 失败。');
    }
    const conversation = conversationSchema.parse(await client.request('/api/conversations', 'POST', {
      conversationType: 'direct',
      botIds: [botId],
      title: flags.title?.trim() || `与 ${botName ?? botId} 的新对话`,
      clientActionId: requestId,
    }));
    return { host: profile.name ?? 'local', hostSelection: flags.host === 'auto' ? 'auto' : 'local', botId, createdBot, conversation };
  }
  if (!['archive', 'restore', 'move'].includes(action ?? '')) throw new Error('使用 conversations local、create、archive、restore 或 move。');
  if (!client.ready.serverCapabilities.includes(CONVERSATION_BATCH_CAPABILITY)) throw new Error('请更新主机后使用批量整理对话。');
  if (action === 'restore' && !client.ready.serverCapabilities.includes(CONVERSATION_RESTORE_CAPABILITY)) throw new Error('请更新主机后使用恢复对话。');
  const requestId = flags.requestId ?? `cb_${randomUUID()}`;
  const conversationIds = flags.ids?.split(',').map(id => id.trim());
  let input;
  if (action === 'archive' || action === 'restore') {
    if (flags.folder !== undefined || flags.unfiled !== undefined || flags.newFolder !== undefined || flags.revision !== undefined) throw new Error(`${action} 不接受分组参数。`);
    if (flags.yes !== true) throw new Error(action === 'restore' ? '核对对话 ID 后加 --yes 恢复 App 对话；不会重启 Bot 或自动恢复讨论。' : '核对对话 ID 后加 --yes：可恢复归档，群内话题一并隐藏，当前回复继续，自动讨论在当前发言后暂停。');
    input = conversationBatchSchema.parse({ requestId, conversationIds, action });
  } else {
    if (flags.yes !== undefined) throw new Error('move 不接受 --yes。');
    if ([flags.folder !== undefined, flags.unfiled === true, flags.newFolder !== undefined].filter(Boolean).length !== 1 || flags.unfiled === false) throw new Error('请选择 --folder ID、--unfiled 或 --new-folder NAME 中的一项。');
    if (!/^\d+$/.test(flags.revision ?? '')) throw new Error('先用 folders list 读取 revision，再用 --revision N 提交。');
    input = conversationBatchSchema.parse({ requestId, conversationIds, action, revision: Number(flags.revision),
      target: flags.newFolder !== undefined ? { newFolder: { id: `folder_${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`, name: flags.newFolder } } : { folderId: flags.unfiled ? null : flags.folder } });
  }
  announce(requestId);
  try { return conversationBatchResultSchema.parse(await client.request('/api/conversations/batch', 'POST', input)); }
  catch (error) {
    if (error instanceof HostCliError) {
      const hints: Record<string, string> = {
        conversation_batch_topic_move: '话题随所属群组分组，请改用群 ID。',
        folders_changed: '分组已变化，先运行 folders list 读取最新 revision，再核对并提交新操作。',
        conversation_forbidden: '无权操作某个对话，请用 conversations local 核对可用 ID。',
        conversation_owner_required: '只有创建者可以归档或恢复对话；本次未作更改。',
        conversation_not_available: action === 'restore' ? '所属群组仍已归档，请先恢复群组或与话题一并选中。' : '对话已归档或不可用，请重新核对列表。',
        bot_deleted: '对话所属 Bot 已删除，无法恢复；请用 conversations local 核对目标。',
        conversation_batch_request_conflict: '此 request-id 已用于不同内容；核对原操作，勿复用编号修改目标。',
        folder_not_found: '目标分组不存在，请运行 folders list 核对。',
        folder_name_exists: '已有同名分组，请选择该分组或换一个名称。',
      };
      if (hints[error.code]) error.message = `${error.code}：${hints[error.code]}`;
    }
    throw error;
  }
}
