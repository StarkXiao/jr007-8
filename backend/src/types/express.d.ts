import type { AuthUser } from "./auth";
import type { RequestConfigContext } from "../modules/appconfig/service";

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      user?: AuthUser;
      config?: RequestConfigContext;
    }
  }
}

export {};
