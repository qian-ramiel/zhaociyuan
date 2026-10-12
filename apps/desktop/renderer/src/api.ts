import { apiError, cleanError, requestHeaders } from '../../errors.mjs';
import { createRuntimeReporter } from '../../runtime-reporter.mjs';

let issueStorage: Storage | undefined;
try { issueStorage = window.localStorage; } catch {}
export const runtimeReporter = createRuntimeReporter(issueStorage, (issue) => api('/api/runtime/issues', 'POST', issue));

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (window.desktop) { try { return await window.desktop.api<T>(path, { method, body }); } catch (error) { throw new Error(cleanError(error)); } }
  const response = await fetch(path, { method, headers: requestHeaders(body), body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(apiError(result.detail));
  return result;
}

export async function upload<T>(path: string, file: Blob, name: string, fields: Record<string, string> = {}): Promise<T> {
  if (window.desktop) { try { return await window.desktop.upload<T>(path, new Uint8Array(await file.arrayBuffer()), name, file.type, fields); } catch (error) { throw new Error(cleanError(error)); } }
  const form = new FormData();
  form.append('file', file, name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await fetch(path, { method: 'POST', body: form });
  const result = await response.json();
  if (!response.ok) throw new Error(apiError(result.detail, '上传失败'));
  return result;
}

export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function screenPixels(imageData: string) {
  const image = new Image();
  image.src = imageData;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 24;
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0, 24, 24);
  image.removeAttribute('src');
  return context.getImageData(0, 0, 24, 24).data;
}
export function pixelDifference(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 0.75 * 255);
}
