import React from 'react';
import { spaceAgentConnection, spaceAgentPrompt } from '../../../bootstrap/SpaceAgentGuide.ts';
import { isZhLang, resolveApiOrigin } from '../../../bootstrap/SpaceBootstrap.ts';
import { spaceUiStore } from '../store/SpaceUiStore.ts';

export function SpaceAgentInstructions() {
  const zh = isZhLang();
  const connection = spaceUiStore.getApiKeyClient()?.getAgentConnection() || spaceAgentConnection(
    resolveApiOrigin(import.meta.env.VITE_SPACE_API_BASE_URL || import.meta.env.VITE_API_BASE_URL, window.location.origin),
  );
  const prompt = spaceAgentPrompt(connection.origin, zh);
  const [message, setMessage] = React.useState('');
  return <section className="settings-agent-guide" aria-labelledby="settings-agent-guide-title">
    <div className="settings-section-title" id="settings-agent-guide-title">{zh ? '让外部 Agent 在你附近建造' : 'Build nearby with an external agent'}</div>
    <p>{zh
      ? '可直接复制下方的 Prompt 发送给你的 Agent（如 Claude、Cursor 等），Agent 会根据指引向你索取 API Key，并在在线世界中建造你所需的机械或场景。'
      : 'Directly copy the prompt below to your agent (e.g. Claude, Cursor). The agent will ask you for an API key and build structures in the online world.'}</p>
    <p>{zh
      ? 'Agent 通过 spaceAPI 发送网络请求；实体代码在运行时调用 entityAPI（self / ctx）。两份文档均免登录，并可互相跳转。'
      : 'Agents send HTTP requests through spaceAPI. Entity code calls entityAPI (self / ctx) inside the runtime. Both public documents link to each other.'}</p>
    <dl>
      <div><dt>{zh ? '后端地址' : 'Backend URL'}</dt><dd><code>{connection.origin}</code></dd></div>
      <div><dt>{zh ? 'spaceAPI · Agent 网络请求' : 'spaceAPI · Agent HTTP requests'}</dt><dd><a href={connection.spaceApiUrl} target="_blank" rel="noopener noreferrer">{connection.spaceApiUrl}</a></dd></div>
      <div><dt>{zh ? 'entityAPI · 实体代码' : 'entityAPI · Entity code'}</dt><dd><a href={connection.entityApiUrl} target="_blank" rel="noopener noreferrer">{connection.entityApiUrl}</a></dd></div>
      <div><dt>Agent Skill</dt><dd><a href={connection.skillUrl} target="_blank" rel="noopener noreferrer">{connection.skillUrl}</a></dd></div>
      <div><dt>{zh ? '自己的位置 · 需要 Key' : 'Own position · key required'}</dt><dd><code>GET /space/api/v2/players/me/position</code></dd></div>
    </dl>
    <p>{zh
      ? '文档不需要登录；读取位置和建造请求需要 Bearer API Key。位置超过 30 秒会标记为过期。所有 API Key（包括已有 Key）均拥有完整 Space 权限，可创建、编辑、启动／停止实体和建造方块组，无需单独勾选。先停止再修改，运行时保持浏览器在线。localhost 地址只能供同一台机器上的 Agent 使用。'
      : 'The guide needs no login; position and build requests need a Bearer API key. Positions older than 30 seconds are marked stale. All API keys, including existing keys, have full Space permissions to create, edit, start/stop entities and build blocksets. No permission selection is needed. Stop before editing and keep your browser online for execution. A localhost address works only for an agent on the same machine.'}</p>
    <details>
      <summary>{zh ? '查看发给 Agent 的示例' : 'View an example prompt for your agent'}</summary>
      <pre>{prompt}</pre>
    </details>
    <button className="small-btn" onClick={() => {
      if (!navigator.clipboard?.writeText) {
        setMessage(zh ? '请展开示例并手动复制。' : 'Expand the example and copy it manually.');
        return;
      }
      void navigator.clipboard.writeText(prompt).then(
        () => setMessage(zh ? '已复制，直接发送给你的 Agent 即可。' : 'Copied. Send directly to your agent.'),
        () => setMessage(zh ? '复制失败，请展开示例并手动复制。' : 'Copy failed. Expand the example and copy it manually.'),
      );
    }}>{zh ? '复制接入 Prompt' : 'Copy Agent Prompt'}</button>
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
