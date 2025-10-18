/**
 * CTO.new API 转换器 - 主入口（Deno Deploy 友好版）
 * - 兼容 Deno Deploy 与本地开发
 * - 健康检查包含 KV 可用性
 */

import { Application } from "oak";
import { apiRouter } from "./src/routes/api.ts";
import { adminRouter } from "./src/routes/admin.ts";
import { PORT, VERSION } from "./src/config.ts";
import { logger } from "./src/services/logger.ts";

// ===== 运行环境探测：是否在 Deno Deploy =====
let IS_DEPLOY = false;
try {
  IS_DEPLOY = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));
} catch {
  // 本地未授予 --allow-env 时这里会抛异常，忽略即可 -> 视为非 Deploy
  IS_DEPLOY = false;
}

// ===== KV 连接（假设已在项目中启用 KV）=====
// 若你已在别处集中管理 KV，可把这段换成你的 KV 实例导入。
let kv: Deno.Kv | null = null;
try {
  kv = await Deno.openKv();
  logger.info("✅ KV 已连接");
} catch (e) {
  logger.warn(`⚠️ 无法连接 KV（忽略继续运行）：${e instanceof Error ? e.message : String(e)}`);
}

// ===== 创建 Oak 应用 =====
const app = new Application();

// ===== 日志中间件 =====
app.use(async (ctx, next) => {
  const start = Date.now();
  try {
    await next();
  } finally {
    const ms = Date.now() - start;
    const method = ctx.request.method;
    const url = ctx.request.url.pathname;
    const status = ctx.response.status || 404;

    // 过滤掉不需要记录的请求
    const filteredPaths = [
      "/admin/api/logs/stream",   // SSE 日志流
      "/admin/api/stats",         // 管理后台轮询统计
      "/admin/api/cookies",       // 管理后台轮询 Cookie
      "/admin/api/conversations", // 管理后台轮询会话
      "/favicon.ico",             // 图标请求
    ];
    if (filteredPaths.some((path) => url.includes(path))) return;

    // 使用日志服务记录
    if (status >= 400) {
      logger.error(`${method} ${url} - ${status} (${ms}ms)`);
    } else {
      logger.info(`${method} ${url} - ${status} (${ms}ms)`);
    }
  }
});

// ===== 错误处理中间件 =====
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    logger.error(`请求错误: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    ctx.response.status = 500;
    ctx.response.type = "application/json";
    ctx.response.body = { error: "Internal Server Error" };
  }
});

// ===== 健康检查（包含 KV 探测）=====
app.use(async (ctx, next) => {
  const p = ctx.request.url.pathname;
  if (ctx.request.method === "GET" && (p === "/" || p === "/healthz")) {
    let kvOk = false;
    try {
      if (kv) {
        // 轻量探测：尝试读取一个不存在 key（不会写入，几乎无开销）
        await kv.get(["__health"]);
        kvOk = true;
      }
    } catch {
      kvOk = false;
    }
    ctx.response.status = 200;
    ctx.response.type = "application/json";
    ctx.response.body = {
      ok: true,
      version: VERSION,
      env: IS_DEPLOY ? "deploy" : "local",
      kv: kvOk ? "ok" : "unavailable",
    };
    return;
  }
  await next();
});

// ===== CORS 中间件（可按需收紧来源）=====
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  ctx.response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
  // 让客户端读到自定义头（若你有设置）
  ctx.response.headers.set(
    "Access-Control-Expose-Headers",
    "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining",
  );

  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }

  await next();
});

// ===== 注册路由 =====
app.use(adminRouter.routes());
app.use(adminRouter.allowedMethods());
app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());

// ===== 启动横幅日志（避免多实例重复打印）=====
if (!(globalThis as any).__BOOT_LOGGED__) {
  (globalThis as any).__BOOT_LOGGED__ = true;

  const baseUrl = IS_DEPLOY
    ? "https://<你的 Deno Deploy 域名或预览 URL>"
    : `http://localhost:${PORT}`;

  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🚀 CTO.new API 转换器 v${VERSION}                   ║
║                                                       ║
║   📡 服务地址: ${baseUrl}                             ║
║   🎨 管理后台: ${baseUrl}/admin                       ║
║   📚 API 文档: ${baseUrl}/                            ║
║                                                       ║
║   ✨ 功能特性:                                        ║
║      • OpenAI 兼容的聊天接口                           ║
║      • 支持流式和非流式响应                            ║
║      • Cookie 管理后台                                 ║
║      • 实时系统监控                                    ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
`);
  logger.info(IS_DEPLOY
    ? "🚀 Deno Deploy 环境启动"
    : `🚀 本地服务器启动，监听端口 ${PORT}`);
  logger.info(`🎨 管理后台: ${baseUrl}/admin/login`);
  logger.info("✅ 实时日志系统已启动");
  logger.info("📡 等待 API 请求...");
}

// ===== 使用 Deno.serve 驱动 Oak（Deploy 会忽略端口，本地则绑定端口）=====
const handler = (request: Request) => app.handle(request);
if (IS_DEPLOY) {
  // Deno Deploy：端口由平台接管，这里无需也不应指定端口
  Deno.serve(handler);
} else {
  // 本地：使用你的 PORT 变量
  Deno.serve({ port: PORT }, handler);
}
