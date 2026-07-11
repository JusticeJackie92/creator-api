import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import {
  RegisterDto, LoginDto, VerifyEmailDto, ForgotPasswordDto, ResetPasswordDto,
} from './dto/auth.dto';

const REFRESH_COOKIE = 'rt';

/**
 * Refresh tokens travel ONLY in a signed httpOnly, Secure cookie scoped to the
 * refresh path — inaccessible to JS (XSS-hardened). In production the web app
 * and API are on different domains, so the cookie must be SameSite=None (with
 * Secure) to be sent cross-site; locally we keep Lax over http.
 */
const CROSS_SITE = process.env.NODE_ENV === 'production';

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: CROSS_SITE,
    sameSite: CROSS_SITE ? 'none' : 'lax',
    signed: true,
    path: '/api/v1/auth/refresh',
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, {
    path: '/api/v1/auth/refresh',
    sameSite: CROSS_SITE ? 'none' : 'lax',
    secure: CROSS_SITE,
  });
}

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { ttl: 3600_000, limit: 5 } }) // 5 signups/hour/IP
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, meta(req));
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Public()
  @Throttle({ default: { ttl: 3600_000, limit: 3 } })
  @Post('resend-verification')
  @HttpCode(200)
  resendVerification(@Body() dto: ForgotPasswordDto) {
    return this.auth.resendVerification(dto.email);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 5 } }) // brute-force throttle
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto, meta(req));
    setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate refresh token (cookie) and mint a new access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.signedCookies?.[REFRESH_COOKIE] as string) ?? '';
    const result = await this.auth.refresh(raw, meta(req));
    setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiBearerAuth()
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    clearRefreshCookie(res);
    return this.auth.logout(user.sessionId);
  }

  @Public()
  @Throttle({ default: { ttl: 3600_000, limit: 5 } })
  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.auth.forgotPassword(dto.email, meta(req));
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.auth.resetPassword(dto, meta(req));
  }

  // ------------- device sessions -------------

  @Get('sessions')
  @ApiBearerAuth()
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.id, user.sessionId);
  }

  @Delete('sessions/:id')
  @ApiBearerAuth()
  revokeSession(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.auth.revokeSession(user.id, id);
  }

  @Delete('sessions')
  @ApiBearerAuth()
  revokeAll(@CurrentUser() user: AuthUser) {
    return this.auth.revokeAllSessions(user.id, user.sessionId);
  }
}
