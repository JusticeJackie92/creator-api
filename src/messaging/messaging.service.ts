import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SendMessageDto } from './dto/message.dto';
import { buildCursorQuery, toCursorPage } from '../common/utils/pagination.util';

@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Membership check — every read/write is scoped to conversations the caller belongs to. */
  async assertParticipant(conversationId: string, userId: string) {
    const p = await this.prisma.participant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!p) throw new ForbiddenException('Not a participant of this conversation');
    return p;
  }

  async startConversation(userId: string, recipientUserId: string) {
    if (userId === recipientUserId) throw new BadRequestException('Cannot message yourself');
    if (await this.users.isBlockedEitherWay(userId, recipientUserId)) {
      throw new ForbiddenException('Messaging unavailable');
    }
    const recipient = await this.prisma.user.findFirst({ where: { id: recipientUserId, status: 'ACTIVE' } });
    if (!recipient) throw new NotFoundException('User not found');

    // Reuse existing 1:1 conversation if present
    const existing = await this.prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId } } },
          { participants: { some: { userId: recipientUserId } } },
        ],
      },
    });
    if (existing) return existing;

    return this.prisma.conversation.create({
      data: { participants: { create: [{ userId }, { userId: recipientUserId }] } },
    });
  }

  async sendMessage(senderId: string, dto: SendMessageDto) {
    await this.assertParticipant(dto.conversationId, senderId);
    if (!dto.body && (!dto.mediaIds || dto.mediaIds.length === 0)) {
      throw new BadRequestException('Message needs text or media');
    }

    // Block check against the other participant
    const others = await this.prisma.participant.findMany({
      where: { conversationId: dto.conversationId, userId: { not: senderId } },
    });
    for (const other of others) {
      if (await this.users.isBlockedEitherWay(senderId, other.userId)) {
        throw new ForbiddenException('Messaging unavailable');
      }
    }

    // Media ownership check
    if (dto.mediaIds?.length) {
      const owned = await this.prisma.media.count({
        where: { id: { in: dto.mediaIds }, ownerId: senderId, status: 'READY' },
      });
      if (owned !== dto.mediaIds.length) throw new ForbiddenException('Invalid media attachment');
    }

    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId: dto.conversationId,
          senderId,
          body: dto.body,
          mediaIds: dto.mediaIds ?? [],
          replyToId: dto.replyToId ?? null,
        },
      }),
      this.prisma.conversation.update({
        where: { id: dto.conversationId },
        data: { lastMessageAt: new Date() },
      }),
    ]);
    // Persist a notification for each recipient so it shows on the bell even
    // if they're offline. Fire-and-forget: never fail the send over this.
    const senderName = (await this.users.miniById(senderId).catch(() => null))?.displayName ?? 'Someone';
    const preview = dto.body?.slice(0, 80) || 'Sent you media';
    await Promise.allSettled(
      others.map((o) =>
        this.notifications.notify(
          o.userId,
          NotificationType.NEW_MESSAGE,
          `New message from ${senderName}`,
          preview,
          { conversationId: dto.conversationId },
        ),
      ),
    );

    return { message, recipientIds: others.map((o) => o.userId) };
  }

  async history(userId: string, conversationId: string, cursor?: string, take = 30) {
    await this.assertParticipant(conversationId, userId);
    const rows = await this.prisma.message.findMany({
      where: { conversationId, deletedForAll: false },
      orderBy: { createdAt: 'desc' },
      ...buildCursorQuery(cursor, take),
    });
    return toCursorPage(rows, take);
  }

  /** The other participant's identity + whether they're a creator (for the chat header & tipping). */
  async conversationMeta(userId: string, conversationId: string) {
    await this.assertParticipant(conversationId, userId);
    const other = await this.prisma.participant.findFirst({
      where: { conversationId, userId: { not: userId } },
      select: { userId: true },
    });
    if (!other) return { conversationId, other: null };
    const p = await this.prisma.profile.findUnique({
      where: { userId: other.userId },
      select: {
        username: true, displayName: true, avatarMediaId: true,
        user: { select: { creator: { select: { verifiedBadge: true } } } },
      },
    });
    return {
      conversationId,
      other: p
        ? {
            id: other.userId,
            username: p.username,
            displayName: p.displayName,
            avatarMediaId: p.avatarMediaId,
            verified: p.user.creator?.verifiedBadge ?? false,
            isCreator: !!p.user.creator,
          }
        : null,
    };
  }

  async myConversations(userId: string) {
    return this.prisma.participant.findMany({
      where: { userId, deletedAt: null },
      orderBy: { conversation: { lastMessageAt: 'desc' } },
      include: {
        conversation: {
          include: {
            participants: {
              where: { userId: { not: userId } },
              include: { user: { select: { id: true, profile: { select: { username: true, displayName: true, avatarMediaId: true } } } } },
            },
            messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });
  }

  async markRead(userId: string, conversationId: string) {
    await this.assertParticipant(conversationId, userId);
    await this.prisma.participant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    });
    await this.prisma.message.updateMany({
      where: { conversationId, senderId: { not: userId }, status: { not: 'SEEN' } },
      data: { status: 'SEEN' },
    });
    return { message: 'Read' };
  }

  /** Delete for everyone — only the sender, only within 1 hour. */
  async deleteForEveryone(userId: string, messageId: string) {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg || msg.senderId !== userId) throw new ForbiddenException();
    if (Date.now() - msg.createdAt.getTime() > 3600_000) {
      throw new BadRequestException('Can only delete for everyone within 1 hour');
    }
    await this.prisma.message.update({
      where: { id: messageId },
      data: { deletedForAll: true, body: null, mediaIds: [] },
    });
    return { message: 'Deleted for everyone' };
  }

  async setMuted(userId: string, conversationId: string, muted: boolean) {
    await this.assertParticipant(conversationId, userId);
    await this.prisma.participant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { muted },
    });
    return { message: muted ? 'Muted' : 'Unmuted' };
  }
}
