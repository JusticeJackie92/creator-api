import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Redis is used ONLY for ephemeral state: presence, socket sessions,
 * typing indicators, and short-lived caches. Durable data lives in Postgres.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  public readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
  }

  async setPresence(userId: string, socketId: string) {
    await this.client.sadd('presence:' + userId, socketId);
    await this.client.expire('presence:' + userId, 3600);
    await this.client.set('lastseen:' + userId, Date.now().toString());
  }

  async removePresence(userId: string, socketId: string) {
    await this.client.srem('presence:' + userId, socketId);
    await this.client.set('lastseen:' + userId, Date.now().toString());
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.client.scard('presence:' + userId)) > 0;
  }

  async lastSeen(userId: string): Promise<number | null> {
    const v = await this.client.get('lastseen:' + userId);
    return v ? Number(v) : null;
  }

  onModuleDestroy() { this.client.disconnect(); }
}
