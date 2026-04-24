// Regression tests for getOrderCreatedPreimage.
//
// Context: during a 2026-04-24 audit, an older copy of trade-router-mcp.mjs
// was found with a computeParamsHash() that always produced an 8-field
// preimage, even for TWAP/combo orders where the server signs an 11-field
// preimage. The resulting params_hash mismatch would make signature verification
// on order_created fail silently for 6 of the 21 tools.
//
// These tests pin the exact preimage shape per order_type so the class of bug
// cannot recur undetected.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOrderCreatedPreimage, computeParamsHash } from '../trade-router-mcp.mjs';

const base = {
  order_id: 'order-abc123',
  token_address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  slippage: 1500,
  expiry_hours: 144,
  amount: 1_000_000_000,
  holdings_percentage: 0,
};

test('sell / buy → 8-field preimage with target_bps', () => {
  const msg = { ...base, order_type: 'sell', target_bps: 10000 };
  assert.equal(
    getOrderCreatedPreimage(msg),
    'order-abc123|Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB|sell|10000|1500|144|1000000000|0'
  );
});

test('trailing_sell → 8-field preimage with trail_bps (NOT target_bps)', () => {
  const msg = { ...base, order_type: 'trailing_sell', trail_bps: 500 };
  assert.equal(
    getOrderCreatedPreimage(msg),
    'order-abc123|Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB|trailing_sell|500|1500|144|1000000000|0'
  );
});

test('limit_trailing_sell → 8-field preimage with trail_bps', () => {
  const msg = { ...base, order_type: 'limit_trailing_sell', trail_bps: 300 };
  assert.equal(
    getOrderCreatedPreimage(msg),
    'order-abc123|Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB|limit_trailing_sell|300|1500|144|1000000000|0'
  );
});

test('limit_twap_sell → 10-field preimage with target_bps|frequency|duration', () => {
  const msg = {
    ...base,
    order_type: 'limit_twap_sell',
    target_bps: 15000,
    frequency: 60,
    duration: 600,
  };
  assert.equal(
    getOrderCreatedPreimage(msg),
    'order-abc123|Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB|limit_twap_sell|15000|1500|144|1000000000|0|60|600'
  );
});

test('trailing_twap_buy → 10-field preimage with trail_bps|frequency|duration', () => {
  const msg = {
    ...base,
    order_type: 'trailing_twap_buy',
    trail_bps: 400,
    frequency: 30,
    duration: 300,
  };
  assert.equal(
    getOrderCreatedPreimage(msg),
    'order-abc123|Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB|trailing_twap_buy|400|1500|144|1000000000|0|30|300'
  );
});

test('limit_trailing_twap_sell → 11-field preimage with target_bps|trail_bps|...|freq|dur', () => {
  const msg = {
    ...base,
    order_type: 'limit_trailing_twap_sell',
    target_bps: 20000,
    trail_bps: 500,
    frequency: 60,
    duration: 900,
  };
  assert.equal(
    getOrderCreatedPreimage(msg),
    'order-abc123|Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB|limit_trailing_twap_sell|20000|500|1500|144|1000000000|0|60|900'
  );
});

test('regression: TWAP order MUST NOT use the 8-field preimage', () => {
  const msg = {
    ...base,
    order_type: 'limit_twap_sell',
    target_bps: 15000,
    frequency: 60,
    duration: 600,
  };
  const preimage = getOrderCreatedPreimage(msg);
  const fields = preimage.split('|');
  assert.equal(fields.length, 10, 'limit_twap_sell must produce exactly 10 fields');
  assert.ok(preimage.endsWith('|60|600'), 'preimage must end with |frequency|duration');
});

test('missing required field returns null (no silent partial preimage)', () => {
  assert.equal(getOrderCreatedPreimage({ ...base, order_type: 'sell' }), null, 'sell without target_bps');
  assert.equal(getOrderCreatedPreimage({ ...base, order_type: 'trailing_sell' }), null, 'trailing_sell without trail_bps');
  assert.equal(
    getOrderCreatedPreimage({ ...base, order_type: 'limit_twap_sell', target_bps: 15000 }),
    null,
    'limit_twap_sell without frequency/duration',
  );
  assert.equal(
    getOrderCreatedPreimage({ ...base, order_type: 'limit_trailing_twap_sell', target_bps: 1, trail_bps: 1, frequency: 1 }),
    null,
    'limit_trailing_twap_sell without duration',
  );
});

test('unknown order_type returns null', () => {
  assert.equal(getOrderCreatedPreimage({ ...base, order_type: 'exotic_unknown' }), null);
});

test('computeParamsHash returns a 64-char hex sha256 for a valid preimage', () => {
  const h = computeParamsHash({ ...base, order_type: 'sell', target_bps: 10000 });
  assert.match(h, /^[0-9a-f]{64}$/);
});
