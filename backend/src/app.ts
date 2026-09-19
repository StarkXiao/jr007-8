import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { requestId } from "./middleware/requestId";
import { optionalAuth } from "./middleware/auth";
import { resolveConfig } from "./middleware/configContext";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { buildApiRouter } from "./routes";
import { pingRedis } from "./db/redis";
import { prisma } from "./db/prisma";
import { buildAllowedOrigins } from "./config/origins";
import { refreshConfig, subscribeInvalidation } from "./modules/appconfig/service";

export function createApp(): Express {
  const app = express();

  // 启动时预热在线配置；失败不阻塞启动（有内置默认配置兜底）
  void refreshConfig(true).then(() => subscribeInvalidation()).catch(() => undefined);

  // 反向代理后要拿到真实客户端 IP，限流与审计都依赖它
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(requestId);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).traceId ?? "unknown",
      autoLogging: {
        ignore: (req) =>
          Boolean(req.url?.startsWith("/healthz") || req.url?.startsWith("/readyz")),
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  app.use(
    helmet({
      // 图片会被前端域跨源加载，这里放开资源策略；
      // 其余安全响应头保持默认。
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: buildAllowedOrigins(),
      credentials: true,
      exposedHeaders: ["X-Request-Id", "X-RateLimit-Remaining"],
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  // 健康检查放在配置解析之前：探针不应依赖配置表，也不应被其失败拖慢
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", uptime: Math.round(process.uptime()) });
  });

  app.get("/readyz", async (_req, res) => {
    const checks: Record<string, boolean> = {};

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }

    checks.redis = await pingRedis();

    const ready = Object.values(checks).every(Boolean);
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "degraded", checks });
  });

  app.get("/version", (_req, res) => {
    res.json({
      name: "psdm-backend",
      version: process.env.npm_package_version ?? "1.0.0",
      env: env.NODE_ENV,
      node: process.version,
    });
  });

  // 全局解析登录态：读接口据此返回作者可见的字段，写接口各自再强制鉴权
  app.use(optionalAuth);

  // 登录态之后解析本次请求生效的在线配置（含灰度判定），
  // 业务代码通过 activeThresholds() / listEffectiveCategories() 读取
  app.use(resolveConfig);

  app.use("/api/v1", buildApiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
