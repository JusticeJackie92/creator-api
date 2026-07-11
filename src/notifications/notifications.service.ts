import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import { buildCursorQuery, toCursorPage } from '../common/utils/pagination.util';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Central creation point — push (OneSignal) and email fan-out hook here later via BullMQ. */
  async notify(userId: string, type: NotificationType, title: string, body?: string, data?: object) {
    return this.prisma.notification.create({
      data: { userId, type, title, body, data: data as any },
    });
  }

  async list(userId: string, cursor?: string, take = 20) {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      ...buildCursorQuery(cursor, take),
    });
    const unreadCount = await this.prisma.notification.count({ where: { userId, readAt: null } });
    return { unreadCount, ...toCursorPage(rows, take) };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { message: 'All read' };
  }

  /** Mark one category read — e.g. NEW_MESSAGE when the user opens Messages. */
  async markTypeRead(userId: string, type: NotificationType) {
    await this.prisma.notification.updateMany({
      where: { userId, type, readAt: null },
      data: { readAt: new Date() },
    });
    const unreadCount = await this.prisma.notification.count({ where: { userId, readAt: null } });
    return { unreadCount };
  }
}
