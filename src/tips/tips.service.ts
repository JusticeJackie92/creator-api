import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { CreateTipDto } from './dto/tip.dto';

@Injectable()
export class TipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  async startTipCheckout(senderId: string, dto: CreateTipDto) {
    if (senderId === dto.creatorUserId) throw new BadRequestException('Cannot tip yourself');
    const creator = await this.prisma.creatorProfile.findUnique({ where: { userId: dto.creatorUserId } });
    if (!creator) throw new NotFoundException('Creator not found');

    return this.payments.createCheckout({
      provider: dto.provider,
      kind: 'tip',
      buyerId: senderId,
      creatorUserId: dto.creatorUserId,
      amountCents: dto.amountCents,
      currency: 'USD',
      name: 'Tip',
      metadata: {
        tipMessage: dto.message ?? '',
        anonymous: dto.anonymous === true,
      },
    });
  }

  /** Leaderboard hides anonymous tippers' identities but still counts amounts. */
  async leaderboard(creatorUserId: string) {
    const rows = await this.prisma.tip.groupBy({
      by: ['senderId', 'anonymous'],
      where: { recipientId: creatorUserId },
      _sum: { amountCents: true },
      orderBy: { _sum: { amountCents: 'desc' } },
      take: 10,
    });
    const senderIds = rows.filter((r) => !r.anonymous).map((r) => r.senderId);
    const profiles = await this.prisma.profile.findMany({
      where: { userId: { in: senderIds } },
      select: { userId: true, username: true, displayName: true },
    });
    const map = new Map(profiles.map((p) => [p.userId, p]));
    return rows.map((r) => ({
      totalCents: r._sum.amountCents ?? 0,
      supporter: r.anonymous ? { anonymous: true } : map.get(r.senderId) ?? { anonymous: true },
    }));
  }

  async history(userId: string) {
    return this.prisma.tip.findMany({
      where: { OR: [{ senderId: userId }, { recipientId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, amountCents: true, currency: true, anonymous: true, message: true, createdAt: true, senderId: true, recipientId: true },
    });
  }
}
