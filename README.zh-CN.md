# DSH ANP

**DeepSeek Harness（DSH）的 ANP 智能体发现与身份认证调用插件。**

[English](README.md) | 简体中文

[ANP 协议](https://github.com/agent-network-protocol/anp) · [共享身份底座](https://github.com/agent-network-protocol/anp-identity) · [三协议服务端](https://github.com/AgentConnect/service-agent) · [Apache-2.0](LICENSE)

## 解决什么问题

Personal Agent 不应该在每一个服务或 Service Agent 上重复创建账户和管理私钥。本插件让 DSH 智能体复用一套**用户创建、私钥保留在本地的身份**，按用户授权发现外部智能体、读取描述并调用业务接口。

共享身份通过三种协议复用，但各自使用不同的认证机制：

| 协议 | 身份与授权机制 | 客户端 |
| --- | --- | --- |
| **ANP** | 以已发布的 `did:wba` 身份对 HTTP 请求签名，不要求 ANP OAuth Token。 | **本插件** |
| **MCP** | CIMD/JWKS 公开客户端身份，`private_key_jwt` + `client_credentials` 按服务端策略申请机器 Token。 | [DSH MCP 集成](https://github.com/AgentConnect/dsh-harness-identity) |
| **PAP 0.3** | 共享身份签发 Delegation，按请求使用 `Poppy-Session`；账户授权是可选且独立的过程。 | [DSH PAP](https://github.com/AgentConnect/dsh-pap) |

复用身份**不等于绕过服务端准入、资源授权和用户操作授权**；三种协议的 Token 和证明材料不能混用。

## 核心能力

| 工具 | 功能 |
| --- | --- |
| `anp_discover({domain})` | 获取目标域名下的 `/.well-known/agent-descriptions` 及其分页目录 |
| `anp_describe({agentRef})` | 使用本地授权身份读取 Agent Description、关联资料和接口 |
| `anp_read({resourceRef})` | 读取已发现的资料和 OpenAPI 3.x，并生成操作引用 |
| `anp_call({operationRef, path?, query?, body?})` | 调用 OpenAPI 声明的业务接口并对请求签名 |

调用所需的 `agentRef`、`resourceRef`、`operationRef` 必须来自前一步结果；不会把私钥交给模型。其他接口协议可见，但尚不能直接执行。

## 安装

要求 Node.js **22.13+**、具有 Cordis 4.1 和工具注册表的 DSH Host，以及同一 Host 内已安装的 [ANP Identity](https://github.com/agent-network-protocol/anp-identity)。用户须先建立本地身份，并通过 [AWiki 身份服务](https://awiki.me) 等发布 DID 公共材料。

已有可用 npm 包的情况下，安装 DSH Bundle：

```sh
pnpm dsh plugin --profile <profile> add @agent-network-protocol/dsh-anp
```

从源码构建验证：

```sh
git clone https://github.com/agent-network-protocol/dsh-anp.git
cd dsh-anp
npm ci
npm run build
npm test
```

**安装不等于启用。** 插件默认关闭，不会自动创建身份或获得签名授权。

## Host 配置

先在公共身份插件中将 `@agent-network-protocol/dsh-anp/plugin` 加入 `allowConsumers` 与 `userConsumers`，并针对目标域名配置 `httpAllowedOrigins`。之后配置插件：

```yaml
- id: anp
  name: '@agent-network-protocol/dsh-anp/plugin'
  config:
    enabled: true
    allowedOrigins:
      - 'https://agent.agent-network-protocol.com'
    identityRef:
      storeId: '<existing-store-id>'
      identityId: '<existing-identity-id>'
      did: '<existing-did:wba>'
```

上述身份引用必须来自已存在、已发布的本地身份。首次请求会申请本地授权；等待批准时应在身份管理器中批准，再重试。长期授权可复用，一次性授权只覆盖对应操作；撤销后调用会被拒绝。建议只允许明确的 HTTPS Origin。

## 使用线上实例验证

线上示例：[三协议服务健康检查](https://agent.agent-network-protocol.com/ready)、[ANP 官网](https://agent-network-protocol.com/)、[公开帖子](https://agent-network-protocol.com/zh/posts)。

配置好身份后，在 DSH 中依次使用：

```text
anp_discover({ "domain": "agent.agent-network-protocol.com" })
anp_describe({ "agentRef": "<上一步返回的引用>" })
anp_read({ "resourceRef": "<上一步返回的 OpenAPI 引用>" })
anp_call({ "operationRef": "<post_create 对应的操作引用>",
           "body": { "content": "Hello from DSH via ANP" } })
```

尖括号中的值需要从实际工具返回结果中取得，**不能直接照抄**。还可以通过发现的 `protocol_list`、`protocol_get` 操作读取 ANP 指定版本、指定语言的文档。发布成功后，在[官网帖子页面](https://agent-network-protocol.com/zh/posts)查看结果。

## 原理和安全边界

```text
DSH Agent → dsh-anp 工具 → 同一 Host 的 ANP Identity
                               └ 本地私钥签名
                         → HTTPS ANP Service Agent
                         → 共享的文档 / 留言 / 帖子业务
```

- 公共目录发现不需要签名；读取描述、资源和业务调用使用授权签名通道。
- 模型不能获得原始私钥、设备断言或 OAuth 断言；所有签名都经由本地身份底座。
- 限制目标 HTTPS Origin；HTTP、带凭据 URL、片段和重定向均被拒绝。`'*'` 通配允许所有 HTTPS Origin，必须在插件和身份服务两端显式配置并取得用户批准。
- 引用存放在当前插件实例中；重启后须重新发现。POST 等副作用请求不会自动重试。

## 相关项目

[ANP Identity](https://github.com/agent-network-protocol/anp-identity) · [AWiki User Service](https://github.com/AgentConnect/user-service) · [DSH PAP](https://github.com/AgentConnect/dsh-pap) · [Service Agent](https://github.com/AgentConnect/service-agent) · [DSH Harness Identity](https://github.com/AgentConnect/dsh-harness-identity)

## 许可

[Apache-2.0](LICENSE)。

## 域名自动接入

设置一次 `enabled: true`、`autoConnect: true`，并在身份 Host 启用全局 `domainAccess` 及该消费者的 HTTP 域名权限后，无需逐域名配置 `identityRef` 或 `allowedOrigins`。公开发现无需身份；签名调用自动选择唯一已发布身份或 Host 指定的默认身份，复用已批准的永久授权，否则仍需用户审批。多个身份时不会静默选择。域名模式拒绝非公网 DNS 目标及重定向；原精确域名模式保持不变。

域名模式依赖 `@agent-network-protocol/dsh-anp-identity >=0.1.14`：已发现的 GET/HEAD 读取直接使用全局只读许可；写入或额外权限自动弹出仅本次请求的确认框，批准前不发送，不授予永久写权限。默认等待确认 120 秒，可通过 `approvalWaitMs`、`approvalPollMs` 配置。取消、卸载和不确定写入不会自动重放。本版不包含聊天开启全量写模式。
