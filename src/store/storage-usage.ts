/** Storage-usage reporting via the StorageManager API, for the Settings screen. */
export type StorageUsage = {
  usageBytes: number;
  quotaBytes: number;
  /** 0-100, or undefined if quota is unknown/zero. */
  percent: number | undefined;
};

export async function getStorageUsage(): Promise<StorageUsage | undefined> {
  if (!navigator.storage?.estimate) return undefined;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const usageBytes = usage ?? 0;
    const quotaBytes = quota ?? 0;
    return {
      usageBytes,
      quotaBytes,
      percent: quotaBytes > 0 ? (usageBytes / quotaBytes) * 100 : undefined,
    };
  } catch {
    return undefined;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
