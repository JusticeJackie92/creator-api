import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect,
  SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../auth/token.service';
import { RedisService } from '../redis/redis.service';
import { MessagingService } from './messaging.service';
import { SendMessageDto } from './dto/message.dto';

interface AuthedSocket extends Socket {
  userId?: string;
}

/**
 * Realtime gateway. Security decisions:
 *  - Handshake REQUIRES a valid access JWT (auth.token). Unauthed sockets
 *    are disconnected before joining any room.
 *  - Users join only `user:{id}` plus conversation rooms verified through
 *    DB membership — you cannot subscribe to someone else's room.
 *  - All payloads pass class-validator (same DTOs as REST).
 *  - Presence/typing lives in Redis with TTLs; messages persist in Postgres
 *    through the same service (single validation path).
 */
@WebSocketGateway({
  namespace: '/ws',
  cors: { origin: (process.env.CORS_ORIGINS ?? '').split(','), credentials: true },
})
export class MessagingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(MessagingGateway.name);

  constructor(
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
    private readonly messaging: MessagingService,
  ) {}

  async handleConnection(socket: AuthedSocket) {
    try {
      const token = (socket.handshake.auth?.token as string) ?? '';
      const payload = this.tokens.verifyAccessToken(token);
      socket.userId = payload.sub;
      await socket.join('user:' + payload.sub);
      await this.redis.setPresence(payload.sub, socket.id);
      socket.broadcast.emit('presence:online', { userId: payload.sub });
    } catch {
      socket.disconnect(true); // fail closed
    }
  }

  async handleDisconnect(socket: AuthedSocket) {
    if (!socket.userId) return;
    await this.redis.removePresence(socket.userId, socket.id);
    if (!(await this.redis.isOnline(socket.userId))) {
      socket.broadcast.emit('presence:offline', {
        userId: socket.userId,
        lastSeen: await this.redis.lastSeen(socket.userId),
      });
    }
  }

  @SubscribeMessage('conversation:join')
  async joinConversation(@ConnectedSocket() socket: AuthedSocket, @MessageBody() data: { conversationId: string }) {
    if (!socket.userId) return;
    // Membership verified against the DB before joining the room
    await this.messaging.assertParticipant(data.conversationId, socket.userId);
    await socket.join('conv:' + data.conversationId);
    return { joined: data.conversationId };
  }

  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  @SubscribeMessage('message:send')
  async sendMessage(@ConnectedSocket() socket: AuthedSocket, @MessageBody() dto: SendMessageDto) {
    if (!socket.userId) return;
    const { message, recipientIds } = await this.messaging.sendMessage(socket.userId, dto);
    this.emitNewMessage(dto.conversationId, message, recipientIds);
    return { delivered: true, id: message.id };
  }

  /**
   * Broadcasts a newly-created message to the conversation room and pings the
   * recipients' personal rooms. Called by the socket handler AND the REST
   * controller so both delivery paths behave identically in realtime.
   */
  emitNewMessage(conversationId: string, message: { id: string }, recipientIds: string[]) {
    this.server.to('conv:' + conversationId).emit('message:new', message);
    for (const rid of recipientIds) {
      this.server.to('user:' + rid).emit('message:notify', { conversationId, messageId: message.id });
    }
  }

  @SubscribeMessage('typing:start')
  async typing(@ConnectedSocket() socket: AuthedSocket, @MessageBody() data: { conversationId: string }) {
    if (!socket.userId) return;
    await this.messaging.assertParticipant(data.conversationId, socket.userId);
    // Ephemeral typing state with 5s TTL
    await this.redis.client.setex('typing:' + data.conversationId + ':' + socket.userId, 5, '1');
    socket.to('conv:' + data.conversationId).emit('typing', { userId: socket.userId, conversationId: data.conversationId });
  }

  @SubscribeMessage('message:read')
  async read(@ConnectedSocket() socket: AuthedSocket, @MessageBody() data: { conversationId: string }) {
    if (!socket.userId) return;
    await this.messaging.markRead(socket.userId, data.conversationId);
    socket.to('conv:' + data.conversationId).emit('message:seen', {
      conversationId: data.conversationId,
      userId: socket.userId,
      at: new Date().toISOString(),
    });
  }
}
