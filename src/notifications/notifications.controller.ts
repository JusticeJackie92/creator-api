import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('cursor') cursor?: string) {
    return this.notifications.list(user.id, cursor);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Post('read')
  readType(@CurrentUser() user: AuthUser, @Body('type') type: NotificationType) {
    return this.notifications.markTypeRead(user.id, type);
  }
}
