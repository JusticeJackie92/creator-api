import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  @Public()
  @Get()
  async health() {
    const checks: Record<string, string> = {};
    try { await this.prisma.$queryRaw`SELECT 1`; checks.database = 'up'; } catch { checks.database = 'down'; }
    try { await this.redis.client.ping(); checks.redis = 'up'; } catch { checks.redis = 'down'; }
    const ok = Object.values(checks).every((v) => v === 'up');
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}
