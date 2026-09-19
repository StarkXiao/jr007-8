import type { NextFunction, Request, Response } from "express";
import {
  bucketCookieOptions,
  CONFIG_COOKIE,
  resolveRequestContext,
  runWithConfig,
} from "../modules/appconfig/service";

/**
 * 在鉴权之后解析本次请求生效的配置（含灰度判定），并存入 AsyncLocalStorage。
 * 业务代码调用 activeThresholds() / listEffectiveCategories() 即可无感拿到
 * 带灰度视角的配置，不需要层层传参。
 *
 * 匿名用户发放持久化分桶 cookie，保证同一浏览器灰度体验稳定；
 * 响应头带上生效版本，前端可据此提示"你正在使用灰度配置"。
 */
export function resolveConfig(req: Request, res: Response, next: NextFunction): void {
  resolveRequestContext(req.user, req.cookies?.[CONFIG_COOKIE])
    .then(({ context, setCookie, bucketId }) => {
      req.config = context;
      if (setCookie) res.cookie(CONFIG_COOKIE, bucketId, bucketCookieOptions());

      res.setHeader("X-Config-Version", String(context.effectiveVersion));
      res.setHeader("X-Config-Canary", context.canary ? "1" : "0");

      runWithConfig(context, () => next());
    })
    .catch(next);
}
