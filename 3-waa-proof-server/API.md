# 3. WAA Proof Server — API 示例

纯 Node.js 的 `!proof` 签名服务。只做三件事：**收 Google Cookie → 在内存 VM 里算 `!xxx` 签名 → 返回签名**（`Authorization` 等头由调用方用自己的 Cookie 本地计算）。

## 1. 池子查询（必须传 Cookie）

用某个账号的 Cookie 查询它在内存池中的状态：

```bash
curl -s https://waa.spinsnow.fun/health \
  -H 'X-Google-Cookies: SID=YOUR_SID; SAPISID=YOUR_SAPISID'
```

也支持查询参数 `/health?cookies=...`（注意 query 会进 nginx 访问日志，建议用请求头）。`/v1/pool/stats` 与 `/health` 完全等价，可附加 `?authUser=0` 或 `X-Goog-AuthUser` 头区分多账号。

```json
{
  "ok": true,
  "hotTtlMs": 3600000,
  "account": {
    "accountId": "acc_c900f1328dd0fe43",
    "state": "hot",
    "authUser": 0,
    "g1Tier": "TIER1",
    "mints": 3,
    "lastActiveAt": 1793373480503,
    "expiresAt": 1793377080503
  }
}
```

- 该 Cookie **不在池中**时 `account` 为 `null`（`ok` 仍为 `true`）。
- `state` 为 `hot`（VM 就绪）或 `initializing`（正在冷启动）；`expiresAt` = VM 回收时间（`lastActiveAt + hotTtlMs`），到点后条目直接从内存删除。
- 不传 Cookie 返回 `400`。
- 响应只包含 `ok` / `hotTtlMs` / `account` 三个字段。

---

## 2. 签名（最常用接口）

### 2.1 最小请求

```bash
curl -s -X POST https://waa.spinsnow.fun/v1/proof/mint \
  -H 'Content-Type: application/json' \
  -d '{
    "cookies": "SID=YOUR_SID; HSID=YOUR_HSID; SSID=YOUR_SSID; APISID=YOUR_APISID; SAPISID=YOUR_SAPISID; __Secure-1PSID=YOUR_1PSID; __Secure-3PSID=YOUR_3PSID",
    "authUser": 0,
    "model": "models/gemini-4-argon",
    "messages": [
      { "role": "user", "content": "你好" }
    ]
  }'
```

`cookies` 也可以放在请求头里：`X-Google-Cookies: SID=...; SAPISID=...`。

### 2.2 响应

```json
{
  "ok": true,
  "proof": "!ZWalZgLNAAY187QsFfNCx67rQ...",
  "poolState": "hot"
}
```

`mint` **只返回签名**，不回传 Cookie/Authorization —— Cookie 本来就是你传进来的，`Authorization`（`SAPISIDHASH <ts>_<sha1(ts + " " + SAPISID + " " + origin)>`）由调用方用自己手里的 `SAPISID` 本地计算。

### 2.3 请求字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `cookies` | ✅ | Google Cookie 字符串（`k=v; k=v`）、数组或对象均可；也支持 `X-Google-Cookies` 头 |
| `authUser` | ❌ | 多账号索引，默认 `0`；对应 `x-goog-authuser` 头 |
| `g1Tier` | ❌ | 账号等级 `TIER0` / `TIER1` / `TIER2`，不传会自动探测 |
| `model` | ❌ | 默认 `models/gemini-3.8-flash`；支持别名 `argon` |
| `messages` | ❌ | `[{ "role": "user", "content": "..." }]`，最省事 |
| `contents` | ❌ | Gemini 原生格式 `[{ "role": "user", "parts": [{ "text": "..." }] }]` |
| `prompt` | ❌ | 单个字符串 |
| `wireContents` | ❌ | 已编码好的 wire 数组（中继端用，保证 digest 与真实请求完全一致） |
| `generationConfig` | ❌ | 预留，参与签名上下文 |

> `messages` / `contents` / `prompt` / `wireContents` 四选一即可；内容只影响签名用的 digest，服务端不会真的向 Google 发对话请求。

### 2.4 响应字段

| 字段 | 说明 |
|---|---|
| `proof` | `!` 开头的签名串，放进 `GenerateContent` 请求体第 5 个字段（wire 的 index 4） |
| `poolState` | `hot`（VM 复用，毫秒级）/ `cold`（本次冷启动，约 600 ms~1 s）/ `singleflight-joined`（并发合并） |

---

## 3. 错误格式

所有错误统一为 `{ "ok": false, "error": "..." }`：

| 状态码 | 场景 | 示例 |
|---|---|---|
| `400` | 缺 `cookies`（mint） | ``{"ok":false,"error":"Missing `cookies` in request body or X-Google-Cookies header"}`` |
| `400` | 缺 `cookies`（health） | ``{"ok":false,"error":"Missing `cookies` query parameter or X-Google-Cookies header"}`` |
| `404` | 路径不存在 | `{"ok":false,"error":"Not found: GET /nope"}` |
| `500` | 签名失败（Cookie 失效、VM 异常等） | `{"ok":false,"error":"..."}` |

---

## 4. 备注

- **零落盘**：Cookie 只在内存；VM 空闲超过 `hotTtlMs`（默认 1 小时）后，连账号条目一起从内存删除，进程重启即清空。
- **性能**：热态单次 `~10–30 ms`；冷启动首次 `~600 ms~1 s`（VM 重新初始化）；同一账号并发会自动合并（`singleflight-joined`）。
- **账号隔离**：账号由 Cookie（`SAPISID` 等）推导，不同 `authUser` 视为不同账号；每次请求都用调用方当次传入的 Cookie 覆盖池内副本。
