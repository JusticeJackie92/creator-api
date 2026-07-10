import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MessagingService } from './messaging.service';
import { MessagingGateway } from './messaging.gateway';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { SendMessageDto, StartConversationDto } from './dto/message.dto';

@ApiTags('messages')
@ApiBearerAuth()
@Controller('messages')
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly gateway: MessagingGateway,
  ) {}

  @Post('conversations')
  start(@CurrentUser() user: AuthUser, @Body() dto: StartConversationDto) {
    return this.messaging.startConversation(user.id, dto.recipientUserId);
  }

  @Get('conversations')
  conversations(@CurrentUser() user: AuthUser) {
    return this.messaging.myConversations(user.id);
  }

  @Get('conversations/:id/meta')
  meta(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.messaging.conversationMeta(user.id, id);
  }

  @Get('conversations/:id')
  history(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('cursor') cursor?: string) {
    return this.messaging.history(user.id, id, cursor);
  }

  @Post()
  async send(@CurrentUser() user: AuthUser, @Body() dto: SendMessageDto) {
    const res = await this.messaging.sendMessage(user.id, dto);
    // Mirror the socket path so recipients get live updates + a notify ping
    // even when the message was sent over REST.
    this.gateway.emitNewMessage(dto.conversationId, res.message, res.recipientIds);
    return res;
  }

  @Post('conversations/:id/read')
  read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.messaging.markRead(user.id, id);
  }

  @Delete(':messageId/everyone')
  deleteForEveryone(@CurrentUser() user: AuthUser, @Param('messageId') messageId: string) {
    return this.messaging.deleteForEveryone(user.id, messageId);
  }

  @Patch('conversations/:id/mute')
  mute(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('muted') muted: boolean) {
    return this.messaging.setMuted(user.id, id, !!muted);
  }
}
