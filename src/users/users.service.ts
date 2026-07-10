import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

const ALLOWED_SOCIALS = ['twitter', 'instagram', 'tiktok', 'youtube', 'website'];

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, role: true, emailVerifiedAt: true, twoFactorEnabled: true,
        profile: true,
        creator: { select: { kycStatus: true, verifiedBadge: true } },
      },
    });
    if (!user) throw new NotFoundException();
    return user;
  }

  /** Lightweight public profile resolved by user id (for feeds & messaging). */
  async miniById(userId: string) {
    const p = await this.prisma.profile.findUnique({
      where: { userId },
      select: {
        username: true, displayName: true, avatarMediaId: true,
        user: { select: { status: true, creator: { select: { verifiedBadge: true } } } },
      },
    });
    if (!p || p.user.status !== 'ACTIVE') throw new NotFoundException('User not found');
    return {
      id: userId,
      username: p.username,
      displayName: p.displayName,
      avatarMediaId: p.avatarMediaId,
      verified: p.user.creator?.verifiedBadge ?? false,
    };
  }

  async publicProfile(username: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { username },
      select: {
        username: true, displayName: true, bio: true, location: true,
        socialLinks: true, avatarMediaId: true, bannerMediaId: true,
        user: {
          select: {
            id: true, role: true, status: true,
            creator: {
              select: {
                verifiedBadge: true, welcomeMessage: true, themeColor: true,
                plans: { where: { active: true }, select: { id: true, interval: true, priceCents: true, currency: true, trialDays: true, discountPct: true } },
              },
            },
          },
        },
      },
    });
    if (!profile || profile.user.status !== 'ACTIVE') throw new NotFoundException('Profile not found');
    return profile;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    // Whitelist + sanitize social links — only known keys, only https URLs.
    let socialLinks;
    if (dto.socialLinks) {
      socialLinks = {} as Record<string, string>;
      for (const [k, v] of Object.entries(dto.socialLinks)) {
        if (!ALLOWED_SOCIALS.includes(k)) throw new BadRequestException('Unknown social link: ' + k);
        if (typeof v !== 'string' || !/^https:\/\/[^\s]+$/.test(v) || v.length > 300) {
          throw new BadRequestException('Social links must be https URLs');
        }
        socialLinks[k] = v;
      }
    }

    // Ownership check for media references (prevents pointing at others' media)
    for (const mid of [dto.avatarMediaId, dto.bannerMediaId]) {
      if (mid) {
        const media = await this.prisma.media.findFirst({ where: { id: mid, ownerId: userId, status: 'READY' } });
        if (!media) throw new BadRequestException('Media not found or not owned by you');
      }
    }

    return this.prisma.profile.update({
      where: { userId },
      data: {
        displayName: dto.displayName,
        bio: dto.bio,
        location: dto.location,
        avatarMediaId: dto.avatarMediaId,
        bannerMediaId: dto.bannerMediaId,
        ...(socialLinks ? { socialLinks } : {}),
      },
    });
  }

  async blockUser(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) throw new BadRequestException('Cannot block yourself');
    await this.prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {},
    });
    return { message: 'User blocked' };
  }

  async unblockUser(blockerId: string, blockedId: string) {
    await this.prisma.block.deleteMany({ where: { blockerId, blockedId } });
    return { message: 'User unblocked' };
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const block = await this.prisma.block.findFirst({
      where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
    });
    return !!block;
  }

  async follow(followerId: string, followeeId: string) {
    if (followerId === followeeId) throw new BadRequestException('Cannot follow yourself');
    if (await this.isBlockedEitherWay(followerId, followeeId)) throw new BadRequestException('Unavailable');
    await this.prisma.follow.upsert({
      where: { followerId_followeeId: { followerId, followeeId } },
      create: { followerId, followeeId },
      update: {},
    });
    return { message: 'Following' };
  }

  async unfollow(followerId: string, followeeId: string) {
    await this.prisma.follow.deleteMany({ where: { followerId, followeeId } });
    return { message: 'Unfollowed' };
  }
}
