const express = require('express');
const router = express.Router();
const axios = require('axios');
const qs = require('qs');
const { buildPaymentSha } = require('../utils/sha');
const { pendingOrders } = require('../store');

const GATEWAY_URL = 'https://ts.secure1gateway.com/api/v2/processTx';

router.post('/', async (req, res) => {
  try {
    const {
      shopify_order_id,
      shopify_order_token,
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
    } = req.body;

    const required = [shopify_order_id, amount, email, cc_number, cc_month, cc_year, cc_cvc];
    if (required.some((f) => !f)) {
      return res.status(400).json({ error: 'Missing required payment fields' });
    }

    const merchantPaymentId = `EV-${shopify_order_id}-${Date.now()}`;
    const clientIp = customer_ip || req.headers['x-forwarded-for'] || req.ip;

    const sha = buildPaymentSha({
      passphrase: process.env.GATEWAY_PASSPHRASE,
      amount,
      accountId: process.env.GATEWAY_ACCOUNT_ID,
      email,
      ccNumber: cc_number,
      customerIp: clientIp,
    });

    const payload = {
      account_id:           process.env.GATEWAY_ACCOUNT_ID,
      account_password:     process.env.GATEWAY_PASSWORD,
      account_sha:          sha,
      account_gateway:      '1',
      action_type:          'payment',
      merchant_payment_id:  merchantPaymentId,
      cust_email:           email,
      cust_billing_first_name: first_name,
      cust_billing_last_name:  last_name,
      cust_billing_address:    address,
      cust_billing_city:       city,
      cust_billing_zipcode:    zip,
      cust_billing_state:      state || 'NA',
      cust_billing_country:    country || 'US',
      cust_billing_phone:      phone,
      transac_products_name:   'Elevated Vitality — Research Peptides',
      transac_amount:          parseFloat(amount).toFixed(2),
      transac_currency_code:   currency || 'USD',
      transac_cc_number:       cc_number,
      transac_cc_month:        cc_month,
      transac_cc_year:         cc_year,
      transac_cc_cvc:          cc_cvc,
      customer_ip:             clientIp,
      merchant_url_return:     `${process.env.APP_URL}/return`,
      merchant_url_callback:   `${process.env.APP_URL}/callback`,
      merchant_data1:          shopify_order_id,
      merchant_data2:          shopify_order_token,
      option: '',
    };

    console.log(`[Payment] Order ${shopify_order_id} | Amount $${amount} | ${email}`);

    const response = await axios.post(GATEWAY_URL, qs.stringify(payload), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 95000,
    });

    const data = response.data;

    if (!data || !data.resp_trans_status) {
      console.error('[Payment] Empty gateway response', data);
      return res.status(502).json({ error: 'Invalid response from payment gateway' });
    }

    const status = data.resp_trans_status;

    // Approved directly
    if (status === '00000') {
      console.log(`[Payment] Approved. Gateway TX: ${data.resp_trans_id}`);
      await markShopifyOrderPaid({ shopifyOrderId: shopify_order_id, gatewayTransactionId: data.resp_trans_id, amount });
      return res.json({ status: 'approved', gateway_tx_id: data.resp_trans_id });
    }

    // 3DS required
    if (status === 'PEND') {
      console.log(`[Payment] 3DS required for order ${shopify_order_id}`);
      pendingOrders.set(merchantPaymentId, {
        shopify_order_id,
        shopify_order_token,
        amount,
        gateway_tx_id: data.resp_trans_id,
        createdAt: Date.now(),
      });

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

    // Declined
    console.warn(`[Payment] Declined. Status: ${status} | ${data.resp_trans_description_status}`);
    return res.status(402).json({
      status: 'declined',
      code: status,
      message: data.resp_trans_description_status || 'Payment declined. Please check your card details.',
    });

  } catch (err) {
    console.error('[Payment] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error during payment processing' });
  }
});

async function markShopifyOrderPaid({ shopifyOrderId, gatewayTransactionId, amount }) {
  try {
    const axios = require('axios');
    await axios.post(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/orders/${shopifyOrderId}/transactions.json`,
      {
        transaction: {
          kind: 'capture',
          status: 'success',
          amount: amount,
          authorization: gatewayTransactionId,
          gateway: 'Elevated Vitality Gateway',
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        },
      }
    );
    console.log(`[Shopify] Order ${shopifyOrderId} marked paid. Gateway ref: ${gatewayTransactionId}`);
  } catch (err) {
    console.error('[Shopify] Failed to mark order paid:', err.response?.data || err.message);
  }
}

module.exports = { router, markShopifyOrderPaid };
