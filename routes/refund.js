const express = require('express');
const router = express.Router();
const axios = require('axios');
const qs = require('qs');
const { buildRefundSha } = require('../utils/sha');
const { verifyWebhookHmac } = require('../utils/shopify');

const REFUND_URL = 'https://ts.secure1gateway.com/api/v2/processRefund';

/**
 * POST /refund
 *
 * Triggered by Shopify when a merchant issues a refund from the admin panel.
 * Shopify sends a webhook — we verify it, then call the gateway refund API.
 *
 * Shopify Refund Webhook body includes:
 *   id, order_id, amount, transactions (array with gateway transaction ID)
 */
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  // Verify this webhook is genuinely from Shopify
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const isValid = verifyWebhookHmac(req.body, hmacHeader, process.env.SHOPIFY_WEBHOOK_SECRET);

  if (!isValid) {
    console.error('[Refund] Webhook HMAC verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Extract the gateway transaction ID from the Shopify refund
  // Shopify stores the gateway reference in transactions[].authorization
  const transactions = body.transactions || [];
  const originalTx = transactions.find((t) => t.kind === 'refund' || t.kind === 'capture');
  const gatewayTransId = originalTx?.authorization || originalTx?.gateway;

  if (!gatewayTransId) {
    console.error('[Refund] Could not find gateway transaction ID in webhook payload', body);
    return res.status(400).json({ error: 'No gateway transaction ID found' });
  }

  const refundAmount = body.transactions?.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0).toFixed(2);

  console.log(`[Refund] Processing refund. Gateway TX: ${gatewayTransId} | Amount: ${refundAmount}`);

  const sha = buildRefundSha({
    passphrase: process.env.GATEWAY_PASSPHRASE,
    accountId: process.env.GATEWAY_ACCOUNT_ID,
    transId: gatewayTransId,
  });

  const payload = {
    account_id: process.env.GATEWAY_ACCOUNT_ID,
    account_password: process.env.GATEWAY_PASSWORD,
    account_sha: sha,
    trans_id: gatewayTransId,
    transac_amount: refundAmount,  // omit for full refund, included for partial
    merchant_data1: String(body.order_id),
    option: '',
  };

  try {
    const response = await axios.post(REFUND_URL, qs.stringify(payload), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });

    const data = response.data;
    const status = data?.resp_trans_status;

    if (status === 'R0000') {
      console.log(`[Refund] Success. Gateway refund TX: ${data.resp_trans_id}`);
      return res.status(200).json({ success: true, gateway_refund_id: data.resp_trans_id });
    } else {
      console.warn(`[Refund] Failed. Status: ${status} | ${data?.resp_trans_description_status}`);
      return res.status(502).json({
        error: 'Refund declined by gateway',
        code: status,
        message: data?.resp_trans_description_status,
      });
    }

  } catch (err) {
    console.error('[Refund] Gateway request failed:', err.message);
    return res.status(500).json({ error: 'Refund request failed' });
  }
});

module.exports = router;
