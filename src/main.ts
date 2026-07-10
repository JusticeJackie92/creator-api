import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

/**
 * Bootstrap with a security-first posture:
 *  - Helmet security headers (CSP, HSTS, no-sniff, frame-deny)
 *  - Strict whitelist-based CORS (no wildcard with credentials)
 *  - Global validation: whitelist + forbidNonWhitelisted (mass-assignment safe)
 *  - Raw body preserved ONLY for payment webhooks (signature verification)
 *  - Signed httpOnly cookies for refresh tokens
 *  - Sanitized error responses (no stack traces / internals leak)
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // required to verify NOWPayments/PayPal webhook signatures
    logger: ['error', 'warn', 'log'],
  });

  app.set('trust proxy', 1); // correct client IPs behind reverse proxy
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'https://res.cloudinary.com', 'data:'],
          mediaSrc: ["'self'", 'https://res.cloudinary.com'],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    }),
  );

  app.use(cookieParser(process.env.COOKIE_SECRET));

  const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS: origin not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,            // strip unknown properties
      forbidNonWhitelisted: true, // reject payloads with unexpected fields
      transform: true,
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_SWAGGER === 'true') {
    const config = new DocumentBuilder()
      .setTitle('Creator Platform API')
      .setDescription('Secure creator monetization platform')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  Logger.log('API listening on :' + port, 'Bootstrap');
}
bootstrap();
