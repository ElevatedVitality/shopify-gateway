const express = require('express');
const router = express.Router();
const axios = require('axios');
const qs = require('qs');
const { buildPaymentSha } = require('../utils/sha');
const { pendingOrders } = require('../store'); // in-memory store

const GATEWAY_URL = 'https://ts.secure1gateway.com/api/v2/processTx';

/**
 * POST /payment
 *
 * Called by your Shopify payment UI (the iframe Shopify renders at checkout).
 * Expects card data + order data from Shopify's Payment App extension.
 *
 * Body params (sent from your Shopify checkout extension):
 *   shopify_payment_id, amount, currency, email, first_name, last_name,
 *   address, city, zip, state, country, phone,
 *   cc_number, cc_month, cc_year, cc_cvc, customer_ip, product_name
 */
router.post('/', async (req, res) => {
  try {
    const {
      shopify_payment_id,
      amount,
      currency,
      email,
      first_name,
      last_name,
      address,
      city,
      zip,
      state,
      country,
      phone,
      cc_number,
      cc_month,
      cc_year,
      cc_cvc,
      customer_ip,
      product_name,
    } = req.body;

    // Validate required fields are present
    const required = [shopify_payment_id, amount, email, cc_number, cc_month, cc_year, cc_cvc];
    if (required.some((f) => !f)) {
      return res.status(400).json({ error: 'Missing required payment fields' });
    }

    // Build SHA hash for gateway authentication
    const sha = buildPaymentSha({
      passphrase: process.env.GATEWAY_PASSPHRASE,
      amount,
      accountId: process.env.GATEWAY_ACCOUNT_ID,
      email,
      ccNumber: cc_number,
      customerIp: customer_ip || req.ip,
    });

    // Build the gateway payload
    const payload = {
      account_id: process.env.GATEWAY_ACCOUNT_ID,
      account_password: process.env.GATEWAY_PASSWORD,
      account_sha: sha,
      account_gateway: '1',
      action_type: 'payment',

      merchant_payment_id: shopify_payment_id, // must be unique per order

      cust_email: email,
      cust_billing_first_name: first_name,
      cust_billing_last_name: last_name,
      cust_billing_address: address,
      cust_billing_city: city,
      cust_billing_zipcode: zip,
      cust_billing_state: state || 'NA',
      cust_billing_country: country,
      cust_billing_phone: phone,

      transac_products_name: product_name || 'Order',
      transac_amount: amount,
      transac_currency_code: currency || 'USD',

      transac_cc_number: cc_number,
      transac_cc_month: cc_month,
      transac_cc_year: cc_year,
      transac_cc_cvc: cc_cvc,

      customer_ip: customer_ip || req.ip,

      // These are where the gateway sends the customer back after 3DS
      merchant_url_return: `${process.env.APP_URL}/return`,
      merchant_url_callback: `${process.env.APP_URL}/callback`,

      // Pass shopify payment ID through so we can recover it post-3DS
      merchant_data1: shopify_payment_id,

      option: '',
    };

    console.log(`[Payment] Initiating for order ${shopify_payment_id}, amount ${amount}`);

    const response = await axios.post(GATEWAY_URL, qs.stringify(payload), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 95000, // gateway can take up to 90s
    });

    const data = response.data;

    if (!data || !data.resp_trans_status) {
      console.error('[Payment] Empty or malformed gateway response', data);
      return res.status(502).json({ error: 'Invalid response from payment gateway' });
    }

    const status = data.resp_trans_status;

    // ── CASE 1: Payment accepted directly (no 3DS required) ──────────────────
    if (status === '00000') {
      console.log(`[Payment] Approved directly. Gateway TX: ${data.resp_trans_id}`);

      await markShopifyOrderPaid({
        shopifyPaymentId: shopify_payment_id,
        gatewayTransactionId: data.resp_trans_id,
        amount,
      });

      return res.json({
        status: 'approved',
        gateway_tx_id: data.resp_trans_id,
      });
    }

    // ── CASE 2: 3DS required — redirect customer ──────────────────────────────
    if (status === 'PEND') {
      console.log(`[Payment] 3DS required for order ${shopify_payment_id}`);

      // Store pending order so we can recover it when the customer returns
      pendingOrders.set(shopify_payment_id, {
        shopify_payment_id,
        amount,
        gateway_tx_id: data.resp_trans_id,
        createdAt: Date.now(),
      });

      // Build the redirect URL with any parameters the gateway needs
      let redirectUrl = data.UrlToRedirect;
      if (data.UrlToRedirecPostedParameters && data.UrlToRedirecPostedParameters.length > 0) {
        const params = data.UrlToRedirecPostedParameters
          .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
          .join('&');
        redirectUrl += (redirectUrl.includes('?') ? '&' : '?') + params;
      }

      return res.json({
        status: 'pending_3ds',
        redirect_url: redirectUrl,
        redirect_method: data.UrlToRedirectMethod || 'GET',
        posted_parameters: data.UrlToRedirecPostedParameters || [],
      });
    }

    // ── CASE 3: Declined ──────────────────────────────────────────────────────
    console.warn(`[Payment] Declined. Status: ${status} | Detail: ${data.resp_trans_detailled_status} | Msg: ${data.resp_trans_description_status}`);

    return res.status(402).json({
      status: 'declined',
      code: status,
      detail: data.resp_trans_detailled_status,
      message: data.resp_trans_description_status || 'Payment declined',
    });

  } catch (err) {
    console.error('[Payment] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Internal server error during payment processing' });
  }
});

/**
 * Mark an order as paid in Shopify via the Admin API
 */
async function markShopifyOrderPaid({ shopifyPaymentId, gatewayTransactionId, amount }) {
  try {
    // Shopify Payment Apps use the Payment Sessions API to resolve payments
    const shopifyApiUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/payments/apps/api/2024-01/payment_sessions/${shopifyPaymentId}/resolve`;

    await axios.post(
      shopifyApiUrl,
      { payment_session: { id: shopifyPaymentId } },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        },
      }
    );

    console.log(`[Shopify] Order ${shopifyPaymentId} marked as paid. Gateway ref: ${gatewayTransactionId}`);
  } catch (err) {
    // Log but don't crash — the callback endpoint is a fallback
    console.error('[Shopify] Failed to mark order paid:', err.response?.data || err.message);
  }
}

module.exports = { router, markShopifyOrderPaid };
