/**
 * Worker 入口
 *
 * fetch handler 委托给 Hono 应用（src/app.js）。
 * scheduled handler 触发定时任务执行。
 *
 */

import app from './app.js';
import { ensureMigrations } from './data/migrate.js';
import { checkExpiringSubscriptions } from './services/scheduler.js';
import type { AppEnv } from './platform/storage/storage-port.js';

export default {
  fetch: app.fetch,

  /**
   * 每小时由 Cron 触发一次。
   */
  async scheduled(event: ScheduledEvent, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    void ctx;
    const migration = await ensureMigrations(env);
    if (migration.reason === 'locked_elsewhere') throw new Error('数据迁移进行中，跳过本次定时检查');
    console.log(
      '[Workers] 定时任务触发',
      'cron:',
      event?.cron || '(unknown)',
      'UTC:',
      new Date().toISOString()
    );
    await checkExpiringSubscriptions(env);
  }
};
