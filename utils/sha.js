const crypto = require('crypto');

/**
 * Build the account_sha for a direct CC payment
 * SHA256(passphrase + amount + account_id + email + cc_number + customer_ip)
 */
function buildPaymentSha({ passphrase, amount, accountId, email, ccNumber, customerIp }) {
  const raw = `${passphrase}${amount}${accountId}${email}${ccNumber}${customerIp}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Build the account_sha for refund or adjustment
 * SHA256(passphrase + account_id + trans_id)
 */
function buildRefundSha({ passphrase, accountId, transId }) {
  const raw = `${passphrase}${accountId}${transId}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Verify the response SHA from the gateway
 * SHA256(passphrase + resp_trans_id + resp_trans_amount + resp_trans_status)
 */
function verifyResponseSha({ passphrase, respTransId, respTransAmount, respTransStatus, receivedSha }) {
  const raw = `${passphrase}${respTransId}${respTransAmount}${respTransStatus}`;
  const expected = crypto.createHash('sha256').update(raw).digest('hex');
  return expected === receivedSha;
}

module.exports = { buildPaymentSha, buildRefundSha, verifyResponseSha };
