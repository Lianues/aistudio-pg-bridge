# AI Studio WAA Proof & Relay Suite

本项目按职责拆分为三个独立文件夹，全部默认运行于本地端口（无需公网暴露；中转端导入的 Cookie 持久化到 `2-relay-client-gateway/cookies/`，签名端内存池保持零落盘）：

```text
.
├── 1-tampermonkey-cookie-grabber/   # 1. 获取 Cookie 的油猴脚本（含 HttpOnly Cookie + User/Tier 识别 + 剪切板导出）
│   ├── aistudio-cookie-grabber.user.js
│   ├── cookie-export.example.json
│   └── README.md
├── 2-relay-client-gateway/          # 2. 中转反代客户端（暴露本地 OpenAI/Gemini API + 实时 SSE 流式 + 调用 GenerateContent）
│   ├── bin/start-relay.js
│   ├── src/relay-server.js
│   ├── src/dashboard.js
│   ├── test/stream-verify.js
│   ├── .env.example
│   ├── cookies.example.json
│   ├── package.json
│   └── README.md
└── 3-waa-proof-server/              # 3. 服务端 !xxx 签名服务（纯 Node VM + 1h 内存池，无任何获取/轮换 Cookie 逻辑）
    └── API.md
```

---

## 完整使用流程

1. **启动中转反代端（`2-relay-client-gateway`，端口 `18802`）**：
   ```bash
   cd 2-relay-client-gateway
   node bin/start-relay.js
   ```
2. **浏览器油猴抓取 Cookie（`1-tampermonkey-cookie-grabber`）**：
   - 将 `1-tampermonkey-cookie-grabber/aistudio-cookie-grabber.user.js` 安装到 Tampermonkey（在油猴设置中将 `Script cookies access` 设为 `All`）。
   - 打开 `https://aistudio.google.com/`，点击右下角 **「📋 复制 WAA Cookie 到剪切板」**（或直接点 **「🚀 推送本地 18802」**）。
   - 在 `http://127.0.0.1:18802/` 面板粘贴导入即可通过 `http://127.0.0.1:18802/v1/chat/completions` 调用 `gemini-4-argon`、`gemini-3.8-flash` 等模型（支持 `stream: true` 实时 SSE 流式输出）。
