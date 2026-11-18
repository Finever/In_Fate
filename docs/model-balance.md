# 模型服务商余额查询

> 余额是账户/密钥级信息，不是推理接口的一部分。IF 只对明确提供余额 API 的厂商做适配，不抓控制台、不猜接口。

## 支持范围

| 厂商 | 接口 | 说明 |
|---|---|---|
| DeepSeek | `GET https://api.deepseek.com/user/balance` | Bearer key；返回 `balance_infos`，支持多币种 |
| Moonshot / Kimi | `GET https://api.moonshot.cn/v1/users/me/balance` | 以官方当前路径为准；返回可用、代金券、现金余额 |
| OpenRouter | `GET https://openrouter.ai/api/v1/credits` | 以官方当前路径为准；`total_credits - total_usage` 为可用余额 |

其余厂商（OpenAI、Anthropic、Google Gemini、智谱、百炼）当前没有面向普通 API key 的公开余额接口。UI 会显示「余额接口不支持」，不会发请求。

## 规则

- **按 key 查询**。余额属于 key 所属账户；多 key 可能来自不同账户，不能把余额直接相加。
- **只读**。IF 不会用余额接口充值、扣费或改账户设置。
- **宿主侧**。key 只在服务端读取，不进入浏览器；接口只返回归一化后的金额。
- **缓存 60 秒**。UI 的「刷新」会带 `?refresh=1` 跳过缓存。
- **5 秒超时**。超时、401/403、404、429 会返回明确错误，不混成模型请求失败。
- **不支持的厂商不发请求**。没有 adapter 就没有按钮。

## 接口

```text
GET /api/model-config/providers/:provider/api-keys/:keyId/balance
GET /api/model-config/providers/:provider/api-keys/:keyId/balance?refresh=1
```

响应：

```json
{
  "balance": {
    "provider": "deepseek",
    "keyId": "key-1",
    "checkedAt": "2026-11-15T00:00:00.000Z",
    "source": "api",
    "balances": [
      {
        "currency": "CNY",
        "total": 12.34,
        "available": 12.34,
        "granted": 2.0,
        "toppedUp": 10.34
      }
    ]
  }
}
```

错误：

| code | HTTP | 含义 |
|---|---|---|
| `balance_unsupported` | 400 | 厂商没有余额接口 |
| `balance_input` | 400 | provider / key 不存在、key 已停用、没有 baseUrl |
| `balance_unavailable` | 502 | 上游超时、鉴权不足、404、429 或其他失败 |

## 实现位置

- `src/model/balance.ts`：adapter、归一化、缓存、超时。
- `src/app/bundle.ts`：按 key 取密钥、按 provider 取 baseUrl。
- `src/app/server.ts`：HTTP 路由与错误码。
- `ui/src/components/SettingsDialog.tsx`：key 行内的「查询余额 / 刷新」。
- `tests/model-balance.test.ts` / `tests/server-model-balance.test.ts`：契约与路由测试。

## 已知限制

- 余额接口可能限流；UI 不自动轮询。
- 多 key 不聚合；按 key 展示。
- 环境变量 key 目前没有 keyId，不能在 UI 里按 key 查询。
- 自定义代理如果改写了余额路径，需要以后加 provider 级 `balanceUrl` 覆盖；v0 不开放任意 URL，避免 SSRF。
