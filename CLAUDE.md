# ATMM.store 项目说明

## 与用户沟通语言
**必须全程用中文与用户沟通**，包括解释、提问、说明、总结等所有对话内容。
代码本身（JS、CSS、HTML、注释等）可以用任何语言写，不受此限制。

## 项目概述
ATMM.store 是一个仓库库存管理 SaaS，前端为单页 HTML 应用（`index.html`），
后端使用 Vercel Serverless Functions（`api/*.js`），数据库使用 Supabase。

## 技术栈
- 前端：单文件 HTML + 原生 JS（无框架）
- 后端：Vercel Serverless Functions（CommonJS，`api/*.js`）
- 数据库：Supabase（Auth + PostgreSQL）
- 部署：Vercel（推送 main 分支自动部署）

## 权限分级
| 功能 | 老板 | 经理 | 操作员 |
|------|------|------|--------|
| 增删区域 | ✅ | ❌ | ❌ |
| 增删货架/排/层 | ✅ | ✅ | ❌ |
| 型号库上传 | ✅ | ✅ | ❌ |
| 重置 | ✅ | ❌ | ❌ |
| 团队管理 | ✅ | ❌ | ❌ |
| 邀请码 | ✅ | ❌ | ❌ |
| 多仓库切换 | ✅(>1仓库) | ❌ | ❌ |

## 状态格式（v2）
```js
state = {
  models: [...],
  zones: [
    { id, name, type:'shelf'|'pallet', aisles:[...], filler:'', date:'' }
  ]
}
```
库位编号格式：`①A-1-01`（区域前缀·通道字母·列号·格位）
