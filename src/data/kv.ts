import type { AppEnv } from '../platform/storage/storage-port.js';

/**
 * 从存储读取 JSON 值；缺失或解析失败时返回默认值。
 * T 为调用方约定的数据形状，解析结果在系统边界处断言为 T。
 */
async function getKVJson<T>(env: AppEnv, key: string, defaultValue: T | null = null): Promise<T | null> {
  const raw = await env.SUBSCRIPTIONS_KV.get(key);
  if (!raw) return defaultValue;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed as T;
  } catch (error) {
    console.error(`[KV] 解析 ${key} 失败:`, error);
    return defaultValue;
  }
}

async function putKVJson(env: AppEnv, key: string, value: unknown): Promise<void> {
  await env.SUBSCRIPTIONS_KV.put(key, JSON.stringify(value));
}

export { getKVJson, putKVJson };
