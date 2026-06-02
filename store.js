/**
 * Simple in-memory store for orders pending 3DS completion.
 *
 * NOTE: This works fine for a single Railway instance.
 * If you ever scale to multiple instances, replace this with
 * a Redis store (Railway has a Redis plugin).
 *
 * Entries are cleaned up automatically after 30 minutes
 * to prevent memory buildup from abandoned checkouts.
 */
const pendingOrders = new Map();

// Clean up stale pending orders every 10 minutes
setInterval(() => {
  const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
  for (const [key, value] of pendingOrders.entries()) {
    if (value.createdAt < thirtyMinutesAgo) {
      pendingOrders.delete(key);
      console.log(`[Store] Cleaned up stale pending order: ${key}`);
    }
  }
}, 10 * 60 * 1000);

module.exports = { pendingOrders };
