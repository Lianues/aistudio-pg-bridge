# 2. Relay Client & Gateway (`2-relay-client-gateway`)

本地 OpenAI / Gemini 兼容反代网关（默认监听 `http://127.0.0.1:18802`）：
- **Cookie 持久化账号池**：面板粘贴油猴导出的 JSON、原始 Cookie 或 cURL 导入后，自动写入 `cookies/` 目录（一个账号一个 JSON），重启自动加载；无需手动维护 `cookies.example.json`。
- **与 `3-waa-proof-server` 协同**：只把最小核心 Cookie 与聊天记录发往 `PROOF_SERVER_URL/v1/proof/mint` 换取 `!xxx` 签名；`SAPISIDHASH` 鉴权头和 Cookie 轮换都在本地完成，再直连 Google `MakerSuiteService/GenerateContent`。
- **401 自愈**：遇到 401/权限 403 时，本地调用 `accounts.google.com/RotateCookies` 刷新 `__Secure-1PSIDTS`/`SIDCC`，写回内存与 `cookies/*.json` 后重新签名并重试一次；Google 响应里的 `Set-Cookie` 也会同步到本地账号。
- **失败自动换号**：`401` / 权限类 `403` / `429` / `5xx` / 网络异常时，自动切换到下一个未试过的账号重试，最多尝试 `min(账号数, 3)` 个；`Region not supported` 这类环境问题不换号。
- **真增量实时 SSE 流式响应**：内置 `IncrementalJspbFrameParser` 流式状态机，按字节流实时解析 Google 返回的 `[[ frame1, frame2, ... ]]` 数据帧，边收边向下游推送 `chat.completion.chunk`（含思考过程 `reasoning_content` 与正文 `content`），无整包等待延迟。

---

## Cookie 持久化

启动时会自动创建 `<项目目录>/cookies/`（目录 `0700`，文件 `0600`）：

```text
2-relay-client-gateway/
└── cookies/
    ├── acc_c900f1328dd0fe43.json
    └── acc_1a2b3c4d5e6f7a8b.json
```

- **导入即落盘**：面板「导入 Cookie」、油猴「🚀 推送本地 18802」、`POST /api/accounts/add` 三种方式都会自动写文件。
- **重启自动加载**：服务启动时扫描 `cookies/*.json` 全部载入内存，无需重新粘贴。
- **删除同步删文件**：面板删除账号时对应 JSON 一并删除。
- **一个账号一个文件**，文件内容：

```json
{
  "accountId": "acc_c900f1328dd0fe43",
  "authUser": 0,
  "g1Tier": "TIER1",
  "source": "manual",
  "addedAt": 1793372047555,
  "updatedAt": 1793372047555,
  "cookies": "SID=...; SAPISID=...; __Secure-1PSID=..."
}
```

- 自定义目录：`COOKIES_DIR=/path/to/cookies`（相对路径以项目根目录为基准）。
- `cookies/` 已在 `.gitignore` 中排除，**不要把凭证提交进仓库**。

---

## 快速启动

```bash
cd 2-relay-client-gateway
node bin/start-relay.js
```

配置**只从 `.env` 读取**，启动时自动加载（无需 `--env-file`、也无需命令行传参）：

| 变量 | 说明 |
|---|---|
| `RELAY_HOST` / `RELAY_PORT` | 监听地址，默认 `127.0.0.1:18802` |
| `PROOF_SERVER_URL` | 签名服务地址，如 `https://waa.spinsnow.fun` |
| `RELAY_API_KEY` | 下游调用鉴权，默认 `sk-waa-local-relay-key` |
| `DEFAULT_MODEL` | 默认模型，默认 `gemini-3.8-flash` |
| `COOKIES_DIR` | Cookie 持久化目录，默认 `./cookies` |

真实环境变量优先于 `.env` 中的同名项（便于临时覆盖）。

启动后访问：
- **本地状态与 Cookie 导入面板**：`http://127.0.0.1:18802/`
- **OpenAI Base URL**：`http://127.0.0.1:18802/v1`
- **默认 API Key**：`sk-waa-local-relay-key`（由 `RELAY_API_KEY` 控制）

---

## 调用示例（OpenAI 实时 SSE 流式）

```bash
curl -N http://127.0.0.1:18802/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-waa-local-relay-key" \
  -d '{
    "model": "gemini-4-argon",
    "stream": true,
    "messages": [
      {"role": "user", "content": "请用三句话介绍量子计算"}
    ]
  }'
```
