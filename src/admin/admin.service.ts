import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountStatus, ReportStatus, Role } from '@prisma/client';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const [users, creators, activeSubs, revenue] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: 'CREATOR' } }),
      this.prisma.subscription.count({ where: { status: { in: ['ACTIVE', 'TRIALING'] } } }),
      this.prisma.transaction.aggregate({
        where: { status: 'SUCCEEDED' },
        _sum: { amountCents: true, feeCents: true },
      }),
    ]);
    return {
      users, creators, activeSubscriptions: activeSubs,
      grossRevenueCents: revenue._sum.amountCents ?? 0,
      platformFeesCents: revenue._sum.feeCents ?? 0,
    };
  }

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
    return this.prisma.report.update({
      where: { id: reportId },
      data: { status, resolvedById: adminId },
    });
  }

  /**
   * Ban/suspend. Guardrails:
   *  - Admins can never act on ADMIN/SUPER_ADMIN accounts (privilege escalation safety).
   *  - Banning revokes every session immediately.
   *  - Every action is audit-logged with the acting admin's id.
   */
  async setUserStatus(adminId: string, targetUserId: string, status: AccountStatus) {
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new BadRequestException('User not found');
    if (target.role === Role.ADMIN || target.role === Role.SUPER_ADMIN) {
      throw new BadRequestException('Cannot modify admin accounts through this endpoint');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: targetUserId }, data: { status } }),
      this.prisma.session.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.auditLog.create({
        data: { userId: adminId, action: 'ADMIN_SET_USER_STATUS', metadata: { targetUserId, status } },
      }),
    ]);
    return { message: 'User status set to ' + status };
  }

  async auditTrail(userId?: string) {
    return this.prisma.auditLog.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
