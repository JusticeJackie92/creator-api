import { plainToInstance } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUrl, MinLength, validateSync } from 'class-validator';

enum NodeEnv { development = 'development', production = 'production', test = 'test' }

/**
 * Fail-fast environment validation. The app refuses to boot with weak or
 * missing secrets — no silent fallbacks to insecure defaults.
 */
class EnvVars {
  @IsEnum(NodeEnv) NODE_ENV!: NodeEnv;
  @IsOptional() @IsInt() PORT?: number;

  @IsString() DATABASE_URL!: string;
  @IsString() REDIS_URL!: string;

  @IsString() @MinLength(32) JWT_ACCESS_SECRET!: string;
  @IsString() @MinLength(32) JWT_REFRESH_SECRET!: string;
  @IsString() @MinLength(32) COOKIE_SECRET!: string;
  @IsString() @MinLength(32) ENCRYPTION_KEY!: string; // AES-256 key material

  @IsString() CORS_ORIGINS!: string;
  @IsUrl({ require_tld: false }) APP_URL!: string;

  @IsString() RESEND_API_KEY!: string;
  @IsString() MAIL_FROM!: string;

  @IsString() CLOUDINARY_CLOUD_NAME!: string;
  @IsString() CLOUDINARY_API_KEY!: string;
  @IsString() CLOUDINARY_API_SECRET!: string;

  // Public base URL of THIS API — used to build webhook callback URLs.
  @IsUrl({ require_tld: false }) API_URL!: string;

  // Payments are optional at boot; required only for live checkout.
  // NOWPayments (crypto)
  @IsOptional() @IsString() NOWPAYMENTS_API_KEY?: string;
  @IsOptional() @IsString() NOWPAYMENTS_IPN_SECRET?: string;
  @IsOptional() @IsString() NOWPAYMENTS_API_URL?: string;
  // PayPal
  @IsOptional() @IsString() PAYPAL_CLIENT_ID?: string;
  @IsOptional() @IsString() PAYPAL_CLIENT_SECRET?: string;
  @IsOptional() @IsString() PAYPAL_WEBHOOK_ID?: string;
  @IsOptional() @IsString() PAYPAL_ENV?: string; // 'sandbox' | 'live'
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvVars, config, { enableImplicitConversion: true });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(
      'Environment validation failed:\n' +
        errors
          .map((e) => '  - ' + e.property + ': ' + Object.values(e.constraints ?? {}).join(', '))
          .join('\n'),
    );
  }
  return validated;
}
