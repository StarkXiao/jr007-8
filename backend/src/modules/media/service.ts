import { env } from "../../config/env";
import { ERROR_CODES, PUBLISHABLE_PRIVACY_STATUSES } from "../../config/constants";
import { prisma, toJsonValue } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { cachedThresholds } from "../appconfig/service";
import { getStorage } from "../../services/storage";
import {
  contentHash,
  probeImage,
  processImage,
  type BlurRegionInput,
} from "../../services/imaging";
import { detectSensitiveRegions } from "../../services/detection";
import { enqueueImageJob } from "../../services/queue";
import { logger } from "../../utils/logger";
import { isModerator } from "../../types/auth";
import type { AuthUser } from "../../types/auth";
import { IMAGE_VARIANT_NAMES } from "../shared/serialize";
import type { PrivacyStatus } from "@prisma/client";

export const PUBLISHABLE: PrivacyStatus[] = [...PUBLISHABLE_PRIVACY_STATUSES];

export function isPublishableStatus(status: PrivacyStatus): boolean {
  return PUBLISHABLE.includes(status);
}

function originalKey(uuid: string): string {
  return `${uuid}/original`;
}

function variantKey(uuid: string, variant: string): string {
  return `${uuid}/${variant}.webp`;
}

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface UploadResult {
  uuid: string;
  duplicated: boolean;
  privacyStatus: PrivacyStatus;
  width: number;
  height: number;
  variants: Record<string, string>;
}

/**
 * 上传入口只做三件必须同步完成的事：校验、落原图、投递任务。
 * 耗时的模糊化与多档渲染交给 worker，保证接口响应稳定在几百毫秒内。
 */
export async function uploadImage(file: UploadedFile, user: AuthUser): Promise<UploadResult> {
  const probe = await probeImage(file.buffer, file.mimetype);
  const hash = contentHash(file.buffer);

  // 同一用户重复上传同一张图时复用已有资源，避免重复占用存储与审核成本
  const existing = await prisma.mediaAsset.findFirst({
    where: { ownerId: user.id, contentHash: hash, originalPath: { not: null } },
  });

  if (existing) {
    return {
      uuid: existing.uuid,
      duplicated: true,
      privacyStatus: existing.privacyStatus,
      width: existing.width,
      height: existing.height,
      variants: buildVariantMap(existing.uuid, existing.variantVersion),
    };
  }

  const asset = await prisma.mediaAsset.create({
    data: {
      ownerId: user.id,
      contentHash: hash,
      originalSize: BigInt(file.size),
      originalMime: file.mimetype,
      width: probe.width,
      height: probe.height,
      privacyStatus: "processing",
      purgeAfter: new Date(Date.now() + env.ORIGINAL_RETENTION_DAYS * 86400000),
    },
    select: { uuid: true },
  });

  const storage = getStorage();
  await storage.putPrivate(originalKey(asset.uuid), file.buffer);
  await prisma.mediaAsset.update({
    where: { uuid: asset.uuid },
    data: { originalPath: originalKey(asset.uuid) },
  });

  const queued = await enqueueImageJob({ assetUuid: asset.uuid, reason: "upload" });
  if (!queued) {
    // 队列不可用时同步处理，避免图片永远停在 processing
    await processAsset(asset.uuid, "upload").catch((error) => {
      logger.error({ err: (error as Error).message, uuid: asset.uuid }, "同步处理图片失败");
    });
  }

  const fresh = await prisma.mediaAsset.findUniqueOrThrow({ where: { uuid: asset.uuid } });

  return {
    uuid: fresh.uuid,
    duplicated: false,
    privacyStatus: fresh.privacyStatus,
    width: fresh.width,
    height: fresh.height,
    variants: buildVariantMap(fresh.uuid, fresh.variantVersion),
  };
}

function buildVariantMap(uuid: string, version: number): Record<string, string> {
  const map: Record<string, string> = {};
  for (const variant of IMAGE_VARIANT_NAMES) {
    map[variant] = `/api/v1/media/${uuid}/${variant}?v=${version}`;
  }
  return map;
}

export interface ProcessOutcome {
  privacyStatus: PrivacyStatus;
  autoDetected: number;
  notes: string[];
}

/**
 * 图片处理流水线（worker 与同步降级路径共用）。
 *
 * 顺序不可调换：读原图 → 检测 → 落模糊区域 → 渲染变体 → 更新状态。
 * 每一步都从**原图**重新渲染，避免重复编辑导致模糊区域叠加失真。
 */
export async function processAsset(
  assetUuid: string,
  reason: "upload" | "blur-update" | "retry" | "privacy-reset",
): Promise<ProcessOutcome> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");

  const storage = getStorage();
  const key = asset.originalPath ?? originalKey(assetUuid);
  const original = await storage.getPrivate(key);

  const existingRegions = await prisma.blurRegion.findMany({ where: { assetId: asset.id } });
  const activeRegions = existingRegions.filter((region) => !region.ignored);

  const result = await processImage(original, activeRegions.map(toBlurInput));
  await writeVariants(assetUuid, asset.variantVersion + 1, result.variants);

  let privacyStatus: PrivacyStatus;
  let autoDetected = 0;
  const notes: string[] = [];

  if (reason === "upload" || reason === "retry") {
    const detection = await detectSensitiveRegions(result.variants.full.buffer);
    notes.push(...detection.notes);

    if (detection.boxes.length > 0) {
      // 重复处理同一张图（例如入队后又走了同步降级）时，
      // 先把上一次自动生成的区域清掉，否则会不断叠加出重复的打码块。
      await prisma.blurRegion.deleteMany({
        where: { assetId: asset.id, source: "auto" },
      });

      await prisma.blurRegion.createMany({
        data: detection.boxes.map((box) => ({
          assetId: asset.id,
          source: "auto" as const,
          algorithm: "pixelate" as const,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          label: box.label,
          confidence: box.confidence,
          strength: 14,
        })),
      });
      autoDetected = detection.boxes.length;

      // 自动检测到区域后需要按新区域重新渲染一次，确保公开版本确实被模糊
      const regions = await prisma.blurRegion.findMany({
        where: { assetId: asset.id, ignored: false },
      });
      const rendered = await processImage(original, regions.map(toBlurInput));
      await writeVariants(assetUuid, asset.variantVersion + 2, rendered.variants);
      privacyStatus = "auto_blurred";
    } else if (detection.anyAvailable) {
      // 检测器可用且未发现敏感区域，才算真正干净
      privacyStatus = "auto_clean";
    } else {
      // 没有检测能力时必须人工确认，这是不可跳过的门禁
      privacyStatus = "needs_manual";
    }
  } else {
    const manualCount = existingRegions.filter((region) => region.source === "manual").length;
    privacyStatus = manualCount > 0 ? "manual_blurred" : "auto_blurred";
  }

  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: {
      privacyStatus,
      exifStripped: true,
      detectionMeta: toJsonValue({ notes, autoDetected, processedAt: new Date().toISOString() }),
      retryCount: reason === "retry" ? { increment: 1 } : undefined,
      width: result.width,
      height: result.height,
    },
  });

  return { privacyStatus, autoDetected, notes };
}

function toBlurInput(region: {
  x: number;
  y: number;
  w: number;
  h: number;
  algorithm: string;
  strength: number;
}): BlurRegionInput {
  return {
    x: region.x,
    y: region.y,
    w: region.w,
    h: region.h,
    algorithm: region.algorithm === "gaussian" ? "gaussian" : "pixelate",
    strength: region.strength,
  };
}

async function writeVariants(
  assetUuid: string,
  version: number,
  variants: Record<string, { buffer: Buffer; width: number; height: number }>,
): Promise<void> {
  const storage = getStorage();
  const meta: Record<string, unknown> = {};

  for (const [name, variant] of Object.entries(variants)) {
    const key = variantKey(assetUuid, name);
    await storage.putPublic(key, variant.buffer);
    meta[name] = { key, bytes: variant.buffer.byteLength, width: variant.width, height: variant.height };
  }

  await prisma.mediaAsset.update({
    where: { uuid: assetUuid },
    data: { variants: toJsonValue(meta), variantVersion: version },
  });
}

export interface BlurRegionPayload {
  id?: number | string;
  source: "auto" | "manual";
  algorithm?: "pixelate" | "gaussian";
  strength?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  label?: string;
  ignored?: boolean;
  ignoreReason?: string;
}

/**
 * 覆盖式更新模糊区域。
 * 请求体描述的是"修改后的完整状态"，服务端据此增删改，
 * 避免前端需要维护复杂的差分逻辑。
 */
export async function updateBlurRegions(
  assetUuid: string,
  regions: BlurRegionPayload[],
  reason: string | undefined,
): Promise<{ privacyStatus: PrivacyStatus; regionsApplied: number }> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");

  if (!asset.originalPath) {
    throw AppError.unprocessable(
      ERROR_CODES.PRIVACY_NOT_CONFIRMED,
      "原图已按隐私策略清理，无法再编辑模糊区域。如确有问题，请下架该图片。",
    );
  }

  for (const region of regions) {
    if (region.source === "manual") {
      const valid =
        typeof region.x === "number" &&
        typeof region.y === "number" &&
        typeof region.w === "number" &&
        typeof region.h === "number" &&
        region.x >= 0 &&
        region.y >= 0 &&
        region.w > 0 &&
        region.h > 0 &&
        region.x + region.w <= 1.0001 &&
        region.y + region.h <= 1.0001;

      if (!valid) {
        throw AppError.badRequest("手动模糊区域必须位于图片范围内（归一化坐标 0–1）");
      }
    }

    if (region.ignored && !region.ignoreReason?.trim()) {
      throw AppError.badRequest("忽略自动检测区域时必须填写理由");
    }
  }

  const keepIds = regions
    .filter((region) => region.id !== undefined)
    .map((region) => BigInt(region.id as number | string));

  // 校验这些区域确实属于当前图片。
  // 少了这一步，审核员可以传别的图片的 region id 来改动它。
  if (keepIds.length > 0) {
    const owned = await prisma.blurRegion.count({
      where: { id: { in: keepIds }, assetId: asset.id },
    });
    if (owned !== keepIds.length) {
      throw AppError.badRequest("提交的模糊区域不属于这张图片");
    }
  }

  await prisma.$transaction(async (tx) => {
    // 删除本次未保留的区域
    await tx.blurRegion.deleteMany({
      where: { assetId: asset.id, id: keepIds.length > 0 ? { notIn: keepIds } : undefined },
    });

    for (const region of regions) {
      if (region.id !== undefined) {
        await tx.blurRegion.update({
          where: { id: BigInt(region.id) },
          data: {
            ignored: region.ignored ?? false,
            ignoreReason: region.ignoreReason ?? null,
            algorithm: region.algorithm ?? undefined,
            strength: region.strength ?? undefined,
          },
        });
        continue;
      }

      await tx.blurRegion.create({
        data: {
          assetId: asset.id,
          source: region.source,
          algorithm: region.algorithm ?? "pixelate",
          x: region.x ?? 0,
          y: region.y ?? 0,
          w: region.w ?? 0,
          h: region.h ?? 0,
          strength: region.strength ?? 14,
          label: region.label ?? null,
        },
      });
    }
  });

  const outcome = await processAsset(assetUuid, "blur-update");
  logger.info({ assetUuid, reason, regions: regions.length }, "模糊区域已更新并重新渲染");

  return { privacyStatus: outcome.privacyStatus, regionsApplied: regions.filter((r) => !r.ignored).length };
}

/** 审核员确认隐私处理完成——这是图片可发布的唯一出口之一 */
export async function confirmPrivacy(assetUuid: string, actorId: bigint): Promise<PrivacyStatus> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");

  if (!["auto_clean", "auto_blurred", "manual_blurred"].includes(asset.privacyStatus)) {
    throw AppError.unprocessable(
      ERROR_CODES.PRIVACY_NOT_CONFIRMED,
      `当前状态（${asset.privacyStatus}）不允许确认，请先完成模糊处理`,
    );
  }

  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { privacyStatus: "confirmed", privacyConfirmedBy: actorId, privacyConfirmedAt: new Date() },
  });

  return "confirmed";
}

export async function retryProcessing(assetUuid: string): Promise<ProcessOutcome> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");
  if (!asset.originalPath) throw AppError.badRequest("原图已清理，无法重试");
  return processAsset(assetUuid, "retry");
}

/** 隐私举报成立：删除公开变体并重置隐私状态，公开地址立即失效 */
export async function revokePublicVariants(assetUuid: string): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) return;

  const storage = getStorage();
  for (const variant of IMAGE_VARIANT_NAMES) {
    await storage.deletePublic(variantKey(assetUuid, variant)).catch(() => undefined);
  }

  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: {
      privacyStatus: "needs_manual",
      variantVersion: { increment: 1 },
      variants: {},
      privacyConfirmedBy: null,
      privacyConfirmedAt: null,
    },
  });
}

export async function getVariant(
  assetUuid: string,
  variant: string,
  viewer?: AuthUser,
): Promise<{ body: Buffer; contentType: string; publishable: boolean }> {
  if (!IMAGE_VARIANT_NAMES.includes(variant as never)) {
    throw AppError.notFound("图片尺寸不存在");
  }

  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");

  const publishable = isPublishableStatus(asset.privacyStatus);
  const privileged = viewer && (viewer.id === asset.ownerId || isModerator(viewer));

  // 未通过隐私门禁的图片只对作者与审核角色可见
  if (!publishable && !privileged) {
    throw AppError.notFound("图片不存在");
  }

  const storage = getStorage();
  const object = await storage.getPublic(variantKey(assetUuid, variant));
  return { ...object, publishable };
}

export async function signedOriginalUrl(assetUuid: string): Promise<string> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");
  if (!asset.originalPath) throw AppError.notFound("原图已按隐私策略清理");

  return getStorage().signedPrivateUrl(asset.originalPath, cachedThresholds().signedUrlTtlMs);
}

/** 签名 URL 回源读取（仅本地存储驱动需要） */
export async function readOriginalByKey(key: string): Promise<{ body: Buffer; contentType: string }> {
  const body = await getStorage().getPrivate(key);
  return { body, contentType: "application/octet-stream" };
}

export async function purgeOriginal(assetUuid: string): Promise<boolean> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset?.originalPath) return false;

  await getStorage().deletePrivate(asset.originalPath).catch(() => undefined);
  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { originalPath: null, purgeAfter: null },
  });
  return true;
}

export function assertAllPublishable(assets: Array<{ uuid: string; privacyStatus: PrivacyStatus }>): void {
  const blocked = assets.filter((asset) => !isPublishableStatus(asset.privacyStatus));
  if (blocked.length > 0) {
    throw AppError.unprocessable(
      ERROR_CODES.PRIVACY_NOT_CONFIRMED,
      `有 ${blocked.length} 张图片尚未完成隐私确认，无法通过审核。请先处理图片中的隐私区域。`,
      { assets: blocked.map((asset) => ({ uuid: asset.uuid, privacyStatus: asset.privacyStatus })) },
    );
  }
}
