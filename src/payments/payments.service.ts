import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { generateOpaqueToken, safeEqual } from '../common/utils/crypto.util';
import { PaymentProvider, TransactionStatus, TransactionType } from '@prisma/client';

const PLATFORM_FEE_PCT = 20; // platform keeps 20%, creator receives 80%

type Kind = 'subscription' | 'purchase' | 'tip';

interface CheckoutMetadata {
  kind: Kind;
  buyerId: string;
  creatorUserId: string;
  planId?: string;
  postId?: string;
  mediaId?: string;
  tipMessage?: string;
  anonymous?: boolean;
}

/**
 * Payment core (NOWPayments + PayPal). Security decisions:
 *
 *  - Webhooks are the ONLY source of truth for money movement. Client-side
 *    "success" redirects never credit anything.
 *  - Provider-agnostic PENDING-order design: before redirecting the buyer we
 *    persist a PENDING Transaction keyed by our own opaque `orderId`, holding
 *    the fulfillment contract AND the expected amount. Providers only ever
 *    echo back that opaque id — we never trust provider-supplied metadata or
 *    prices, we look up our own record and verify the amount.
 *  - NOWPayments IPN authenticated via HMAC-SHA512 over the key-sorted JSON
 *    body (their documented scheme), compared in constant time.
 *  - PayPal webhooks verified server-to-server via PayPal's
 *    verify-webhook-signature API (certificate-based) — no shared secret to
 *    leak, no local cert parsing.
 *  - Every provider event id recorded in WebhookEvent — replays are no-ops.
 *  - A PENDING->SUCCEEDED compare-and-set inside a DB transaction guarantees
 *    each order is fulfilled at most once even under concurrent deliveries.
 *  - All amounts are integer cents; no floating-point money in our ledger.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ============================================================ checkout creation

  /**
   * Creates the PENDING order and returns a hosted checkout URL to redirect to.
   * Price is computed by callers from DB records — never from the client.
   */
  async createCheckout(args: {
    provider: PaymentProvider;
    kind: Kind;
    buyerId: string;
    creatorUserId: string;
    amountCents: number;
    currency: string;
    name: string;
    metadata: Omit<CheckoutMetadata, 'kind' | 'buyerId' | 'creatorUserId'>;
  }) {
    const orderId = generateOpaqueToken(24); // opaque, unguessable order reference
    const feeCents = Math.floor((args.amountCents * PLATFORM_FEE_PCT) / 100);

    const fullMeta: CheckoutMetadata = {
      kind: args.kind,
      buyerId: args.buyerId,
      creatorUserId: args.creatorUserId,
      ...args.metadata,
    };

    // Persist the intent BEFORE redirecting. This row is the source of truth
    // the webhook will reconcile against.
    await this.prisma.transaction.create({
      data: {
        userId: args.buyerId,
        type:
          args.kind === 'tip'
            ? TransactionType.TIP
            : args.kind === 'subscription'
              ? TransactionType.SUBSCRIPTION
              : TransactionType.PURCHASE,
        status: TransactionStatus.PENDING,
        amountCents: args.amountCents,
        feeCents,
        currency: args.currency,
        provider: args.provider,
        providerRef: orderId,
        metadata: fullMeta as any,
      },
    });

    if (args.provider === PaymentProvider.NOWPAYMENTS) {
      return this.createNowPaymentsInvoice(orderId, args.amountCents, args.currency, args.name);
    }
    return this.createPaypalOrder(orderId, args.amountCents, args.currency, args.name);
  }

  /**
   * Pay-per-view unlock. Validates the item is actually for sale, the buyer
   * isn't the owner, and it isn't already unlocked, then opens a checkout with
   * a server-computed price (never client-supplied).
   */
  async createPurchaseCheckout(
    buyerId: string,
    kind: 'post' | 'media',
    id: string,
    provider: PaymentProvider,
  ) {
    if (kind === 'post') {
      const post = await this.prisma.post.findFirst({ where: { id, status: 'PUBLISHED', deletedAt: null } });
      if (!post) throw new BadRequestException('Post not found');
      if (post.access !== 'PAY_PER_VIEW' || !post.priceCents) throw new BadRequestException('This post is not for sale');
      if (post.authorId === buyerId) throw new BadRequestException('You already own this');
      const already = await this.prisma.purchase.findFirst({ where: { buyerId, postId: id } });
      if (already) throw new BadRequestException('Already unlocked');
      return this.createCheckout({
        provider, kind: 'purchase', buyerId, creatorUserId: post.authorId,
        amountCents: post.priceCents, currency: 'USD', name: 'Unlock post', metadata: { postId: id },
      });
    }

    const media = await this.prisma.media.findUnique({ where: { id } });
    if (!media || media.deletedAt) throw new BadRequestException('Media not found');
    if (media.access !== 'PAY_PER_VIEW' || !media.priceCents) throw new BadRequestException('This media is not for sale');
    if (media.ownerId === buyerId) throw new BadRequestException('You already own this');
    const owned = await this.prisma.purchase.findFirst({ where: { buyerId, mediaId: id } });
    if (owned) throw new BadRequestException('Already unlocked');
    return this.createCheckout({
      provider, kind: 'purchase', buyerId, creatorUserId: media.ownerId,
      amountCents: media.priceCents, currency: 'USD', name: 'Unlock media', metadata: { mediaId: id },
    });
  }

  // ============================================================ NOWPayments (crypto)

  private nowApiUrl() {
    return process.env.NOWPAYMENTS_API_URL || 'https://api.nowpayments.io/v1';
  }

  private async createNowPaymentsInvoice(orderId: string, amountCents: number, currency: string, name: string) {
    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) throw new BadRequestException('NOWPayments not configured');

    const res = await fetch(`${this.nowApiUrl()}/invoice`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: amountCents / 100, // NOWPayments prices are in whole fiat units
        price_currency: currency.toLowerCase(),
        order_id: orderId,
        order_description: name.slice(0, 240),
        ipn_callback_url: `${process.env.API_URL}/api/v1/payments/webhooks/nowpayments`,
        success_url: `${process.env.APP_URL}/payments/success`,
        cancel_url: `${process.env.APP_URL}/payments/cancel`,
      }),
    });

    if (!res.ok) {
      this.logger.error(`NOWPayments invoice failed: ${res.status} ${await res.text()}`);
      throw new BadRequestException('Could not start crypto checkout');
    }
    const data: any = await res.json();
    return { provider: 'NOWPAYMENTS', checkoutUrl: data.invoice_url as string, orderId };
  }

  /**
   * NOWPayments IPN signature: HMAC-SHA512 of the request body re-serialized
   * with keys sorted recursively (their documented ksort + json_encode flow),
   * using the IPN secret. Verified in constant time.
   */
  verifyNowPaymentsSignature(rawBody: Buffer, signature: string): boolean {
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (!secret) throw new BadRequestException('NOWPayments IPN not configured');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return false;
    }
    const sorted = JSON.stringify(this.sortDeep(parsed));
    const expected = createHmac('sha512', secret).update(sorted).digest('hex');
    return safeEqual(expected, signature ?? '');
  }

  private sortDeep(value: any): any {
    if (Array.isArray(value)) return value.map((v) => this.sortDeep(v));
    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((acc: Record<string, any>, k) => {
          acc[k] = this.sortDeep(value[k]);
          return acc;
        }, {});
    }
    return value;
  }

  async handleNowPaymentsEvent(body: any) {
    const status = String(body?.payment_status ?? '');
    const orderId = String(body?.order_id ?? '');

    // Only settled payments trigger fulfillment. 'finished' = fully paid &
    // settled; 'confirmed' = confirmed on-chain. Intermediate states are ack'd
    // without consuming the idempotency slot.
    if (status !== 'finished' && status !== 'confirmed') {
      return { received: true, status };
    }
    if (!orderId) return { received: true, ignored: 'no order_id' };

    const eventId = `np:${body?.payment_id ?? orderId}`;
    if (!(await this.markEventOnce(PaymentProvider.NOWPAYMENTS, eventId))) {
      return { received: true, duplicate: true };
    }

    // Verify the amount the buyer was invoiced for matches our record.
    const reportedCents = Math.round(Number(body?.price_amount ?? 0) * 100);
    await this.fulfillOrder(orderId, reportedCents);
    return { received: true };
  }

  // ============================================================ PayPal

  private paypalBase() {
    return process.env.PAYPAL_ENV === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  }

  private async paypalAccessToken(): Promise<string> {
    const id = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_CLIENT_SECRET;
    if (!id || !secret) throw new BadRequestException('PayPal not configured');
    const auth = Buffer.from(`${id}:${secret}`).toString('base64');
    const res = await fetch(`${this.paypalBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new BadRequestException('PayPal auth failed');
    const data: any = await res.json();
    return data.access_token as string;
  }

  private async createPaypalOrder(orderId: string, amountCents: number, currency: string, name: string) {
    const token = await this.paypalAccessToken();
    const res = await fetch(`${this.paypalBase()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: orderId, // echoed back on capture — our reconciliation key
            description: name.slice(0, 127),
            amount: { currency_code: currency.toUpperCase(), value: (amountCents / 100).toFixed(2) },
          },
        ],
        application_context: {
          brand_name: 'Creator Platform',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${process.env.APP_URL}/payments/success`,
          cancel_url: `${process.env.APP_URL}/payments/cancel`,
        },
      }),
    });
    if (!res.ok) {
      this.logger.error(`PayPal order failed: ${res.status} ${await res.text()}`);
      throw new BadRequestException('Could not start PayPal checkout');
    }
    const data: any = await res.json();
    const approve = (data.links ?? []).find((l: any) => l.rel === 'approve')?.href;
    return { provider: 'PAYPAL', checkoutUrl: approve as string, orderId };
  }

  private async capturePaypalOrder(paypalOrderId: string) {
    const token = await this.paypalAccessToken();
    const res = await fetch(`${this.paypalBase()}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    // A 422 typically means already captured — safe to ignore, fulfillment is
    // idempotent and driven by the capture webhook.
    if (!res.ok && res.status !== 422) {
      this.logger.warn(`PayPal capture ${paypalOrderId} returned ${res.status}`);
    }
  }

  /**
   * Verify a PayPal webhook by asking PayPal to validate the transmission
   * signature against the raw event and our configured webhook id. This is
   * certificate-based and needs no shared secret in our environment.
   */
  async verifyPaypalWebhook(headers: Record<string, any>, rawBody: Buffer): Promise<boolean> {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) throw new BadRequestException('PayPal webhook not configured');
    let event: unknown;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return false;
    }
    const token = await this.paypalAccessToken();
    const res = await fetch(`${this.paypalBase()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });
    if (!res.ok) return false;
    const data: any = await res.json();
    return data.verification_status === 'SUCCESS';
  }

  async handlePaypalEvent(body: any) {
    const type = String(body?.event_type ?? '');
    const eventId = String(body?.id ?? '');

    // Order approved by the buyer -> capture it server-side. Fulfillment is
    // deferred to the resulting PAYMENT.CAPTURE.COMPLETED event so there is a
    // single fulfillment path.
    if (type === 'CHECKOUT.ORDER.APPROVED') {
      const paypalOrderId = String(body?.resource?.id ?? '');
      if (paypalOrderId) await this.capturePaypalOrder(paypalOrderId);
      return { received: true };
    }

    if (type === 'PAYMENT.CAPTURE.COMPLETED') {
      if (!eventId || !(await this.markEventOnce(PaymentProvider.PAYPAL, eventId))) {
        return { received: true, duplicate: true };
      }
      const orderId = String(body?.resource?.custom_id ?? '');
      const reportedCents = Math.round(Number(body?.resource?.amount?.value ?? 0) * 100);
      if (orderId) await this.fulfillOrder(orderId, reportedCents);
      return { received: true };
    }

    return { received: true, ignored: type };
  }

  // ============================================================ fulfillment

  /**
   * Reconcile a settled payment against our PENDING order and grant access.
   * Uses a compare-and-set on status so an order is fulfilled exactly once.
   */
  private async fulfillOrder(orderId: string, reportedCents: number) {
    const pending = await this.prisma.transaction.findUnique({ where: { providerRef: orderId } });
    if (!pending) {
      this.logger.warn(`Fulfillment: no order for ref ${orderId}`);
      return;
    }
    if (pending.status === TransactionStatus.SUCCEEDED) return; // already done

    // Defense in depth: never grant more than what was actually invoiced.
    // Allow a 1-cent rounding tolerance for crypto fiat conversion.
    if (reportedCents > 0 && Math.abs(reportedCents - pending.amountCents) > 1) {
      this.logger.error(
        `Amount mismatch on ${orderId}: reported ${reportedCents} vs expected ${pending.amountCents}`,
      );
      return;
    }

    const m = (pending.metadata ?? {}) as unknown as CheckoutMetadata;
    const creatorCents = pending.amountCents - pending.feeCents;

    await this.prisma.$transaction(async (tx) => {
      // Compare-and-set: only the first delivery flips PENDING -> SUCCEEDED.
      const claimed = await tx.transaction.updateMany({
        where: { id: pending.id, status: TransactionStatus.PENDING },
        data: { status: TransactionStatus.SUCCEEDED },
      });
      if (claimed.count === 0) return; // lost the race; another delivery won

      if (m.creatorUserId) {
        await tx.wallet.upsert({
          where: { userId: m.creatorUserId },
          create: { userId: m.creatorUserId, pendingCents: creatorCents },
          update: { pendingCents: { increment: creatorCents } },
        });
      }

      if (m.kind === 'subscription' && m.planId) {
        const plan = await tx.subscriptionPlan.findUnique({ where: { id: m.planId } });
        if (plan) {
          const months = plan.interval === 'MONTHLY' ? 1 : plan.interval === 'QUARTERLY' ? 3 : 12;
          // Extend from the later of now / existing period end (idempotent-ish top-up).
          const existing = await tx.subscription.findUnique({
            where: { subscriberId_creatorUserId: { subscriberId: m.buyerId, creatorUserId: m.creatorUserId } },
          });
          const base = existing && existing.currentPeriodEnd > new Date() ? existing.currentPeriodEnd : new Date();
          const periodEnd = new Date(base);
          periodEnd.setMonth(periodEnd.getMonth() + months);

          await tx.subscription.upsert({
            where: { subscriberId_creatorUserId: { subscriberId: m.buyerId, creatorUserId: m.creatorUserId } },
            create: {
              subscriberId: m.buyerId,
              creatorUserId: m.creatorUserId,
              planId: plan.id,
              status: 'ACTIVE',
              provider: pending.provider,
              currentPeriodEnd: periodEnd,
            },
            update: { status: 'ACTIVE', planId: plan.id, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false },
          });
        }
      }

      if (m.kind === 'purchase' && (m.postId || m.mediaId)) {
        await tx.purchase.create({
          data: {
            buyerId: m.buyerId,
            type: m.postId ? 'POST' : 'MEDIA',
            postId: m.postId || null,
            mediaId: m.mediaId || null,
            amountCents: pending.amountCents,
            currency: pending.currency,
            provider: pending.provider,
            providerRef: orderId,
          },
        });
      }

      if (m.kind === 'tip') {
        await tx.tip.create({
          data: {
            senderId: m.buyerId,
            recipientId: m.creatorUserId,
            amountCents: pending.amountCents,
            currency: pending.currency,
            anonymous: m.anonymous === true,
            message: m.tipMessage ? m.tipMessage.slice(0, 500) : null,
            provider: pending.provider,
            providerRef: orderId,
          },
        });
      }
    });
  }

  /** Idempotency: record event id once; false means we've seen it before. */
  private async markEventOnce(provider: PaymentProvider, eventId: string): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({ data: { provider, eventId } });
      return true;
    } catch {
      return false; // unique violation => duplicate delivery
    }
  }
}
