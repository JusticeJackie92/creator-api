import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BecomeCreatorDto, UpsertPlanDto } from './dto/creator.dto';
import { Role } from '@prisma/client';

@Injectable()
export class CreatorsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Upgrade a verified USER account into a CREATOR (KYC starts NOT_SUBMITTED). */
  async becomeCreator(userId: string, dto: BecomeCreatorDto) {
    const existing = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    if (existing) throw new BadRequestException('Already a creator');

    const [, creator] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { role: Role.CREATOR } }),
      this.prisma.creatorProfile.create({
        data: { userId, welcomeMessage: dto.welcomeMessage, themeColor: dto.themeColor },
      }),
    ]);
    return creator;
  }

  async updateSettings(userId: string, dto: BecomeCreatorDto) {
    return this.prisma.creatorProfile.update({
      where: { userId },
      data: { welcomeMessage: dto.welcomeMessage, themeColor: dto.themeColor },
    });
  }

  /** One plan per interval; upsert keeps pricing management simple & atomic. */
  async upsertPlan(userId: string, dto: UpsertPlanDto) {
    const creator = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    if (!creator) throw new BadRequestException('Not a creator');

    return this.prisma.subscriptionPlan.upsert({
      where: { creatorId_interval: { creatorId: creator.id, interval: dto.interval } },
      create: {
        creatorId: creator.id,
        interval: dto.interval,
        priceCents: dto.priceCents,
        trialDays: dto.trialDays ?? 0,
        discountPct: dto.discountPct ?? 0,
      },
      update: {
        priceCents: dto.priceCents,
        trialDays: dto.trialDays ?? 0,
        discountPct: dto.discountPct ?? 0,
        active: true,
      },
    });
  }

  async deactivatePlan(userId: string, planId: string) {
    const creator = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    if (!creator) throw new BadRequestException('Not a creator');
    // Scoped update — creators can only touch their own plans (IDOR-safe)
    const res = await this.prisma.subscriptionPlan.updateMany({
      where: { id: planId, creatorId: creator.id },
      data: { active: false },
    });
    if (res.count === 0) throw new BadRequestException('Plan not found');
    return { message: 'Plan deactivated' };
  }

  /** A handful of active creators to suggest for discovery. */
  async discover(excludeUserId?: string, limit = 10) {
    const creators = await this.prisma.creatorProfile.findMany({
      where: {
        user: { status: 'ACTIVE', ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 20),
      select: {
        verifiedBadge: true,
        user: {
          select: {
            id: true,
            profile: { select: { username: true, displayName: true, avatarMediaId: true, bannerMediaId: true, bio: true } },
          },
        },
        plans: {
          where: { active: true },
          orderBy: { priceCents: 'asc' },
          take: 1,
          select: { priceCents: true, currency: true, interval: true },
        },
      },
    });

    return creators
      .filter((c) => c.user.profile)
      .map((c) => ({
        id: c.user.id,
        username: c.user.profile!.username,
        displayName: c.user.profile!.displayName,
        avatarMediaId: c.user.profile!.avatarMediaId,
        bannerMediaId: c.user.profile!.bannerMediaId,
        bio: c.user.profile!.bio,
        verified: c.verifiedBadge,
        fromPlan: c.plans[0] ?? null,
      }));
  }

  async myDashboard(userId: string) {
    const [subscriberCount, earnings, recentTips] = await Promise.all([
      this.prisma.subscription.count({ where: { creatorUserId: userId, status: { in: ['ACTIVE', 'TRIALING'] } } }),
      this.prisma.wallet.findUnique({ where: { userId }, select: { balanceCents: true, pendingCents: true, currency: true } }),
      this.prisma.tip.findMany({
        where: { recipientId: userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, amountCents: true, anonymous: true, message: true, createdAt: true },
      }),
    ]);
    return { subscriberCount, earnings, recentTips };
  }
}
