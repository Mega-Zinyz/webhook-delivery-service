class TokenBucket {
  constructor({ capacity, refillRatePerSecond }) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('Token bucket capacity must be positive');
    }
    if (!Number.isFinite(refillRatePerSecond) || refillRatePerSecond <= 0) {
      throw new Error('Token bucket refill rate must be positive');
    }

    this.capacity = capacity;
    this.refillRatePerMs = refillRatePerSecond / 1000;
    this.buckets = new Map();
  }

  take(key, now = Date.now()) {
    const bucket = this.buckets.get(key) || { tokens: this.capacity, updatedAt: now };
    const elapsedMs = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedMs * this.refillRatePerMs);
    bucket.updatedAt = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return { allowed: true, retryAt: now };
    }

    const retryAt = now + Math.ceil((1 - bucket.tokens) / this.refillRatePerMs);
    this.buckets.set(key, bucket);
    return { allowed: false, retryAt };
  }

  prune(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      const elapsedMs = Math.max(0, now - bucket.updatedAt);
      if (bucket.tokens + elapsedMs * this.refillRatePerMs >= this.capacity) {
        this.buckets.delete(key);
      }
    }
  }
}

module.exports = TokenBucket;
