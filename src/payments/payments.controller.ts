import { BadRequestException, Body, Controller, Headers, HttpCode, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PaymentProvider } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

function parseProvider(value: unknown): PaymentProvider {
  if (value === 'NOWPAYMENTS' || value === 'PAYPAL') return value;
  throw new BadRequestException('provider must be NOWPAYMENTS or PAYPAL');
}

/**
 * Webhook endpoints are @Public (providers can't send JWTs) but every request
 * is authenticated cryptographically before we act on it:
 *   - NOWPayments: HMAC-SHA512 over the key-sorted raw body (x-nowpayments-sig).
 *   - PayPal: server-to-server signature verification against PayPal's API.
 * Both read the RAW body captured by the app's rawBody option.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @ApiBearerAuth()
  @Post('purchase/post/:postId')
  unlockPost(
    @CurrentUser() user: AuthUser,
    @Param('postId') postId: string,
    @Body('provider') provider: string,
  ) {
    return this.payments.createPurchaseCheckout(user.id, 'post', postId, parseProvider(provider));
  }

  @ApiBearerAuth()
  @Post('purchase/media/:mediaId')
  unlockMedia(
    @CurrentUser() user: AuthUser,
    @Param('mediaId') mediaId: string,
    @Body('provider') provider: string,
  ) {
    return this.payments.createPurchaseCheckout(user.id, 'media', mediaId, parseProvider(provider));
  }

  @Public()
  @Post('webhooks/nowpayments')
  @HttpCode(200)
  async nowPaymentsWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-nowpayments-sig') signature: string,
  ) {
    if (!signature || !req.rawBody) throw new BadRequestException('Missing signature');
    if (!this.payments.verifyNowPaymentsSignature(req.rawBody, signature)) {
      throw new BadRequestException('Invalid signature');
    }
    return this.payments.handleNowPaymentsEvent(JSON.parse(req.rawBody.toString('utf8')));
  }

  @Public()
  @Post('webhooks/paypal')
  @HttpCode(200)
  async paypalWebhook(@Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, any>) {
    if (!req.rawBody) throw new BadRequestException('Missing body');
    const ok = await this.payments.verifyPaypalWebhook(headers, req.rawBody);
    if (!ok) throw new BadRequestException('Invalid signature');
    return this.payments.handlePaypalEvent(JSON.parse(req.rawBody.toString('utf8')));
  }
}
