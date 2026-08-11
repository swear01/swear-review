import { Webhooks } from '@octokit/webhooks';
import type { Logger } from '../util/logger.js';

/**
 * Webhook signature verification. GitHub signs each delivery with
 * `x-hub-signature-256` (HMAC-SHA256 of the raw body using the webhook secret).
 */
export class WebhookVerifier {
  private webhooks: Webhooks;

  constructor(secret: string) {
    this.webhooks = new Webhooks({ secret });
  }

  /** Verifies the raw body against the signature header. Throws on mismatch. */
  async verify(rawBody: string, signature: string | undefined): Promise<void> {
    if (!signature) {
      throw new Error('Missing x-hub-signature-256 header');
    }
    const valid = await this.webhooks.verify(rawBody, signature);
    if (!valid) {
      throw new Error('Invalid webhook signature');
    }
  }
}
