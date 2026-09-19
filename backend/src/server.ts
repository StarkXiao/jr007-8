import type { Server } from "node:http";
import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { initStorage } from "./services/storage";
import { disconnectPrisma } from "./db/prisma";
import { closeRedis } from "./db/redis";
import { closeQueues } from "./services/queue";
import { ensureBootstrapConfig, initConfigInvalidationSubscriber } from "./modules/config/service";

async function bootstrap(): Promise<void> {
  await initStorage();
  // 首次部署写入出厂配置 v1，并订阅跨进程的配置失效通知
  await ensureBootstrapConfig();
  initConfigInvalidationSubscriber();

  const app = createApp();
  const server: Server = app.listen(env.APP_PORT, () => {
    logger.info({ port: env.APP_PORT, env: env.NODE_ENV }, "API 服务已启动");
  });

  // 优雅退出：先停止接收新请求，再释放连接池与队列，避免写一半被强杀
  const shutdown = (signal: string) => {
    logger.info({ signal }, "收到退出信号，开始优雅关闭");

    const timer = setTimeout(() => {
      logger.error("优雅关闭超时，强制退出");
      process.exit(1);
    }, 30000);
    timer.unref();

    server.close(async () => {
      clearTimeout(timer);
      await closeQueues();
      await closeRedis();
      await disconnectPrisma();
      logger.info("已完成关闭");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((error) => {
  logger.fatal({ err: (error as Error).message }, "服务启动失败");
  process.exit(1);
});
