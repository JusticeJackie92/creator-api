import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { TokenService } from './token.service';
import { generateOpaqueToken, sha256 } from '../common/utils/crypto.util';
import { RegisterDto, LoginDto, ResetPasswordDto } from './dto/auth.dto';
import { VerificationTokenType } from '@prisma/client';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

const ARGON_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
};

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const REFRESH_TTL_DAYS = 30;
const CURRENT_TERMS_VERSION = '2026-07-16'; // bump whenever /terms content materially changes

/**
 * Authentication core. Design decisions:
 *
 *  - Argon2id password hashing (OWASP-recommended parameters).
 *  - Account lockout after 5 failed attempts (15 min), with identical error
 *    messages so attackers can't distinguish "wrong password" from
 *    "account locked" from "no such account" (enumeration-safe).
 *  - Email verification & password reset tokens are single-use, expiring,
 *    and stored ONLY as SHA-256 hashes.
 *  - Refresh token ROTATION with REUSE DETECTION: every refresh invalidates
 *    the previous token. If a rotated (old) token is ever presented again,
 *    we assume theft, revoke the entire session, alert the user by email,
 *    and write an audit log entry.
 *  - Sessions are per-device rows; users can list & revoke them.
 *  - Password reset revokes ALL sessions (kills any attacker foothold).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly tokens: TokenService,
  ) {}

  // ------------------------------------------------------------ register

  async register(dto: RegisterDto, meta: RequestMeta) {
    // Belt-and-suspenders: the DTO already requires acceptedTerms === true,
    // but never create an account without an explicit, recorded acceptance.
    if (dto.acceptedTerms !== true) {
      throw new BadRequestException('You must confirm you are 18 or older and accept the Terms of Service');
    }

    const [existingEmail, existingUsername] = await Promise.all([
      this.prisma.user.findUnique({ where: { email: dto.email } }),
      this.prisma.profile.findUnique({ where: { username: dto.username } }),
    ]);
    if (existingEmail) throw new ConflictException('Email already registered');
    if (existingUsername) throw new ConflictException('Username taken');

    const passwordHash = await argon2.hash(dto.password, ARGON_OPTS);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        termsAcceptedAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
        profile: {
          create: { username: dto.username, displayName: dto.displayName },
        },
        wallet: { create: {} },
      },
    });

    await this.issueVerificationEmail(user.id, user.email);
    await this.audit(user.id, 'AUTH_REGISTER', meta, { termsVersion: CURRENT_TERMS_VERSION });

    // No tokens until email verified — reduces throwaway/bot accounts.
    return { message: 'Account created. Check your email to verify your address.' };
  }

  private async issueVerificationEmail(userId: string, email: string) {
    const raw = generateOpaqueToken(32);
    await this.prisma.verificationToken.create({
      data: {
        userId,
        tokenHash: sha256(raw),
        type: VerificationTokenType.EMAIL_VERIFICATION,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });
    await this.mail.sendVerificationEmail(email, raw);
  }

  async verifyEmail(rawToken: string) {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { user: true },
    });
    if (
      !record ||
      record.type !== VerificationTokenType.EMAIL_VERIFICATION ||
      record.usedAt ||
      record.expiresAt < new Date()
    ) {
      throw new BadRequestException('Invalid or expired verification link');
    }

    await this.prisma.$transaction([
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      }),
    ]);

    await this.mail.sendWelcomeEmail(record.user.email);
    return { message: 'Email verified. You can now log in.' };
  }

  async resendVerification(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Enumeration-safe: identical response either way.
    if (user && !user.emailVerifiedAt) {
      await this.issueVerificationEmail(user.id, user.email);
    }
    return { message: 'If that account exists and is unverified, an email was sent.' };
  }

  // ------------------------------------------------------------ login

  async login(dto: LoginDto, meta: RequestMeta) {
    const genericError = new UnauthorizedException('Invalid credentials');
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    // Always burn comparable time even when the user doesn't exist,
    // so response timing can't confirm account existence.
    if (!user || !user.passwordHash) {
      await argon2.hash(dto.password, ARGON_OPTS);
      throw genericError;
    }

    if (user.status === 'BANNED' || user.status === 'SUSPENDED') {
      throw new ForbiddenException('Account is not available');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw genericError; // do not reveal lockout state
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        },
      });
      if (lock) {
        await this.mail.sendSecurityAlert(
          user.email,
          'Your account was temporarily locked after several failed login attempts.',
          meta,
        );
        await this.audit(user.id, 'AUTH_LOCKOUT', meta);
      }
      throw genericError;
    }

    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Please verify your email before logging in');
    }

    // TODO 2FA: if user.twoFactorEnabled, return a short-lived challenge
    // token here and require TOTP via /auth/2fa/verify before session issue.

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    const session = await this.createSession(user.id, meta);
    await this.audit(user.id, 'AUTH_LOGIN', meta);

    return {
      accessToken: this.tokens.signAccessToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        sid: session.id,
      }),
      refreshToken: session.refreshToken, // set as httpOnly cookie in controller
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  private async createSession(userId: string, meta: RequestMeta) {
    const { token, hash } = this.tokens.newRefreshToken();
    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: hash,
        userAgent: meta.userAgent?.slice(0, 255),
        ipAddress: meta.ip,
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000),
      },
    });
    return { id: session.id, refreshToken: token };
  }

  // ------------------------------------------------------------ refresh (rotation + reuse detection)

  async refresh(rawRefreshToken: string, meta: RequestMeta) {
    if (!rawRefreshToken) throw new UnauthorizedException();
    const hash = this.tokens.hashRefreshToken(rawRefreshToken);

    // 1) Happy path: current token
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: true },
    });

    if (session) {
      if (session.revokedAt || session.expiresAt < new Date()) {
        throw new UnauthorizedException('Session expired');
      }
      if (session.user.status !== 'ACTIVE') {
        throw new ForbiddenException('Account is not available');
      }

      // Rotate: new refresh token replaces old; old hash kept for replay detection.
      const { token: newToken, hash: newHash } = this.tokens.newRefreshToken();
      await this.prisma.session.update({
        where: { id: session.id },
        data: {
          previousTokenHash: session.refreshTokenHash,
          refreshTokenHash: newHash,
          lastUsedAt: new Date(),
          ipAddress: meta.ip,
        },
      });

      return {
        accessToken: this.tokens.signAccessToken({
          sub: session.userId,
          email: session.user.email,
          role: session.user.role,
          sid: session.id,
        }),
        refreshToken: newToken,
      };
    }

    // 2) Reuse detection: token matches a PREVIOUS (rotated-out) token
    const replayed = await this.prisma.session.findUnique({
      where: { previousTokenHash: hash },
      include: { user: true },
    });
    if (replayed) {
      // Stolen-token replay — kill the session immediately, alert the user.
      await this.prisma.session.update({
        where: { id: replayed.id },
        data: { revokedAt: new Date() },
      });
      await this.audit(replayed.userId, 'AUTH_REFRESH_REUSE_DETECTED', meta);
      await this.mail.sendSecurityAlert(
        replayed.user.email,
        'A previously used session token was replayed. That session has been revoked as a precaution.',
        meta,
      );
    }

    throw new UnauthorizedException('Invalid refresh token');
  }

  // ------------------------------------------------------------ logout & sessions

  async logout(sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { message: 'Logged out' };
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, lastUsedAt: true, createdAt: true },
    });
    return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
  }

  async revokeSession(userId: string, sessionId: string) {
    // updateMany scoped by userId — a user can never revoke someone else's session (IDOR-safe)
    const res = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) throw new BadRequestException('Session not found');
    return { message: 'Session revoked' };
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string) {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
    return { message: 'All other sessions revoked' };
  }

  // ------------------------------------------------------------ password reset

  async forgotPassword(email: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Enumeration-safe: same response whether the account exists or not.
    if (user) {
      // Invalidate any outstanding reset tokens before issuing a new one.
      await this.prisma.verificationToken.updateMany({
        where: { userId: user.id, type: VerificationTokenType.PASSWORD_RESET, usedAt: null },
        data: { usedAt: new Date() },
      });
      const raw = generateOpaqueToken(32);
      await this.prisma.verificationToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(raw),
          type: VerificationTokenType.PASSWORD_RESET,
          expiresAt: new Date(Date.now() + 30 * 60_000), // 30 min
        },
      });
      await this.mail.sendPasswordResetEmail(user.email, raw);
      await this.audit(user.id, 'AUTH_PASSWORD_RESET_REQUESTED', meta);
    }
    return { message: 'If that account exists, a reset email was sent.' };
  }

  async resetPassword(dto: ResetPasswordDto, meta: RequestMeta) {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: sha256(dto.token) },
      include: { user: true },
    });
    if (
      !record ||
      record.type !== VerificationTokenType.PASSWORD_RESET ||
      record.usedAt ||
      record.expiresAt < new Date()
    ) {
      throw new BadRequestException('Invalid or expired reset link');
    }

    const passwordHash = await argon2.hash(dto.newPassword, ARGON_OPTS);

    await this.prisma.$transaction([
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      }),
      // Kill every session: any attacker holding a token is evicted.
      this.prisma.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.mail.sendSecurityAlert(record.user.email, 'Your password was changed. All sessions were signed out.', meta);
    await this.audit(record.userId, 'AUTH_PASSWORD_RESET', meta);
    return { message: 'Password updated. Please log in again.' };
  }

  // ------------------------------------------------------------ audit

  private async audit(userId: string | null, action: string, meta: RequestMeta, metadata?: object) {
    try {
      await this.prisma.auditLog.create({
        data: { userId, action, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 255), metadata: metadata as any },
      });
    } catch (e) {
      this.logger.warn(`Audit write failed: ${(e as Error).message}`);
    }
  }
}
