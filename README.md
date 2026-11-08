# 语音通话（@local/dsh-voice-call）

在 DeepSeek Harness 的输入框里加一个电话按钮：点一下就和 `gpt-realtime-2.1` 通话，
你说的话会变成**当前会话的普通用户消息**，agent 照常在聊天里写代码、跑工具；agent
这一轮结束后，语音端再用一两句话播报结果摘要。

## 位置

- 入口按钮：`conversation.input.right`，输入框工具行内、模型选择器左侧。
- 通话控制条：`conversation.input.dock`，输入框卡片正上方（状态、计时、静音、挂断、
  配置与错误都在这里）。

## 首次配置

1. 在「设置 → 模型」里配好 OpenAI（或任意方式把 `OPENAI_API_KEY` 存进 Harness 凭据库）。
2. 如果没配，点按钮后通话条会直接给出一个 Key 输入框；保存同样写入凭据库的
   `OPENAI_API_KEY`，不会进聊天记录，也不会存到浏览器。
3. 再点一次按钮开始通话，第一次会弹出系统/浏览器的麦克风授权。

## 怎么用

- 说「把 README 里的安装步骤补全」→ 聊天里出现这条 user 消息 → agent 开始执行。
- 说「停一下」→ 语音模型调用 `interrupt_agent`，取消当前回合。
- 说「它刚才说什么了」→ 调用 `check_agent` 读当前状态和最后一条回复。
- 通话中仍然可以打字，两条输入走同一条队列。
- 语音模型只做转达，不自己写代码；播报时会跳过代码块，只说「代码在聊天里」。

## 配置（可选）

默认值在 `index.js` 的 `DEFAULTS` 里。需要改时在 `cordis.patch.yml` 的 insert 行上加
`config`（不校验 schema，按对象合并）：

```yaml
- insert:
    - id: voice-call
      name: '@local/dsh-voice-call'
      config:
        model: gpt-realtime-2.1
        voice: marin
        apiKeyRef: OPENAI_API_KEY
        announce: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `model` | `gpt-realtime-2.1` | Realtime 模型 id |
| `voice` | `marin` | `alloy` `ash` `ballad` `coral` `echo` `sage` `shimmer` `verse` `marin` `cedar` |
| `apiKeyRef` | `OPENAI_API_KEY` | 凭据引用名 |
| `announce` | `true` | agent 回合结束后是否自动语音播报摘要 |
| `upstreamTimeoutMs` | `20000` | 与 OpenAI 交换 SDP 的超时 |
| `instructions` | 内置 | 语音前端角色提示 |

## 实现要点

- **API Key 不出 Host**：浏览器只把 WebRTC 的 SDP offer POST 到本机
  `/voice-call/session`；Host 用凭据库里的 Key 向
  `https://api.openai.com/v1/realtime/calls` 发 `multipart/form-data`（`sdp` + `session`），
  只把 SDP answer 回给页面。音频走浏览器 ↔ OpenAI 的媒体轨，不经过 Host。
- **来源校验**：桌面应用的窗口加载的是 `dsh-app://app`，壳会把非静态资源的请求转发给
  本机 web server，并在转发前**删掉 `Origin` 和 `Sec-Fetch-Site`**（`forwardWebRequest`
  的行为）。因此路由接受的调用者是：无 `Origin`（壳的转发或本机非浏览器客户端）、
  `Origin` 等于 `webServer.getOrigin()`、`Origin` 为 `dsh-app://app`，或同端口的
  loopback（`localhost` / `127.0.0.1` / `[::1]`）。浏览器对所有 POST 都会带 `Origin`，
  所以跨站页面仍然会被拒；`Sec-Fetch-Site` 若存在则必须是 `same-origin` 或 `none`。
  body 上限 64 KiB；服务默认只监听 `127.0.0.1`。本机同一用户的其他进程可以直接调用这个
  路由——这和它们本来就能读凭据文件是同一个信任边界，插件不做额外用户认证。
- **聊天投递**：客户端用 `ctx.sessions.retain(...).binding.session.prompt(text, 'queue')`
  投递，和输入框同一条链路；`cancel()` 取消。
- **播报**：客户端订阅会话事件拿最后一条 `assistant/message`，回合结束时用
  `response.create`（`conversation: "none"`、禁工具）让语音模型复述摘要。

## 隐私与费用

音频会实时发送给 OpenAI，并按 `gpt-realtime-2.1` 的音频 token 计费（你自己的 OpenAI
账号）。通话条会显示计时与提示。

## 限制

- 一次通话最长 60 分钟（OpenAI 限制），本插件不做续期。
- 同一时间每个会话只有一通电话；切换会话或卸载插件会立即挂断。
- 测试环境没有浏览器控制工具，音频与外观需要在页面里人工确认。

## 排错

通话条在错误阶段会先给一句本地化原因，下面再显示服务端返回的技术细节
（例如 `forbidden-origin`、`openai-rejected` 或 OpenAI 的原文）。常见的几种：

| 细节 | 含义 |
|---|---|
| `forbidden-origin` | 来源校验拒绝；看括号里的 `origin` / `sec-fetch-site` |
| `openai-rejected` | 请求到达了 OpenAI，但被拒（模型/音色权限、账号地区、参数） |
| `upstream-timeout` / `upstream-unreachable` | Host 进程连不上 `api.openai.com` |
| `missing-credential` | 凭据库里没有值；通话条会直接给出 Key 输入框 |

改了 Host 半（`index.js`）必须让插件重新加载：在插件管理器里禁用再启用，或重启应用；
改了客户端半（`client.js`）刷新页面即可。
