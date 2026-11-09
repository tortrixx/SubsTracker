/**
 * StoragePort —— 存储端口（Port）
 *
 * 项目的全部持久化访问都收敛到这一个接口上，它恰好是 Cloudflare
 * KVNamespace 使用的子集（get / put / delete / list），因此：
 *
 * - 在 Cloudflare Workers 上，env.SUBSCRIPTIONS_KV 本身就是该端口的
 *   一个现成实现（适配器 = 平台绑定，零代码）；
 * - 在自有服务器上，由 sqlite-storage.ts（SQLite 数据库）或
 *   memory-storage.ts（进程内存，仅开发/测试）实现同一接口，
 *   作为可替换的存储插件注入组合根（src/server.ts）。
 *
 * 业务代码（src/data、src/services、src/api）只依赖本接口，
 * 不感知底层是 KV 还是 SQLite —— 换存储只换组合根的装配。
 *
 * 语义约定（与 Cloudflare KV 对齐）：
 * - get(key) 返回字符串或 null；get(key, { type: 'json' }) 返回
 *   JSON.parse 后的值（解析失败时与 KV 一样抛错，由调用方处理）。
 * - put(key, value, { expirationTtl }) 的 TTL 单位为秒；省略表示永不过期。
 * - list({ prefix, cursor, limit }) 按 key 字典序升序返回
 *   { keys: [{ name }], list_complete, cursor }；cursor 为不透明字符串，
 *   list_complete 为 true 时不再返回 cursor。
 * - 过期键在任何读路径上都不可见（惰性过期即可）。
 */
export interface StorageListResult {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

export interface StoragePort {
  get(key: string, options?: { type?: string }): Promise<any>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<StorageListResult>;
}

/** 运行时环境对象：全项目统一的 env 形状（Workers 绑定与 Node 装配同形）。 */
export interface AppEnv {
  SUBSCRIPTIONS_KV: StoragePort;
  ENVIRONMENT?: string;
  [key: string]: unknown;
}
