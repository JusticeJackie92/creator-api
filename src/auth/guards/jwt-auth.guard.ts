import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { TokenService } from '../token.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Global JWT guard — every route is protected unless marked @Public().
 * Beyond signature/expiry verification we also confirm the underlying
 * session is still alive, so revoking a session kills access tokens
 * within the same request (not just after they expire).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header = req.headers['authorization'] as string | undefined;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();

    let payload;
    try {
      payload = this.tokens.verifyAccessToken(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Live session check (revocation enforcement)
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: { revokedAt: true, expiresAt: true, user: { select: { status: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session revoked');
    }
    if (session.user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account unavailable');
    }

    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      sessionId: payload.sid,
    };
    return true;
  }
}
