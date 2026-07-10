import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Role hierarchy guard. A higher role implicitly satisfies lower requirements
 * (SUPER_ADMIN > ADMIN > MODERATOR > CREATOR > USER).
 */
const rank: Record<Role, number> = {
  USER: 0, CREATOR: 1, MODERATOR: 2, ADMIN: 3, SUPER_ADMIN: 4,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = ctx.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException();

    const userRank = rank[user.role as Role] ?? -1;
    const ok = required.some((r) => userRank >= rank[r]);
    if (!ok) throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}
