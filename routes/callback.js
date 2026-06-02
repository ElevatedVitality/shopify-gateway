const express = require('express');
const router = express.Router();
const { verifyResponseSha } = require('../utils/sha');
const { markShopifyOrderPaid } = require('./payment');
const { pendingOrders } = require('../store');

/**
 * POST /callback
 *
 * Called server-to-server by the gateway after 3DS completes.
 * This is the reliable confirmation — always process payment resolution here.
 * The customer may never hit /return (tab close, network issue, etc.)
 */
router.post('/', async (req, res) => {
  try {
    const {
      resp_trans_id,
      resp_trans_merchant_id,
      resp_trans_amount,
      resp_trans_status,
      resp_trans_detailled_status,
      resp_trans_description_status,
      resp_sha,
      resp_merchant_data1, // contains shopify_payment_id we passed in merchant_data1
    } = req.body;

    console.log(`[Callback] Received for TX: ${resp_trans_id} | Status: ${resp_trans_status}`);

    // Verify the SHA to confirm this really came from the gateway
    const isValid = verifyResponseSha({
      passphrase: process.env.GATEWAY_PASSPHRASE,
      respTransId: resp_trans_id,
      respTransAmount: resp_trans_amount,
      respTransStatus: resp_trans_status,
      receivedSha: resp_sha,
    });

    if (!isValid) {
      console.error('[Callback] SHA verification failed — possible spoofed request');
      return res.status(403).json({ error: 'SHA verification failed' });
    }

    const shopifyPaymentId = resp_merchant_data1 || resp_trans_merchant_id;

    if (resp_trans_status === '00000') {
      // Payment approved after 3DS
      console.log(`[Callback] 3DS approved. Marking Shopify order ${shopifyPaymentId} as paid.`);

      await markShopifyOrderPaid({
        shopifyPaymentId,
        gatewayTransactionId: resp_trans_id,
        amount: resp_trans_amount,
      });

      pendingOrders.delete(shopifyPaymentId);

    } else {
      // 3DS failed or declined after authentication
      console.warn(`[Callback] 3DS declined. Status: ${resp_trans_status} | ${resp_trans_description_status}`);

      // Reject the Shopify payment session
      await rejectShopifyOrder({
        shopifyPaymentId,
        reason: resp_trans_description_status || 'Payment declined after 3DS',
      });

      pendingOrders.delete(shopifyPaymentId);
    }

    // Gateway expects a 200 OK — always respond quickly
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('[Callback] Error processing callback:', err.message);
    // Still return 200 so gateway doesn't retry indefinitely
    return res.status(200).json({ received: true });
  }
});

/**
 * GET /return
 *
 * Customer is redirected here by the bank after completing 3DS.
 * Do NOT rely on this for payment confirmation — use /callback.
 * Just redirect the customer to an appropriate Shopify page.
 */
router.get('/', async (req, res) => {
  const {
    resp_trans_status,
    resp_merchant_data1,
    resp_trans_description_status,
  } = req.query;

  const shopifyPaymentId = resp_merchant_data1;

  console.log(`[Return] Customer returned. Status: ${resp_trans_status} | Order: ${shopifyPaymentId}`);

  if (resp_trans_status === '00000') {
    // Redirect to Shopify thank you page
    // Shopify will show the correct confirmation once payment session is resolved
    return res.redirect(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/checkout/thank_you`);
  } else {
    // Redirect back to checkout with an error message
    const errorMsg = encodeURIComponent(resp_trans_description_status || 'Payment was not completed. Please try again.');
    return res.redirect(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/checkout?payment_error=${errorMsg}`);
  }
});

/**
 * Reject a Shopify payment session (used when 3DS fails)
 */
async function rejectShopifyOrder({ shopifyPaymentId, reason }) {
  const axios = require('axios');
  try {
    const shopifyApiUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/payments/apps/api/2024-01/payment_sessions/${shopifyPaymentId}/reject`;

    await axios.post(
      shopifyApiUrl,
      {
        payment_session: {
          id: shopifyPaymentId,
          reason: {
            code: 'card_declined',
            merchant_message: reason,
          },
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        },
      }
    );

    console.log(`[Shopify] Payment session ${shopifyPaymentId} rejected.`);
  } catch (err) {
    console.error('[Shopify] Failed to reject payment session:', err.response?.data || err.message);
  }
}

module.exports = router;
