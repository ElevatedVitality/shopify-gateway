require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const app = express();

const required = [
  'GATEWAY_ACCOUNT_ID',
  'GATEWAY_PASSWORD',
  'GATEWAY_PASSPHRASE',
  'SHOPIFY_SHOP_DOMAIN',
  'SHOPIFY_ACCESS_TOKEN',
  'SHOPIFY_WEBHOOK_SECRET',
  'APP_URL',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Health check FIRST before all other routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const { router: paymentRouter } = require('./routes/payment');
const callbackRouter = require('./routes/callback');
const refundRouter = require('./routes/refund');

app.use('/payment', paymentRouter);
app.use('/callback', callbackRouter);
app.use('/return', callbackRouter);
app.use('/refund', refundRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Gateway bridge running on port ${PORT}`);
  console.log(`APP_URL: ${process.env.APP_URL}`);
  console.log(`Shopify shop: ${process.env.SHOPIFY_SHOP_DOMAIN}`);
});
