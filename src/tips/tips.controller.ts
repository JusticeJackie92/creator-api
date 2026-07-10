import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TipsService } from './tips.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { CreateTipDto } from './dto/tip.dto';

@ApiTags('tips')
@ApiBearerAuth()
@Controller('tips')
export class TipsController {
  constructor(private readonly tips: TipsService) {}

  @Post('checkout')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CreateTipDto) {
    return this.tips.startTipCheckout(user.id, dto);
  }

  @Get('leaderboard/:creatorUserId')
  leaderboard(@Param('creatorUserId') creatorUserId: string) {
    return this.tips.leaderboard(creatorUserId);
  }

  @Get('history')
  history(@CurrentUser() user: AuthUser) {
    return this.tips.history(user.id);
  }
}
