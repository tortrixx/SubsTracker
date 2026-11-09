import { getKVJson, putKVJson } from './kv.js';
import type { AppEnv } from '../platform/storage/storage-port.js';

const KEY = 'categories';

export async function getCategories(env: AppEnv): Promise<string[]> {
  return (await getKVJson<string[]>(env, KEY)) || [];
}

export async function addCategory(env: AppEnv, category: string): Promise<void> {
  const trimmed = category.trim();
  if (!trimmed) return;
  const list = await getCategories(env);
  if (!list.includes(trimmed)) {
    list.push(trimmed);
    list.sort();
    await putKVJson(env, KEY, list);
  }
}
