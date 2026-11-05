/**
 * D4 暂停帧截图：captureVisibleTab → 按视频可见区域裁剪 → 缩到长边 ≤1280。
 *
 * computeCropBox 是纯函数（不碰 chrome / DOM），e2e 直接 import 做单测；
 * captureFrame 才依赖扩展 API。
 */

import { QA_MIN_VISIBLE_RATIO, type QaFrame, type QaRect, type QaViewport } from '../shared/qa';

/** 成品长边上限；再大对「这页写的什么」没有帮助，只烧 token。 */
export const FRAME_MAX_EDGE = 1280;
/** 成品 JPEG 质量（用户指定 0.88）。 */
export const FRAME_JPEG_QUALITY = 0.88;
/** captureVisibleTab 的原始截图质量，先高清截再缩。 */
export const CAPTURE_JPEG_QUALITY = 90;
/** 可见面积 / 视频面积低于该值就不带图，避免截到半张画面。 */
export const MIN_VISIBLE_RATIO = QA_MIN_VISIBLE_RATIO;

export interface BitmapSize {
  width: number;
  height: number;
}

export interface CropBox {
  /** 源图上的裁剪区域（像素）。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 缩放后的输出尺寸，长边 ≤ FRAME_MAX_EDGE。 */
  outputWidth: number;
  outputHeight: number;
}

function finite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 计算从截图中裁出视频可见区域的盒子。
 *
 * @param rect     视频元素与视口求交后的矩形（CSS 像素）
 * @param viewport 截图时的 window.innerWidth / innerHeight
 * @param bitmap   实际截图的像素尺寸（用它反推缩放比，比 devicePixelRatio 可靠）
 * @returns 裁剪 + 缩放参数；矩形无效、完全不可见或可见面积不足 50% 时返回 null
 */
export function computeCropBox(
  rect: QaRect,
  viewport: QaViewport,
  bitmap: BitmapSize,
): CropBox | null {
  if (!rect || !viewport || !bitmap) return null;
  if (
    !finite(rect.x) ||
    !finite(rect.y) ||
    !finite(rect.width) ||
    !finite(rect.height) ||
    !finite(viewport.width) ||
    !finite(viewport.height) ||
    !finite(bitmap.width) ||
    !finite(bitmap.height)
  ) {
    return null;
  }
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  if (bitmap.width <= 0 || bitmap.height <= 0) return null;

  // 与视口求交；rect 可能有一部分滚出屏幕。
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  const visibleWidth = right - left;
  const visibleHeight = bottom - top;
  if (visibleWidth <= 0 || visibleHeight <= 0) return null;

  const visibleRatio = (visibleWidth * visibleHeight) / (rect.width * rect.height);
  if (visibleRatio < MIN_VISIBLE_RATIO) return null;

  // 位图与视口不一定等比（滚动条、小数缩放），两个方向分别反推。
  const scaleX = bitmap.width / viewport.width;
  const scaleY = bitmap.height / viewport.height;

  // 往外取整，保证边缘像素不丢；再 clamp 到位图边界。
  const x0 = clamp(Math.floor(left * scaleX), 0, bitmap.width);
  const y0 = clamp(Math.floor(top * scaleY), 0, bitmap.height);
  const x1 = clamp(Math.ceil(right * scaleX), 0, bitmap.width);
  const y1 = clamp(Math.ceil(bottom * scaleY), 0, bitmap.height);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 1 || height < 1) return null;

  const longEdge = Math.max(width, height);
  const downscale = longEdge > FRAME_MAX_EDGE ? FRAME_MAX_EDGE / longEdge : 1;
  const outputWidth = Math.max(1, Math.round(width * downscale));
  const outputHeight = Math.max(1, Math.round(height * downscale));

  return { x: x0, y: y0, width, height, outputWidth, outputHeight };
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

/**
 * 截当前标签页并裁出视频画面。失败时抛错，由调用方降级成纯文本提问。
 * windowId 传 undefined 时由 Chrome 取当前窗口。
 */
export async function captureFrame(
  windowId: number | undefined,
  rect: QaRect,
  viewport: QaViewport,
  at: number,
): Promise<QaFrame> {
  let captured: string;
  try {
    captured = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: CAPTURE_JPEG_QUALITY,
    });
  } catch (error) {
    throw new Error(`截屏失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!captured.startsWith('data:image/')) {
    throw new Error('截屏没有返回图片');
  }

  const bitmap = await createImageBitmap(await (await fetch(captured)).blob());
  try {
    const crop = computeCropBox(rect, viewport, bitmap);
    if (!crop) throw new Error('视频画面没有完整显示，无法截图');

    const canvas = new OffscreenCanvas(crop.outputWidth, crop.outputHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 上下文');
    ctx.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      crop.outputWidth,
      crop.outputHeight,
    );

    const output = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: FRAME_JPEG_QUALITY,
    });
    const dataUrl = await blobToDataUrl(output);
    return {
      dataUrl,
      width: crop.outputWidth,
      height: crop.outputHeight,
      at,
    };
  } finally {
    bitmap.close();
  }
}
