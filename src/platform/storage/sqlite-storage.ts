/**
 * SqliteStorage —— StoragePort 的 SQLite 实现（服务器存储插件）。
 *
 * 仅供 Node 组合根（src/server.ts）使用，基于 Node 内置 node:sqlite，
 * 无第三方原生依赖。本文件不得被 Workers 入口的模块图引用。
 *
 * 表结构：kv(key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)
 * - expires_at 为毫秒时间戳，NULL 表示永不过期；读路径惰性过滤。
 * - list 用 substr 前缀匹配 + key 升序 + offset 游标，语义与 KV 对齐。
 */

import { DatabaseSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';
import type { StoragePort } from './storage-port.js';

/** kv 表一行的最小形状（node:sqlite 返回宽松的行对象，在此边界处收窄）。 */
interface KvValueRow {
  value: unknown;
  expires_at: number | null;
}

interface KvKeyRow {
  key: unknown;
}

export type SqliteStorage = StoragePort & { close: () => void };

/** @param options SQLite 文件路径（目录需已存在或可创建） */
export function createSqliteStorage({ path }: { path: string }): SqliteStorage {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)'
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv(expires_at)');

  const stmtGet = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?');
  const stmtPut = db.prepare(
    'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
  );
  const stmtDelete = db.prepare('DELETE FROM kv WHERE key = ?');
  const stmtList = db.prepare(
    'SELECT key FROM kv WHERE substr(key, 1, ?) = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key ASC LIMIT ? OFFSET ?'
  );

  function isLive(row: KvValueRow | undefined): boolean {
    return !!row && (row.expires_at === null || row.expires_at > Date.now());
  }

  return {
    async get(key, options) {
      const row = stmtGet.get(key) as KvValueRow | undefined;
      if (!isLive(row)) {
        if (row) stmtDelete.run(key);
        return null;
      }
      // isLive 已排除 undefined，这里收窄给下面的取值用
      const liveRow = row as KvValueRow;
      if (options && options.type === 'json') return JSON.parse(String(liveRow.value));
      return String(liveRow.value);
    },
    async put(key, value, options) {
      const ttl = options && options.expirationTtl;
      const expiresAt = ttl ? Date.now() + Number(ttl) * 1000 : null;
      stmtPut.run(key, String(value), expiresAt);
    },
    async delete(key) {
      stmtDelete.run(key);
    },
    async list(options = {}) {
      const prefix = options.prefix || '';
      const limit = Math.min(1000, Math.max(1, options.limit || 1000));
      const offset = options.cursor
        ? Number(Buffer.from(options.cursor, 'base64').toString('utf8')) || 0
        : 0;
      // 多取一行判断是否还有下一页
      const rows = stmtList.all(prefix.length, prefix, Date.now(), limit + 1, offset) as unknown as KvKeyRow[];
      const page = rows.slice(0, limit);
      const complete = rows.length <= limit;
      return {
        keys: page.map((r) => ({ name: String(r.key) })),
        list_complete: complete,
        ...(complete
          ? {}
          : { cursor: Buffer.from(String(offset + limit), 'utf8').toString('base64') })
      };
    },
    close() {
      db.close();
    }
  };
}
