# 1. Tampermonkey Cookie & User Grabber (`aistudio-cookie-grabber.user.js`)

在浏览器访问 `https://aistudio.google.com/` 时，通过油猴特权接口 `GM_cookie.list` 一键提取包含 `HttpOnly` 在内的 Google 核心鉴权 Cookie、多账号序号（`authUser`）以及订阅等级（`g1Tier`: 默认 `TIER0`，Pro 自动识别为 `TIER1`，Ultra 识别为 `TIER2`），支持一键复制到系统剪切板或直接推送至本地中转客户端（`http://127.0.0.1:18802`）。

---

## 必配设置（重要）

1. **使用原版 Tampermonkey（v4.18+ / v5.x）或 ScriptCat（脚本猫）**
   - 注意：Violentmonkey（暴力猴）未实现 `GM_cookie` 接口，无法读取 `HttpOnly` Cookie。
2. **开启 Tampermonkey 的 `HttpOnly` Cookie 读取权限**：
   - 打开 Tampermonkey 管理面板 → **设置（Settings）**
   - 第一行 **配置模式（Config mode）** 切换为 **高级（Advanced）**
   - 向下滚动至 **安全（Security）** 区域
   - 将 **脚本 Cookie 访问权限（Script cookies access）** 从默认的 `All but HttpOnly` 改为 **`All`（所有）**。
3. **开启 Chrome 扩展「允许用户脚本」开关（Chrome 138+）**：
   - 打开 `chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo`
   - 打开 **允许用户脚本（Allow User Scripts）**。

---

## 使用方式

1. 将 `aistudio-cookie-grabber.user.js` 导入 Tampermonkey。
2. 打开 `https://aistudio.google.com/`。
3. 页面右下角会出现两个悬浮按钮：
   - **「📋 复制 WAA Cookie 到剪切板」**：将包含 20 项白名单 Cookie（含 14 项 `HttpOnly`）及 `authUser`、`g1Tier` 的 JSON 直接写入系统剪切板（示例格式见 `cookie-export.example.json`）。
   - **「🚀 推送本地 18802」**：通过 `GM_xmlhttpRequest` 直接将当前账号推送到本地中转端 `http://127.0.0.1:18802/v1/accounts/add` 内存池中。
