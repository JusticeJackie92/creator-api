import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { generateOpaqueToken, sha256 } from '../common/utils/crypto.util';

export interface AccessPayload {
  sub: string;   // user id
  email: string;
  role: string;
  sid: string;   // session id — lets us kill live access on session revoke
}

/**
 * Token strategy:
 *  - Access token: short-lived JWT (15 min), signed HS256 with a dedicated
 *    secret. Carries session id so revocation is enforceable.
 *  - Refresh token: 256-bit opaque random value. Only its SHA-256 hash is
 *    stored (Session.refreshTokenHash). Rotated on every use.
 */
@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  signAccessToken(payload: AccessPayload): string {
    return this.jwt.sign(payload, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: '15m',
      issuer: 'creator-platform',
      audience: 'creator-platform-clients',
    });
  }

  verifyAccessToken(token: string): AccessPayload {
    return this.jwt.verify<AccessPayload>(token, {
      secret: process.env.JWT_ACCESS_SECRET,
      issuer: 'creator-platform',
      audience: 'creator-platform-clients',
    });
  }

  newRefreshToken(): { token: string; hash: string } {
    const token = generateOpaqueToken(32); // 256 bits entropy
    return { token, hash: sha256(token) };
  }

  hashRefreshToken(token: string): string {
    return sha256(token);
  }
}
