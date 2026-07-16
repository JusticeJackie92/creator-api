import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

/**
 * Transactional email via Resend.
 * Security notes:
 *  - Links embed one-time tokens generated server-side (never guessable).
 *  - Send failures are logged but never leak whether an email exists
 *    (enumeration-safe flows are handled in AuthService).
 */
@Injectable()
export class MailService {
  private readonly resend = new Resend(process.env.RESEND_API_KEY);
  private readonly from = process.env.MAIL_FROM as string;
  private readonly appUrl = process.env.APP_URL as string;
  private readonly logger = new Logger(MailService.name);

  private async send(to: string, subject: string, html: string, text?: string) {
    try {
      await this.resend.emails.send({ from: this.from, to, subject, html, text: text ?? this.htmlToText(html) });
    } catch (err) {
      // Do not throw into user-facing flows; queue/retry in production.
      this.logger.error(`Resend send failed to ${to}: ${(err as Error).message}`);
    }
  }

  /** Very small fallback so every email always has a usable plain-text part with real, clickable-when-pasted URLs. */
  private htmlToText(html: string): string {
    return html
      .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2: $1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private layout(title: string, bodyHtml: string) {
    return `<!doctype html><html><body style="margin:0;background:#0b0b12;font-family:Inter,Arial,sans-serif;color:#e7e7ef;">
      <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
        <div style="background:#15151f;border:1px solid #23233a;border-radius:16px;padding:32px;">
          <h1 style="font-size:20px;margin:0 0 16px;color:#fff;">${title}</h1>
          ${bodyHtml}
          <p style="font-size:12px;color:#8a8aa3;margin-top:32px;">If you didn't request this, you can safely ignore this email. Never share this link with anyone — our team will never ask for it.</p>
        </div>
      </div></body></html>`;
  }

  private button(url: string, label: string) {
    // The styled button is the primary call-to-action, but some mail clients
    // (Outlook desktop, plain-text views, certain proxy image/style strippers)
    // don't render inline-block anchors reliably. Always include the raw URL
    // as visible, selectable text underneath so the link is clickable either way.
    return `<a href="${url}" style="display:inline-block;background:#6d5efc;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;">${label}</a>
      <p style="font-size:12px;color:#8a8aa3;margin-top:14px;word-break:break-all;">
        Or copy and paste this link into your browser:<br/>
        <a href="${url}" style="color:#a8a0ff;">${url}</a>
      </p>`;
  }

  async sendVerificationEmail(to: string, token: string) {
    const url = `${this.appUrl}/verify-email?token=${token}`;
    await this.send(to, 'Verify your email', this.layout(
      'Confirm your email address',
      `<p style="color:#c9c9dd;">Welcome! Click below to verify your email. This link expires in 24 hours.</p>${this.button(url, 'Verify email')}`,
    ));
  }

  async sendPasswordResetEmail(to: string, token: string) {
    const url = `${this.appUrl}/reset-password?token=${token}`;
    await this.send(to, 'Reset your password', this.layout(
      'Reset your password',
      `<p style="color:#c9c9dd;">We received a request to reset your password. This link expires in 30 minutes and can be used once.</p>${this.button(url, 'Reset password')}`,
    ));
  }

  async sendSecurityAlert(to: string, event: string, meta: { ip?: string; userAgent?: string }) {
    await this.send(to, 'Security alert on your account', this.layout(
      'Security alert',
      `<p style="color:#c9c9dd;">${event}</p>
       <p style="font-size:13px;color:#8a8aa3;">IP: ${meta.ip ?? 'unknown'}<br/>Device: ${meta.userAgent ?? 'unknown'}</p>
       <p style="color:#c9c9dd;">If this wasn't you, reset your password immediately and review your active sessions.</p>`,
    ));
  }

  async sendWelcomeEmail(to: string) {
    await this.send(to, 'Welcome aboard 🎉', this.layout(
      'Your account is ready',
      `<p style="color:#c9c9dd;">Your email is verified and your account is fully active. Explore creators, subscribe, and enjoy.</p>${this.button(this.appUrl, 'Open the app')}`,
    ));
  }
}
