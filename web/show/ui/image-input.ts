/**
 * 把已合成的 RGBA 像素按顺序换成独热输入批（每个像素一批）。只生成运行脚本的 batches，不执行。
 */

export function pixelsToBatches(pixels: ArrayLike<number>, count: number, { zero, one, threshold }: { zero: string; one: string; threshold: number }): string[][] {
  if (!Number.isInteger(count) || count < 1 || pixels.length < count * 4) throw new Error("像素数量无效");
  if (!zero || !one || zero === one) throw new Error("需要两个不同的独热入口");
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw new Error("灰度阈值必须为 0—255 的整数");
  return Array.from({ length: count }, (_, i) => [
    pixels[i * 4] * 0.2126 + pixels[i * 4 + 1] * 0.7152 + pixels[i * 4 + 2] * 0.0722 >= threshold ? one : zero,
  ]);
}
