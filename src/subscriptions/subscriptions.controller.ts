import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SubscriptionsService } from './subscriptions.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { SubscribeDto } from './dto/subscribe.dto';

@ApiTags('subscriptions')
@ApiBearerAuth()
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Post('checkout')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  checkout(@CurrentUser() user: AuthUser, @Body() dto: SubscribeDto) {
    return this.subs.startCheckout(user.id, dto);
  }

  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.subs.mySubscriptions(user.id);
  }

  @Delete(':id')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.subs.cancel(user.id, id);
  }

  @Get('billing-history')
  billing(@CurrentUser() user: AuthUser) {
    return this.subs.billingHistory(user.id);
  }
}
