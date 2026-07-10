import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AccountStatus, Prisma, ReportStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildCursorQuery, toCursorPage } from '../common/utils/pagination.util';
import { AdminCreateUserDto, AdminUpdateUserDto } from './dto/admin.dto';

const ARGON_OPTS: argon2.Options = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 };

// Privilege ordering used to stop an admin from acting above their level.
const RANK: Record<Role, number> = { USER: 0, CREATOR: 1, MODERATOR: 2, ADMIN: 3, SUPER_ADMIN: 4 };

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  private log(adminId: string, action: string, metadata: Record<string, unknown>) {
    return this.prisma.auditLog.create({ data: { userId: adminId, action, metadata: metadata as Prisma.JsonObject } });
  }

  /** Stops privilege escalation: you can only act on accounts strictly below your rank. */
  private assertCanAct(acting: { role: Role }, target: { role: Role }) {
    if (RANK[acting.role] <= RANK[target.role]) {
      throw new ForbiddenException('You cannot modify an account at or above your role');
    }
  }

  private assertCanAssign(acting: { role: Role }, role: Role) {
    if (RANK[role] >= RANK[acting.role]) {
      throw new ForbiddenException('You cannot assign a role at or above your own');
    }
  }

  // ----------------------------------------------------------------- overview
  async overview() {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [users, creators, activeSubs, posts, pendingReports, newUsers, revenue] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: 'CREATOR' } }),
      this.prisma.subscription.count({ where: { status: { in: ['ACTIVE', 'TRIALING'] } } }),
      this.prisma.post.count({ where: { deletedAt: null } }),
      this.prisma.report.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
      this.prisma.user.count({ where: { createdAt: { gte: since } } }),
      this.prisma.transaction.aggregate({ where: { status: 'SUCCEEDED' }, _sum: { amountCents: true, feeCents: true } }),
    ]);
    return {
      users, creators, activeSubscriptions: activeSubs, posts, pendingReports, newUsers7d: newUsers,
      grossRevenueCents: revenue._sum.amountCents ?? 0,
      platformFeesCents: revenue._sum.feeCents ?? 0,
    };
  }

  // -------------------------------------------------------------------- users
  async listUsers(params: { query?: string; role?: Role; status?: AccountStatus; cursor?: string }) {
    const where: Prisma.UserWhereInput = {};
    if (params.role) where.role = params.role;
    if (params.status) where.status = params.status;
    if (params.query) {
      where.OR = [
        { email: { contains: params.query, mode: 'insensitive' } },
        { profile: { username: { contains: params.query, mode: 'insensitive' } } },
        { profile: { displayName: { contains: params.query, mode: 'insensitive' } } },
      ];
    }
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        profile: { select: { username: true, displayName: true, avatarMediaId: true } },
        creator: { select: { verifiedBadge: true } },
        _count: { select: { posts: true } },
      },
      ...buildCursorQuery(params.cursor, 25),
    });
    const page = toCursorPage(rows, 25);
    return {
      items: page.items.map((u) => ({
        id: u.id, email: u.email, role: u.role, status: u.status,
        emailVerified: !!u.emailVerifiedAt, createdAt: u.createdAt,
        username: u.profile?.username, displayName: u.profile?.displayName,
        avatarMediaId: u.profile?.avatarMediaId, verified: u.creator?.verifiedBadge ?? false,
        isCreator: !!u.creator, postCount: u._count.posts,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async getUser(id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      include: {
        profile: true,
        creator: { include: { plans: true } },
        wallet: true,
        _count: { select: { posts: true, subscriptions: true, media: true } },
      },
    });
    if (!u) throw new NotFoundException('User not found');
    const { passwordHash, twoFactorSecretEnc, ...safe } = u;
    return safe;
  }

  async createUser(acting: AuthActor, dto: AdminCreateUserDto) {
    const role = dto.role ?? Role.USER;
    this.assertCanAssign(acting, role);

    const email = dto.email.toLowerCase();
    const username = dto.username.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new BadRequestException('Email already in use');
    if (await this.prisma.profile.findUnique({ where: { username } })) throw new BadRequestException('Username already taken');

    const passwordHash = await argon2.hash(dto.password, ARGON_OPTS);
    const isCreator = role === Role.CREATOR;
    const user = await this.prisma.user.create({
      data: {
        email, passwordHash, role,
        emailVerifiedAt: dto.emailVerified === false ? null : new Date(),
        profile: { create: { username, displayName: dto.displayName } },
        ...(isCreator ? { creator: { create: { kycStatus: 'APPROVED' } }, wallet: { create: {} } } : {}),
      },
      include: { profile: true },
    });
    await this.log(acting.id, 'ADMIN_CREATE_USER', { targetUserId: user.id, role });
    return { id: user.id, email: user.email, role: user.role, username: user.profile?.username };
  }

  async updateUser(acting: AuthActor, id: string, dto: AdminUpdateUserDto) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User not found');
    if (target.id !== acting.id) this.assertCanAct(acting, target);

    if (dto.role && dto.role !== target.role) this.assertCanAssign(acting, dto.role);
    if (dto.email) {
      const clash = await this.prisma.user.findFirst({ where: { email: dto.email.toLowerCase(), id: { not: id } } });
      if (clash) throw new BadRequestException('Email already in use');
    }
    if (dto.username) {
      const clash = await this.prisma.profile.findFirst({ where: { username: dto.username.toLowerCase(), userId: { not: id } } });
      if (clash) throw new BadRequestException('Username already taken');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: {
          email: dto.email?.toLowerCase(),
          role: dto.role,
          emailVerifiedAt: dto.emailVerified === undefined ? undefined : dto.emailVerified ? new Date() : null,
        },
      }),
      this.prisma.profile.update({
        where: { userId: id },
        data: {
          displayName: dto.displayName,
          username: dto.username?.toLowerCase(),
          bio: dto.bio,
        },
      }),
      this.log(acting.id, 'ADMIN_UPDATE_USER', { targetUserId: id, changes: dto as Prisma.JsonObject }),
    ]);
    return { message: 'User updated' };
  }

  async setUserStatus(acting: AuthActor, targetUserId: string, status: AccountStatus) {
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('User not found');
    this.assertCanAct(acting, target);

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: targetUserId }, data: { status } }),
      this.prisma.session.updateMany({ where: { userId: targetUserId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.log(acting.id, 'ADMIN_SET_USER_STATUS', { targetUserId, status }),
    ]);
    return { message: `User status set to ${status}` };
  }

  async setUserRole(acting: AuthActor, targetUserId: string, role: Role) {
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('User not found');
    this.assertCanAct(acting, target);
    this.assertCanAssign(acting, role);

    // Promoting to creator needs a creator profile + wallet.
    const needsCreator = role === Role.CREATOR && !(await this.prisma.creatorProfile.findUnique({ where: { userId: targetUserId } }));
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: targetUserId }, data: { role } }),
      ...(needsCreator
        ? [
            this.prisma.creatorProfile.create({ data: { userId: targetUserId, kycStatus: 'APPROVED' } }),
            this.prisma.wallet.upsert({ where: { userId: targetUserId }, create: { userId: targetUserId }, update: {} }),
          ]
        : []),
      this.log(acting.id, 'ADMIN_SET_USER_ROLE', { targetUserId, role }),
    ]);
    return { message: `Role set to ${role}` };
  }

  async makeCreator(acting: AuthActor, targetUserId: string, verified?: boolean) {
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, include: { creator: true } });
    if (!target) throw new NotFoundException('User not found');
    this.assertCanAct(acting, target);

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: targetUserId }, data: { role: Role.CREATOR } }),
      this.prisma.creatorProfile.upsert({
        where: { userId: targetUserId },
        create: { userId: targetUserId, kycStatus: 'APPROVED', verifiedBadge: !!verified },
        update: { verifiedBadge: verified ?? undefined },
      }),
      this.prisma.wallet.upsert({ where: { userId: targetUserId }, create: { userId: targetUserId }, update: {} }),
      this.log(acting.id, 'ADMIN_MAKE_CREATOR', { targetUserId, verified: !!verified }),
    ]);
    return { message: 'User is now a creator' };
  }

  async setVerifiedBadge(acting: AuthActor, targetUserId: string, verified: boolean) {
    const creator = await this.prisma.creatorProfile.findUnique({ where: { userId: targetUserId } });
    if (!creator) throw new BadRequestException('User is not a creator');
    await this.prisma.creatorProfile.update({ where: { userId: targetUserId }, data: { verifiedBadge: verified } });
    await this.log(acting.id, 'ADMIN_SET_VERIFIED', { targetUserId, verified });
    return { message: verified ? 'Verified badge granted' : 'Verified badge removed' };
  }

  async resetPassword(acting: AuthActor, targetUserId: string, password: string) {
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('User not found');
    if (target.id !== acting.id) this.assertCanAct(acting, target);
    const passwordHash = await argon2.hash(password, ARGON_OPTS);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: targetUserId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } }),
      this.prisma.session.updateMany({ where: { userId: targetUserId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.log(acting.id, 'ADMIN_RESET_PASSWORD', { targetUserId }),
    ]);
    return { message: 'Password reset; all sessions revoked' };
  }

  async deleteUser(acting: AuthActor, targetUserId: string) {
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('User not found');
    this.assertCanAct(acting, target);
    try {
      await this.prisma.user.delete({ where: { id: targetUserId } });
      await this.log(acting.id, 'ADMIN_DELETE_USER', { targetUserId, email: target.email });
      return { message: 'User permanently deleted' };
    } catch {
      // Records the app keeps (transactions, etc.) can block a hard delete.
      throw new BadRequestException('This user has records that prevent deletion. Ban or suspend the account instead.');
    }
  }

  // ---------------------------------------------------------------- moderation
  async listPosts(cursor?: string) {
    const rows = await this.prisma.post.findMany({
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { id: true, profile: { select: { username: true, displayName: true } } } } },
      ...buildCursorQuery(cursor, 25),
    });
    const page = toCursorPage(rows, 25);
    return {
      items: page.items.map((p) => ({
        id: p.id, body: p.body, access: p.access, priceCents: p.priceCents,
        likeCount: p.likeCount, commentCount: p.commentCount, createdAt: p.createdAt,
        deleted: !!p.deletedAt,
        author: { id: p.author.id, username: p.author.profile?.username, displayName: p.author.profile?.displayName },
      })),
      nextCursor: page.nextCursor,
    };
  }

  async deletePost(acting: AuthActor, postId: string) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.prisma.post.update({ where: { id: postId }, data: { deletedAt: new Date(), status: 'DELETED' } });
    await this.log(acting.id, 'ADMIN_REMOVE_POST', { postId, authorId: post.authorId });
    return { message: 'Post removed' };
  }

  // ------------------------------------------------------------------- finance
  async listTransactions(cursor?: string) {
    const rows = await this.prisma.transaction.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true, profile: { select: { username: true } } } } },
      ...buildCursorQuery(cursor, 30),
    });
    const page = toCursorPage(rows, 30);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  // ------------------------------------------------------------------- reports
  async listReports(status?: ReportStatus) {
    return this.prisma.report.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        reporter: { select: { id: true, email: true } },
        reportedUser: { select: { id: true, email: true, status: true } },
      },
    });
  }

  async resolveReport(adminId: string, reportId: string, status: ReportStatus) {
    await this.prisma.report.update({ where: { id: reportId }, data: { status, resolvedById: adminId } });
    await this.log(adminId, 'ADMIN_RESOLVE_REPORT', { reportId, status });
    return { message: 'Report updated' };
  }

  async auditTrail(userId?: string) {
    return this.prisma.auditLog.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}

interface AuthActor { id: string; role: Role }
