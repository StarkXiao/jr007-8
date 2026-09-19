import { cachedThresholds } from "../modules/appconfig/service";

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function parsePagination(query: { page?: unknown; pageSize?: unknown }): Pagination {
  // 分页上限是在线可配置的业务阈值；同步读取进程缓存即可，无需每个列表请求 await
  const { defaultPageSize, maxPageSize } = cachedThresholds();
  const rawPage = Number(query.page ?? 1);
  const rawSize = Number(query.pageSize ?? defaultPageSize);

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.min(Math.floor(rawSize), maxPageSize) : defaultPageSize;

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function pagedResult<T>(items: T[], total: number, pagination: Pagination) {
  return {
    items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
  };
}
