import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { SubscribeDto } from './dto/subscribe.dto';

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  /** Price is ALWAYS computed server-side from the plan — never client-supplied. */
  async startCheckout(buyerId: string, dto: SubscribeDto) {
    const plan = await this.prisma.subscriptionPlan.findFirst({
      where: { id: dto.planId, active: true },
      include: { creator: { select: { userId: true, user: { select: { profile: { select: { displayName: true } } } } } } },
    });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.creator.userId === buyerId) throw new BadRequestException('Cannot subscribe to yourself');

    const existing = await this.prisma.subscription.findUnique({
      where: { subscriberId_creatorUserId: { subscriberId: buyerId, creatorUserId: plan.creator.userId } },
    });
    if (existing && ['ACTIVE', 'TRIALING'].includes(existing.status) && existing.currentPeriodEnd > new Date()) {
      throw new BadRequestException('Already subscribed');
    }

    const discounted = Math.round(plan.priceCents * (1 - plan.discountPct / 100));

    // Buys one interval of access. Provider (NOWPayments crypto or PayPal) is
    // selected by the client; fulfillment is identical either way.
    return this.payments.createCheckout({
      provider: dto.provider,
      kind: 'subscription',
      buyerId,
      creatorUserId: plan.creator.userId,
      amountCents: discounted,
      currency: plan.currency,
      name: 'Subscription — ' + (plan.creator.user.profile?.displayName ?? 'Creator') + ' (' + plan.interval + ')',
      metadata: { planId: plan.id },
    });
  }

  async mySubscriptions(userId: string) {
    return this.prisma.subscription.findMany({
      where: { subscriberId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        plan: { select: { interval: true, priceCents: true, currency: true } },
      },
    });
  }

  async cancel(userId: string, subscriptionId: string) {
    // Cancel at period end — access remains until what was paid for expires.
    const res = await this.prisma.subscription.updateMany({
      where: { id: subscriptionId, subscriberId: userId, status: { in: ['ACTIVE', 'TRIALING'] } },
      data: { cancelAtPeriodEnd: true },
    });
    if (res.count === 0) throw new NotFoundException('Subscription not found');
    return { message: 'Subscription will end at the current period end' };
  }

  async billingHistory(userId: string) {
    return this.prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, type: true, status: true, amountCents: true, currency: true, provider: true, createdAt: true },
    });
  }
}
