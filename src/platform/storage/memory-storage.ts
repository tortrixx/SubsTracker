/**
 * MemoryStorage —— StoragePort 的进程内存实现。
 *
 * 用途：本地开发、契约检查（scripts/check-storage.mjs）、单元测试。
 * 数据随进程退出丢失，禁止用于生产。
 */

import { Buffer } from 'node:buffer';
import type { StoragePort } from './storage-port.js';

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

export function createMemoryStorage(): StoragePort {
  const map = new Map<string, MemoryEntry>();

  function live(key: string): MemoryEntry | null {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      map.delete(key);
      return null;
    }
    return entry;
  }

  return {
    async get(key, options) {
      const entry = live(key);
      if (!entry) return null;
      if (options && options.type === 'json') return JSON.parse(entry.value);
      return entry.value;
    },
    async put(key, value, options) {
      const ttl = options && options.expirationTtl;
      map.set(key, {
        value: String(value),
        expiresAt: ttl ? Date.now() + Number(ttl) * 1000 : null
      });
    },
    async delete(key) {
      map.delete(key);
    },
    async list(options = {}) {
      const prefix = options.prefix || '';
      const limit = Math.min(1000, Math.max(1, options.limit || 1000));
      const offset = options.cursor ? Number(Buffer.from(options.cursor, 'base64').toString('utf8')) || 0 : 0;
      const names = [...map.keys()].filter((k) => live(k) && k.startsWith(prefix)).sort();
      const page = names.slice(offset, offset + limit);
      const complete = offset + limit >= names.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        ...(complete ? {} : { cursor: Buffer.from(String(offset + limit), 'utf8').toString('base64') })
      };
    }
  };
}
