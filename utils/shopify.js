const crypto = require('crypto');

/**
 * Verify that a request actually came from Shopify
 * Used on the payment initiation endpoint
 */
function verifyShopifyHmac(query, secret) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

/**
 * Verify Shopify webhook payload integrity
 */
function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');
  return digest === hmacHeader;
}

module.exports = { verifyShopifyHmac, verifyWebhookHmac };
