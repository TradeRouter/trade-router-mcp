#!/usr/bin/env node
/**
 * traderouter.ai MCP Server (JavaScript)
 * Solana swap & limit order engine — REST + persistent WebSocket
 *
 * Equivalent to trader_mcp.py. Same tools, same auth flow, same
 * server_signature verification logic as the website examples.
 *
 * Barebone setup (minimum required):
 *   pnpm add @modelcontextprotocol/sdk @solana/web3.js bs58 tweetnacl ws node-fetch
 *
 * Run (stdio transport, for Claude Desktop / claude-code):
 *   TRADEROUTER_PRIVATE_KEY=<base58> node traderouter-mcp.mjs
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "traderouter": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/traderouter-mcp.mjs"],
 *         "env": { "TRADEROUTER_PRIVATE_KEY": "YOUR_KEY" }
 *       }
 *     }
 *   }
 */

import { Server }       from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { Keypair, Connection } from '@solana/web3.js';
import { VersionedTransaction } from '@solana/web3.js';
import bs58   from 'bs58';
import nacl   from 'tweetnacl';
import WebSocket from 'ws';
import { createHash } from 'crypto';

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE   = 'https://api.traderouter.ai';
const WS_URL     = 'wss://api.traderouter.ai/ws';
const RPC_URL    = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const PRIVATE_KEY_B58 = process.env.TRADEROUTER_PRIVATE_KEY || '';

// Trust anchor — hardcoded, never fetched from server (TOCTOU)
const _HARDCODED_SERVER_PUBKEY = 'EXX3nRzfDUvbjZSmxFzHDdiSYeGVP1EGr77iziFZ4Jd4';
const SERVER_PUBKEY_B58      = (process.env.TRADEROUTER_SERVER_PUBKEY || _HARDCODED_SERVER_PUBKEY).trim();
const SERVER_PUBKEY_NEXT_B58 = (process.env.TRADEROUTER_SERVER_PUBKEY_NEXT || '').trim() || null;
const REQUIRE_SERVER_SIG     = (process.env.TRADEROUTER_REQUIRE_SERVER_SIGNATURE || 'true') === 'true';
const REQUIRE_ORDER_CREATED_SIG = (process.env.TRADEROUTER_REQUIRE_ORDER_CREATED_SIGNATURE || 'true') === 'true';
const DRY_RUN                = (process.env.TRADEROUTER_DRY_RUN || 'false').toLowerCase() === 'true';

// Tool names that would submit a transaction or place/modify a server-side order.
// When DRY_RUN is enabled, these short-circuit and return { dry_run: true, ... }
// instead of calling the API. Read-only tools (get_*, list_orders, check_order,
// connection_status, build_swap) always execute normally.
const WRITE_ACTION_TOOLS = new Set([
  'submit_signed_swap',
  'auto_swap',
  'place_limit_order',
  'place_trailing_order',
  'place_twap_order',
  'place_limit_twap_order',
  'place_trailing_twap_order',
  'place_limit_trailing_order',
  'place_limit_trailing_twap_order',
  'cancel_order',
  'extend_order',
]);

const BACKOFF_BASE   = 1000;
const BACKOFF_FACTOR = 2;
const BACKOFF_MAX    = 60000;
const BACKOFF_JITTER = 0.25;

const WS_STARTUP_WAIT_MS = 25000;

// ── Solana helpers ───────────────────────────────────────────────────────────

function getKeypair() {
  if (!PRIVATE_KEY_B58) return null;
  try {
    return Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));
  } catch (e) {
    throw new Error(`Invalid TRADEROUTER_PRIVATE_KEY: ${e.message}`);
  }
}

function signTxB58(swapTxB58) {
  const kp = getKeypair();
  if (!kp) throw new Error('TRADEROUTER_PRIVATE_KEY not set — cannot auto-sign');
  const raw    = bs58.decode(swapTxB58);
  const tx     = VersionedTransaction.deserialize(raw);
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString('base64');
}

// ── REST helpers ─────────────────────────────────────────────────────────────

async function get(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function post(path, body) {
  const timeoutMs = path.includes('holdings') ? 110000 : 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Signature verification ────────────────────────────────────────────────────

const CANONICAL_KEYS = [
  'order_id', 'order_type', 'status', 'token_address',
  'entry_mcap', 'triggered_mcap', 'filled_mcap', 'target_mcap',
  'triggered_at', 'filled_at', 'data',
];

function canonicalizeForSigning(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForSigning);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalizeForSigning(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJsonPythonStyle(obj) {
  // Match Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)
  const canonicalObj = canonicalizeForSigning(obj);
  const json = JSON.stringify(canonicalObj);
  return json.replace(/[^\x00-\x7F]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function verifyOrderFilled(msg, serverPubkeyB58) {
  if (!serverPubkeyB58) return false;
  const sigB58 = msg.server_signature;
  if (!sigB58) return false;

  const payload = {};
  for (const key of CANONICAL_KEYS) {
    if (msg[key] !== undefined && msg[key] !== null) payload[key] = msg[key];
  }
  const canonical = canonicalJsonPythonStyle(payload);
  const digest    = createHash('sha256').update(Buffer.from(canonical, 'utf-8')).digest();

  try {
    const sigBytes    = bs58.decode(sigB58);
    const pubkeyBytes = bs58.decode(serverPubkeyB58);
    return nacl.sign.detached.verify(digest, sigBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

function verifyOrderFilledWithRotation(msg) {
  const keys = [SERVER_PUBKEY_B58, SERVER_PUBKEY_NEXT_B58].filter(Boolean);
  for (const key of keys) {
    if (verifyOrderFilled(msg, key)) {
      if (key === SERVER_PUBKEY_NEXT_B58) {
        log('warn', 'Fill verified with NEXT server key — update TRADEROUTER_SERVER_PUBKEY');
      }
      return true;
    }
  }
  return false;
}

// twap_execution: server signs order_id|order_type|execution_num|executions_total|status|token_address (SHA-256 then Ed25519)
function verifyTwapExecution(msg, serverPubkeyB58) {
  if (!serverPubkeyB58) return false;
  const sigB58 = msg.server_signature;
  if (!sigB58) return false;
  const { order_id, order_type, execution_num, executions_total, status, token_address } = msg;
  if (order_id == null || order_type == null || execution_num == null || executions_total == null || status == null || token_address == null) return false;
  const s = `${order_id}|${order_type}|${execution_num}|${executions_total}|${status}|${token_address}`;
  const digest = createHash('sha256').update(Buffer.from(s, 'utf-8')).digest();
  try {
    const sigBytes = bs58.decode(sigB58);
    const pubkeyBytes = bs58.decode(serverPubkeyB58);
    return nacl.sign.detached.verify(digest, sigBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

function verifyTwapExecutionWithRotation(msg) {
  const keys = [SERVER_PUBKEY_B58, SERVER_PUBKEY_NEXT_B58].filter(Boolean);
  for (const key of keys) {
    if (verifyTwapExecution(msg, key)) return true;
  }
  return false;
}

/**
 * Build the exact pipe-delimited preimage the server hashes (server_signing.py).
 * - limit (sell/buy): target_bps only, 8 fields
 * - trailing (trailing_*, limit_trailing_sell/buy): trail_bps only, 8 fields
 * - trailing_twap_*: trail_bps + frequency + duration (10 fields)
 * - limit_twap_*: target_bps + frequency + duration (10 fields)
 * - limit_trailing_twap_*: target_bps|trail_bps + frequency + duration (11 fields)
 */
export function getOrderCreatedPreimage(msg) {
  const { order_id, token_address, order_type, slippage, expiry_hours, amount } = msg;
  if (!order_id || !token_address || !order_type || slippage == null || expiry_hours == null || amount == null) {
    return null;
  }
  const hp = msg.holdings_percentage != null ? parseInt(msg.holdings_percentage, 10) : 0;
  const slip = parseInt(slippage, 10);
  const exp = parseInt(expiry_hours, 10);
  const amt = parseInt(amount, 10);

  // limit_trailing_twap_* — server params_hash_limit_trailing_twap: target_bps|trail_bps|...|frequency|duration
  if (order_type === 'limit_trailing_twap_sell' || order_type === 'limit_trailing_twap_buy') {
    if (msg.target_bps == null || msg.trail_bps == null || msg.frequency == null || msg.duration == null) return null;
    const targetBps = parseInt(msg.target_bps, 10);
    const trailBps = parseInt(msg.trail_bps, 10);
    const freq = parseInt(msg.frequency, 10);
    const dur = parseInt(msg.duration, 10);
    return `${order_id}|${token_address}|${order_type}|${targetBps}|${trailBps}|${slip}|${exp}|${amt}|${hp}|${freq}|${dur}`;
  }

  // limit_twap_* / trailing_twap_* — 8-field base then |frequency|duration (server hashes one string)
  if (order_type === 'limit_twap_sell' || order_type === 'limit_twap_buy') {
    if (msg.target_bps == null || msg.frequency == null || msg.duration == null) return null;
    const targetBps = parseInt(msg.target_bps, 10);
    const freq = parseInt(msg.frequency, 10);
    const dur = parseInt(msg.duration, 10);
    return `${order_id}|${token_address}|${order_type}|${targetBps}|${slip}|${exp}|${amt}|${hp}|${freq}|${dur}`;
  }
  if (order_type === 'trailing_twap_sell' || order_type === 'trailing_twap_buy') {
    if (msg.trail_bps == null || msg.frequency == null || msg.duration == null) return null;
    const trailBps = parseInt(msg.trail_bps, 10);
    const freq = parseInt(msg.frequency, 10);
    const dur = parseInt(msg.duration, 10);
    return `${order_id}|${token_address}|${order_type}|${trailBps}|${slip}|${exp}|${amt}|${hp}|${freq}|${dur}`;
  }

  // sell / buy — params_hash_limit
  if (order_type === 'sell' || order_type === 'buy') {
    if (msg.target_bps == null) return null;
    const targetBps = parseInt(msg.target_bps, 10);
    return `${order_id}|${token_address}|${order_type}|${targetBps}|${slip}|${exp}|${amt}|${hp}`;
  }

  // trailing_sell/buy, limit_trailing_sell/buy — params_hash_trailing (trail_bps only)
  if (['trailing_sell', 'trailing_buy', 'limit_trailing_sell', 'limit_trailing_buy'].includes(order_type)) {
    if (msg.trail_bps == null) return null;
    const trailBps = parseInt(msg.trail_bps, 10);
    return `${order_id}|${token_address}|${order_type}|${trailBps}|${slip}|${exp}|${amt}|${hp}`;
  }

  return null;
}

export function computeParamsHash(msg) {
  const preimage = getOrderCreatedPreimage(msg);
  if (!preimage) return null;
  return createHash('sha256').update(Buffer.from(preimage, 'utf-8')).digest('hex');
}

/** @deprecated use getOrderCreatedPreimage; kept for any external callers expecting 8-field base only */
function getParamsHashCanonicalString(msg) {
  const preimage = getOrderCreatedPreimage(msg);
  return preimage;
}

function verifyOrderCreated(msg) {
  const paramsHash = msg.params_hash;
  const sigB58     = msg.server_signature;
  if (!paramsHash || !sigB58) return null;  // server hasn't shipped commitment yet
  const preimage = getOrderCreatedPreimage(msg);
  if (!preimage) return false;
  const computed = createHash('sha256').update(Buffer.from(preimage, 'utf-8')).digest('hex');
  if (computed !== paramsHash) return false;
  const digest = createHash('sha256').update(Buffer.from(paramsHash, 'utf-8')).digest();
  const keys   = [SERVER_PUBKEY_B58, SERVER_PUBKEY_NEXT_B58].filter(Boolean);
  for (const key of keys) {
    try {
      const ok = nacl.sign.detached.verify(digest, bs58.decode(sigB58), bs58.decode(key));
      if (ok) return true;
    } catch { /* try next */ }
  }
  return false;
}

// ── Logging ──────────────────────────────────────────────────────────────────

function log(level, ...args) {
  process.stderr.write(`[traderouter] ${level.toUpperCase()} ${args.join(' ')}\n`);
}

// ── WsManager ────────────────────────────────────────────────────────────────

class WsManager {
  constructor(wallet) {
    this.wallet      = wallet;
    this._ws         = null;
    this._registered = false;
    this._attempt    = 0;
    this._stopped    = false;

    // Pending: [{payload, resolve, reject, expectType}]
    this._pending  = [];
    // Inflight: {expectType: [{resolve, reject, ts}]}
    this._inflight = {};

    this._fillLog       = [];
    this._registeredCbs = [];   // callbacks for when registered fires
  }

  start() {
    this._stopped = false;
    this._loop();
  }

  async stop() {
    this._stopped = true;
    if (this._ws) try { this._ws.close(); } catch {}
    this._ws = null;
    this._registered = false;
    this._failAllInflight(new Error('WsManager stopped'));
  }

  get isConnected() { return this._registered && this._ws != null; }

  status() {
    return {
      connected:      this.isConnected,
      attempt:        this._attempt,
      pending_sends:  this._pending.length,
      inflight:       Object.fromEntries(Object.entries(this._inflight).map(([k, v]) => [k, v.length])),
      fill_log_count: this._fillLog.length,
    };
  }

  getFillLog() { return [...this._fillLog]; }

  waitRegistered(timeoutMs = 20000) {
    if (this._registered) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this._registeredCbs.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  sendAndWait(payload, expectType, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `Timeout waiting for '${expectType}' (${this.isConnected ? 'server no response' : 'not connected — queued'})`
      )), timeoutMs);

      const wrappedResolve = (v) => { clearTimeout(timer); resolve(v); };
      const wrappedReject  = (e) => { clearTimeout(timer); reject(e); };

      if (this._registered && this._ws) {
        try {
          this._ws.send(JSON.stringify(payload));
          this._inflight[expectType] = this._inflight[expectType] || [];
          this._inflight[expectType].push({ resolve: wrappedResolve, reject: wrappedReject, ts: Date.now() });
        } catch {
          this._pending.push({ payload, resolve: wrappedResolve, reject: wrappedReject, expectType });
        }
      } else {
        this._pending.push({ payload, resolve: wrappedResolve, reject: wrappedReject, expectType });
      }
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _loop() {
    while (!this._stopped) {
      try {
        await this._connect();
        this._attempt = 0;
      } catch (e) {
        if (this._stopped) break;
        this._attempt++;
        const raw    = BACKOFF_BASE * Math.pow(BACKOFF_FACTOR, this._attempt - 1);
        const capped = Math.min(raw, BACKOFF_MAX);
        const jitter = capped * BACKOFF_JITTER * (2 * Math.random() - 1);
        const wait   = Math.max(500, capped + jitter);
        log('warn', `WS error (attempt ${this._attempt}): ${e.message} — retrying in ${(wait/1000).toFixed(1)}s`);
        this._registered = false;
        this._ws = null;
        this._failAllInflight(new Error(`WebSocket disconnected: ${e.message}`));
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      log('info', `Connecting to ${WS_URL}`);
      const ws = new WebSocket(WS_URL);
      this._ws = ws;

      ws.on('open',    ()  => log('info', 'WebSocket connected'));
      ws.on('error',   (e) => reject(e));
      ws.on('close',   ()  => reject(new Error('WebSocket closed')));
      ws.on('message', (raw) => {
        try {
          this._dispatch(JSON.parse(raw), resolve, reject);
        } catch (e) {
          log('error', `Dispatch error: ${e.message}`);
        }
      });
    });
  }

  _dispatch(msg, resolveConn, rejectConn) {
    const t = msg.type;

    if (t === 'challenge') {
      const kp = getKeypair();
      if (!kp || !msg.nonce) {
        log('warn', 'challenge received but no nonce or TRADEROUTER_PRIVATE_KEY — cannot register');
        return;
      }
      const sigBytes  = nacl.sign.detached(Buffer.from(msg.nonce, 'utf-8'), kp.secretKey);
      const signature = bs58.encode(sigBytes);
      this._ws.send(JSON.stringify({
        action: 'register',
        wallet_address: this.wallet,
        signature,
      }));
      log('info', `→ challenge; sent register with signature for …${this.wallet.slice(-6)}`);
    }

    else if (t === 'registered') {
      if (!msg.authenticated) {
        log('error', `registered but authenticated: false for …${this.wallet.slice(-6)} — check TRADEROUTER_PRIVATE_KEY matches wallet_address`);
        return;
      }
      log('info', `✓ registered; flushing ${this._pending.length} pending send(s)`);
      this._registered = true;
      this._attempt    = 0;
      this._registeredCbs.forEach(cb => cb());
      this._registeredCbs = [];
      this._flushPending();
    }

    else if (t === 'heartbeat') { /* ignore */ }

    else if (t === 'order_filled') {
      log('info', `→ order_filled order_id=${msg.order_id}`);
      this._handleFill(msg);
    }

    else if (t === 'twap_order_created') {
      this._resolveInflight(t, msg);
    }

    else if (t === 'twap_execution') {
      log('info', `→ twap_execution order_id=${msg.order_id} execution=${msg.execution_num}/${msg.executions_total}`);
      this._handleTwapExecution(msg);
    }

    else if (t === 'twap_order_completed') {
      log('info', `→ twap_order_completed order_id=${msg.order_id} executions=${msg.executions_completed}`);
      this._resolveInflight(t, msg);
    }

    else if (t === 'twap_order_cancelled') {
      this._resolveInflight(t, msg);
      this._resolveInflight('order_cancelled', msg);  // so cancel_order call receives a response
    }

    else if (t === 'error') {
      log('error', `← server error: ${msg.message}`);
      const first = this._firstInflight();
      if (first) first.reject(new Error(msg.message));
    }

    else if (t === 'order_created') {
      const hasCommitment = !!(msg.params_hash && msg.server_signature);
      let verified = null;
      if (hasCommitment) {
        try {
          verified = verifyOrderCreated(msg);
        } catch (e) {
          log('error', `order_created verification threw: ${e.message}`);
          const first = this._firstInflight();
          if (first) first.reject(new Error(`order_created verification error: ${e.message}`));
          return;
        }
      }
      msg.params_verified = verified;
      if (hasCommitment && !msg.params_verified) {
        const errMsg = `order_created params commitment FAILED order_id=${msg.order_id}`;
        log('error', errMsg);
        const first = this._firstInflight();
        if (first) first.reject(new Error(errMsg));
        return;
      }
      if (!hasCommitment && REQUIRE_ORDER_CREATED_SIG) {
        const errMsg = `order_created missing params commitment — rejecting order_id=${msg.order_id}`;
        log('error', errMsg);
        const first = this._firstInflight();
        if (first) first.reject(new Error(errMsg));
        return;
      }
      this._resolveInflight(t, msg);
    }

    else {
      this._resolveInflight(t, msg);
    }
  }

  async _handleFill(msg) {
    const entry = { fill: msg, protect: null, error: null, ts: Date.now() / 1000 };

    if (msg.already_dispatched) {
      log('info', `order_filled already_dispatched order_id=${msg.order_id} — skipping`);
      this._fillLog.push(entry);
      if (this._fillLog.length > 200) this._fillLog.shift();
      return;
    }

    const sigB58 = msg.server_signature;
    if (sigB58) {
      if (!SERVER_PUBKEY_B58 && !SERVER_PUBKEY_NEXT_B58) {
        entry.error = 'server_signature present but no server public key configured';
        log('error', `order_filled has server_signature but no pubkey configured — rejecting ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
      if (!verifyOrderFilledWithRotation(msg)) {
        entry.error = 'server_signature verification failed';
        log('error', `order_filled server_signature FAILED — rejecting fill ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
    } else {
      if (REQUIRE_SERVER_SIG) {
        entry.error = 'no server_signature present';
        log('error', `order_filled has no server_signature — rejecting ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
      log('warn', `order_filled has no server_signature — proceeding (REQUIRE_SERVER_SIGNATURE=false) ${msg.order_id}`);
    }

    const swapTx = msg.data?.swap_tx;
    if (!swapTx) {
      log('warn', `order_filled with no swap_tx — stored only`);
    } else if (!PRIVATE_KEY_B58) {
      log('info', `Fill received; no private key set — stored in fill_log only`);
    } else {
      try {
        const signedB64 = signTxB58(swapTx);
        const protect   = await post('/protect', { signed_tx_base64: signedB64 });
        entry.protect   = protect;
        log('info', `Auto-submitted fill ${msg.order_id} → sig ${(protect.signature || '?').slice(0, 16)}…`);
      } catch (e) {
        entry.error = e.message;
        log('error', `Auto-submit failed for fill ${msg.order_id}: ${e.message}`);
      }
    }

    this._fillLog.push(entry);
    if (this._fillLog.length > 200) this._fillLog.shift();
  }

  async _handleTwapExecution(msg) {
    const entry = { fill: msg, protect: null, error: null, ts: Date.now() / 1000 };

    if (msg.status === 'error') {
      log('warn', `twap_execution error order_id=${msg.order_id} execution=${msg.execution_num}: ${msg.error || 'unknown'}`);
      this._fillLog.push(entry);
      if (this._fillLog.length > 200) this._fillLog.shift();
      return;
    }

    const sigB58 = msg.server_signature;
    if (sigB58) {
      if (!SERVER_PUBKEY_B58 && !SERVER_PUBKEY_NEXT_B58) {
        entry.error = 'server_signature present but no server public key configured';
        log('error', `twap_execution has server_signature but no pubkey configured — rejecting ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
      if (!verifyTwapExecutionWithRotation(msg)) {
        entry.error = 'server_signature verification failed';
        log('error', `twap_execution server_signature FAILED — rejecting ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
    } else if (REQUIRE_SERVER_SIG) {
      entry.error = 'no server_signature present';
      log('error', `twap_execution has no server_signature — rejecting ${msg.order_id}`);
      this._fillLog.push(entry);
      if (this._fillLog.length > 200) this._fillLog.shift();
      return;
    }

    const swapTx = msg.data?.swap_tx;
    if (!swapTx) {
      log('warn', `twap_execution with no swap_tx — stored only`);
    } else if (!PRIVATE_KEY_B58) {
      log('info', `TWAP slice received; no private key set — stored in fill_log only`);
    } else {
      try {
        const signedB64 = signTxB58(swapTx);
        const protect = await post('/protect', { signed_tx_base64: signedB64 });
        entry.protect = protect;
        log('info', `Auto-submitted TWAP slice ${msg.order_id} #${msg.execution_num} → sig ${(protect.signature || '?').slice(0, 16)}…`);
      } catch (e) {
        entry.error = e.message;
        log('error', `Auto-submit failed for TWAP slice ${msg.order_id} #${msg.execution_num}: ${e.message}`);
      }
    }

    this._fillLog.push(entry);
    if (this._fillLog.length > 200) this._fillLog.shift();
  }

  _flushPending() {
    const queue = [...this._pending];
    this._pending = [];
    for (const item of queue) {
      try {
        this._ws.send(JSON.stringify(item.payload));
        this._inflight[item.expectType] = this._inflight[item.expectType] || [];
        this._inflight[item.expectType].push({ resolve: item.resolve, reject: item.reject, ts: Date.now() });
      } catch {
        this._pending.unshift(item);
        break;
      }
    }
  }

  _resolveInflight(type, msg) {
    const waiters = this._inflight[type];
    if (waiters?.length) {
      const { resolve } = waiters.shift();
      resolve(msg);
    }
  }

  _firstInflight() {
    for (const waiters of Object.values(this._inflight)) {
      if (waiters.length) return waiters[0];
    }
    return null;
  }

  _failAllInflight(err) {
    for (const waiters of Object.values(this._inflight)) {
      for (const { reject } of waiters) reject(err);
    }
    this._inflight = {};
  }
}

// ── Manager registry ─────────────────────────────────────────────────────────

const _managers = new Map();

function getManager(wallet) {
  if (!_managers.has(wallet)) {
    const mgr = new WsManager(wallet);
    _managers.set(wallet, mgr);
    mgr.start();
  }
  return _managers.get(wallet);
}

async function getManagerRegistered(wallet, timeoutMs = WS_STARTUP_WAIT_MS) {
  const mgr = getManager(wallet);
  if (PRIVATE_KEY_B58 && !mgr.isConnected) {
    const kp = getKeypair();
    if (kp && kp.publicKey.toBase58() === wallet) {
      log('info', `Waiting up to ${timeoutMs / 1000}s for WS registration…`);
      const ok = await mgr.waitRegistered(timeoutMs);
      if (!ok) log('warn', `WS did not register within ${timeoutMs / 1000}s — command may be queued`);
    }
  }
  return mgr;
}

async function ws(wallet, payload, expectType, timeoutMs = 15000) {
  const mgr = await getManagerRegistered(wallet);
  try {
    return await mgr.sendAndWait(payload, expectType, timeoutMs);
  } catch (e) {
    if (e.message.includes('Timeout')) throw e;
    throw e;
  }
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'traderouter', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  // ──────────────────────────────────────────────────────────────────────────
  // WALLET / SESSION
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: 'get_wallet_address',
    description: `Returns the public Solana wallet address derived from the TRADEROUTER_PRIVATE_KEY environment variable, and triggers the persistent WebSocket connection to api.traderouter.ai for that wallet.

WHEN TO USE: Call this once at session start, before any other Trade Router tool. The returned wallet address is the identity used by every other tool.

WHAT IT DOES: Reads the base58 private key from env, derives the Solana public key locally (no network call for derivation), then opens a WebSocket to wss://api.traderouter.ai/ws and authenticates via challenge-response signing of a server-issued nonce. The private key never crosses the network.

RETURNS: { configured: true, wallet_address: "<base58>" } on success. { configured: false, error: "TRADEROUTER_PRIVATE_KEY not set" } if the env var is missing — in that case, only read-only tools (get_holdings, get_mcap, get_flex_card) will work for arbitrary wallets, and write tools will fail.

SIDE EFFECTS: Spawns a background WebSocket connection that persists for the lifetime of the MCP server process.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  // ──────────────────────────────────────────────────────────────────────────
  // INSTANT SWAPS (REST)
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: 'build_swap',
    description: `Builds an unsigned Solana swap transaction via POST /swap. Returns the transaction as base58 — the caller must decode, sign locally, re-encode as base64, and submit via submit_signed_swap.

WHEN TO USE: When you want to inspect or modify the transaction before signing (e.g. agent-layer validation), or when you want to control the sign+submit flow yourself. For a one-step swap, use auto_swap instead.

WHAT IT DOES: Calls api.traderouter.ai/swap with wallet_address, token_address, action ('buy' or 'sell'), and either amount (lamports, for buy) or holdings_percentage (bps, for sell). The server picks the best DEX route across Raydium, PumpSwap, Orca, and Meteora based on liquidity, builds a VersionedTransaction, and returns it base58-encoded.

RETURNS: On success: { status: "success", data: { swap_tx, pool_type, pool_address, amount_in, min_amount_out, price_impact, slippage, decimals } }. The pool_type field is an open enum (treat unknown values gracefully). On error: { status: "error", error, code }. "Error running simulation" usually means the route is unsellable right now (dead pool, zero balance, no route) — do not retry-loop.

SIDE EFFECTS: None. This tool does NOT submit or sign anything.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58, 32-44 chars). Usually the same value returned by get_wallet_address.' },
        token_address:  { type: 'string', description: 'SPL token mint address (base58). Example: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 for BONK.' },
        action:         { type: 'string', enum: ['buy', 'sell'], description: '"buy" spends SOL to receive token; "sell" spends token to receive SOL.' },
        amount:              { type: 'integer', minimum: 1, description: 'REQUIRED for action="buy", FORBIDDEN for action="sell". Lamports of SOL to spend (1 SOL = 1,000,000,000 lamports). Example: 100000000 = 0.1 SOL.' },
        holdings_percentage: { type: 'integer', minimum: 1, maximum: 10000, description: 'REQUIRED for action="sell", FORBIDDEN for action="buy". Basis points of current holdings to sell (10000 = 100%). Example: 5000 = sell 50%.' },
        slippage:       { type: 'integer', minimum: 100, maximum: 2500, default: 1500, description: 'Maximum slippage in basis points (10000 = 100%). Default 1500 (15%). For low-liquidity or newly-launched tokens use 1500-2500. 500 bps will often fail on memecoins.' },
      },
    },
  },
  {
    name: 'submit_signed_swap',
    description: `Submits a fully-signed, base64-encoded Solana transaction via POST /protect (Jito MEV-protected lane). Blocks until the transaction confirms on-chain.

WHEN TO USE: Pair with build_swap when you want to inspect/modify the transaction before signing. For a single-call swap, prefer auto_swap.

WHAT IT DOES: POSTs the signed transaction to api.traderouter.ai/protect, which submits via Jito bundles + a staked connection lane (preventing mempool visibility for sandwich-resistance), waits for on-chain confirmation, and returns the signature plus pre/post SOL balance and token balance changes.

RETURNS: On success: { status: "success", signature, sol_balance_pre, sol_balance_post, token_balances: [{ mint, balance, decimals, balance_change, ui_amount_string }] }. On error: { status: "error", error, code }. On 503 (protect lane unavailable), the MCP server falls back to direct RPC submission automatically — you lose MEV protection but the transaction still lands.

SIDE EFFECTS: Submits a real on-chain transaction (unless TRADEROUTER_DRY_RUN=true). Costs ~0.000005 SOL in network fees plus the routed swap fee.

⚠️ ENCODING: The swap_tx returned by build_swap is BASE58. This tool requires BASE64. Decode the base58, deserialize as VersionedTransaction, sign, re-serialize, base64-encode.

⚠️ TIMEOUT: Set client HTTP timeout to 30 seconds — confirmation latency varies with network congestion.`,
    inputSchema: {
      type: 'object',
      required: ['signed_tx_base64'],
      additionalProperties: false,
      properties: {
        signed_tx_base64: { type: 'string', description: 'A signed Solana VersionedTransaction, base64-encoded. Note: build_swap returns base58; you must convert before passing here.' },
      },
    },
  },
  {
    name: 'auto_swap',
    description: `Builds, signs, and submits a Solana swap in a single call. Equivalent to build_swap → local sign → submit_signed_swap, but the MCP server handles the encoding conversion (base58 → base64) for you.

WHEN TO USE: For most swaps. This is the simplest path. Use build_swap + submit_signed_swap separately only when you need to inspect or modify the transaction before signing (e.g. agent-layer validation of the output amount).

WHAT IT DOES: Calls /swap to get an unsigned tx, signs it locally with TRADEROUTER_PRIVATE_KEY (key never leaves the process), submits via /protect (Jito MEV-protected). Returns the swap details and confirmation in one response.

RETURNS: { swap: { swap_tx, pool_type, amount_in, min_amount_out, price_impact, slippage, decimals }, protect: { status, signature, sol_balance_pre, sol_balance_post, token_balances } }. If swap-build fails, only the swap object is returned with status="error".

SIDE EFFECTS: Submits a real on-chain transaction (unless TRADEROUTER_DRY_RUN=true, which short-circuits to { dry_run: true, tool, args }). Requires TRADEROUTER_PRIVATE_KEY to be set.

⚠️ TRUST: This tool signs whatever transaction the server returns without inspecting the bytes against the requested swap parameters. If api.traderouter.ai is compromised, a malicious server could return a transaction that drains your wallet. Mitigations: use TRADEROUTER_DRY_RUN for testing; use a dedicated trading wallet with limited balance; or use build_swap + submit_signed_swap with your own decode+verify step. See SECURITY.md.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58). Must match the wallet derived from TRADEROUTER_PRIVATE_KEY.' },
        token_address:  { type: 'string', description: 'SPL token mint address (base58).' },
        action:         { type: 'string', enum: ['buy', 'sell'], description: '"buy" spends SOL to receive token; "sell" spends token to receive SOL.' },
        amount:              { type: 'integer', minimum: 1, description: 'REQUIRED for action="buy". Lamports (1 SOL = 1e9 lamports). Example: 100000000 = 0.1 SOL.' },
        holdings_percentage: { type: 'integer', minimum: 1, maximum: 10000, description: 'REQUIRED for action="sell". Basis points of current holdings (10000 = 100%).' },
        slippage:       { type: 'integer', minimum: 100, maximum: 2500, default: 1500, description: 'Slippage tolerance in basis points (default 1500 = 15%). Memecoins typically need 1500-2500.' },
      },
    },
  },
  // ──────────────────────────────────────────────────────────────────────────
  // READ-ONLY (REST)
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: 'get_holdings',
    description: `Scans every SPL token account on a wallet and returns the holdings list. Most accurate Solana wallet scanner available — catches tokens that standard RPC token-account scans miss.

WHEN TO USE: When you need the full token balance for a wallet, including obscure or newly-launched tokens, before deciding what to sell or display in a portfolio view.

WHAT IT DOES: Calls POST /holdings with the wallet address. Server enumerates every Token Program 2022 + SPL Token Program account, resolves liquid pool info per token, and returns the list.

RETURNS: { data: [{ address: "<mint>", valueNative: <lamports>, amount: <raw_units>, decimals }] }. Empty wallet returns {} (not an empty array). Apply a defensive valueNative > 0 filter on the caller side; some edge cases return stale data.

SIDE EFFECTS: None — pure read.

⚠️ TIMEOUT: Set client HTTP timeout to AT LEAST 100 seconds. Wallets with many tokens take time to fully scan.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58). No signing required — public key only.' },
      },
    },
  },
  {
    name: 'get_mcap',
    description: `Returns market-cap and price data for one or more SPL tokens. Used by limit-order strategies to compute target market caps relative to current.

WHEN TO USE: Before placing a limit_order with a market-cap target (so you know what current mcap is), or for portfolio valuation.

WHAT IT DOES: Calls GET /mcap with comma-delimited mint addresses. Server queries its market-cap index (computed from liquid pool reserves) and returns per-token data.

RETURNS: An object keyed by mint address. Each value can include marketCap (USD), priceUsd, pair_address, pool_type. Empty object if no tokens are provided or none are found.

SIDE EFFECTS: None — pure read.`,
    inputSchema: {
      type: 'object',
      required: ['tokens'],
      additionalProperties: false,
      properties: {
        tokens: { type: 'string', description: 'Comma-delimited SPL token mint addresses (base58). Example: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263,JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN".' },
      },
    },
  },
  {
    name: 'get_flex_card',
    description: `Returns the URL of a flex trade-card PNG that visualizes a wallet's position in a token (entry price, current PnL, etc.). Used for sharing trades on social media.

WHEN TO USE: After a notable swap, to generate a shareable image for X / Discord / Telegram.

WHAT IT DOES: Constructs the URL https://api.traderouter.ai/flex?wallet_address=W&token_address=T. Does NOT fetch the image — it returns the URL string for the caller to embed or share.

RETURNS: { url: "<full URL>", wallet_address, token_address }. The URL itself returns image/png when fetched. 400 on invalid params, 501 if flex-card image deps are not configured server-side, 500 on internal errors.

SIDE EFFECTS: None.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58).' },
        token_address: { type: 'string', description: 'SPL token mint address (base58).' },
      },
    },
  },
  // ──────────────────────────────────────────────────────────────────────────
  // WEBSOCKET LIFECYCLE
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: 'connect_websocket',
    description: `Opens (or reuses) the persistent WebSocket connection to wss://api.traderouter.ai/ws for a wallet, performs the Ed25519 challenge-response handshake, and waits up to 25 seconds for the "registered" confirmation.

WHEN TO USE: Before placing limit / trailing / TWAP / combo orders. get_wallet_address calls this implicitly, so you only need this tool to FORCE-reconnect or to register a wallet other than the env-derived one.

WHAT IT DOES: Connects to the WebSocket, receives the server's challenge { type: "challenge", nonce }, signs the nonce bytes with TRADEROUTER_PRIVATE_KEY (Ed25519), sends { action: "register", wallet_address, signature: "<base58>" }, waits for { type: "registered", authenticated: true }.

RETURNS: { wallet, message: "WebSocket connected and registered" | "WebSocket not yet registered; commands may be queued", connected: bool, registered: bool, ... }.

SIDE EFFECTS: Spawns/maintains a background WebSocket connection. If TRADEROUTER_PRIVATE_KEY is missing or doesn't match wallet_address, registration will fail with authenticated:false and order placement will be rejected.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58). Must correspond to the keypair held in TRADEROUTER_PRIVATE_KEY for register to succeed.' },
      },
    },
  },
  {
    name: 'connection_status',
    description: `Returns the current state of the persistent WebSocket connection for a wallet (connected, registered, last heartbeat time, queued message count).

WHEN TO USE: For debugging. If place_*_order calls are failing or hanging, check this first to see whether the WebSocket is actually authenticated.

WHAT IT DOES: Inspects the in-memory ConnectionManager for the given wallet — no network call.

RETURNS: { wallet, connected: bool, registered: bool, lastHeartbeat: <ISO timestamp>, ... }.

SIDE EFFECTS: None.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58).' },
      },
    },
  },
  {
    name: 'get_fill_log',
    description: `Returns the in-memory log of all order_filled events received over the WebSocket since the MCP server process started (capped at 200 entries).

WHEN TO USE: Audit which orders have triggered, with their on-chain signatures. Useful for end-of-session reporting or debugging "did my order fill?"

WHAT IT DOES: Reads from the ConnectionManager's circular buffer. Does not query the API.

RETURNS: { wallet, fills: [{ order_id, order_type, signature, filled_at, triggered_mcap, filled_mcap, status, server_signature_verified }] }.

SIDE EFFECTS: None.

⚠️ NOT PERSISTED: This log is cleared when the MCP server restarts. For long-term audit, store fills externally as they arrive.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58).' },
      },
    },
  },
  // ──────────────────────────────────────────────────────────────────────────
  // ORDER PLACEMENT (WEBSOCKET)
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: 'place_limit_order',
    description: `Places a market-cap-triggered limit order over the WebSocket. The server polls market cap ~every 5 seconds and fires the swap when the target is crossed.

WHEN TO USE: When you want to enter or exit at a specific market-cap level, not at current price. Examples: "buy BONK when its mcap drops to $500M", "sell BONK when its mcap doubles".

WHAT IT DOES: Sends { action: "sell"|"buy", token_address, target, slippage, expiry_hours, ... } to the server over WS. Server registers the order, returns { type: "order_created", order_id, params_hash, server_signature }. The MCP verifies server_signature against the Ed25519 trust anchor before treating the order as accepted.

TARGET SEMANTICS: target is in basis points relative to the CURRENT mcap at order placement (NOT your wallet entry price). For SELL: target > 10000 = take-profit (e.g. 20000 = mcap doubles). target < 10000 = stop-loss (e.g. 5000 = halves). For BUY: target < 10000 = dip buy. target > 10000 = breakout entry.

WHEN ORDER FILLS: Server pushes order_filled with an unsigned tx. The MCP signs locally and submits via /protect, then logs the fill (visible via get_fill_log).

SIDE EFFECTS: Order persists server-side until trigger, expiry, or cancel_order. The MCP server process must keep its WS open to receive fills — restarting the process WHILE an order is pending may cause you to miss the fill notification (the order itself stays alive on the server).`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'target'],
      additionalProperties: false,
      properties: {
        wallet_address:      { type: 'string', description: 'Solana wallet public key (base58).' },
        token_address:       { type: 'string', description: 'SPL token mint to buy or sell.' },
        action:              { type: 'string', enum: ['sell', 'buy'], description: '"sell" closes a position when target is hit; "buy" opens a position when target is hit.' },
        target:              { type: 'integer', minimum: 1, description: 'Target market cap in BPS vs current mcap at placement. >10000 = above current, <10000 = below current. E.g. 20000 = mcap doubles, 5000 = mcap halves. Server stores this in params_hash (signed) so it cannot be silently changed.' },
        amount:              { type: 'integer', minimum: 1, description: 'REQUIRED for action="buy". Lamports of SOL to spend when triggered.' },
        holdings_percentage: { type: 'integer', minimum: 1, maximum: 10000, description: 'REQUIRED for action="sell". Basis points of holdings to sell (10000 = 100%). Resolved at FILL TIME, not placement.' },
        slippage:            { type: 'integer', minimum: 100, maximum: 2500, default: 1500, description: 'Slippage tolerance in BPS at fill time. Default 1500 (15%).' },
        expiry_hours:        { type: 'integer', minimum: 1, maximum: 336, default: 144, description: 'Hours until the order auto-cancels server-side. Default 144 (6 days). Max 336 (14 days). Order silently expires; the server does NOT push an expiry event — use check_order or list_orders to detect.' },
      },
    },
  },
  {
    name: 'place_trailing_order',
    description: `Places a trailing-stop sell or trailing buy order over the WebSocket. The server tracks the high-water mark (or low-water mark for buy) of mcap and fires when it retraces by trail BPS.

WHEN TO USE: To ride a trend without picking a fixed exit. "Sell BONK when mcap drops 10% from its peak" — sell trail-stop. "Buy DOGE when mcap rebounds 5% from its low" — buy trail.

WHAT IT DOES: Sends { action: "trailing_sell"|"trailing_buy", token_address, trail, ... } to the server. Server tracks the running high (sell) or low (buy) of mcap and fires when retracement >= trail BPS. Server returns order_created with params_hash (signed), then later order_filled with an unsigned tx for local signing.

TRAIL SEMANTICS: trail is in basis points. trail=1000 means a 10% retracement triggers. Example (trailing_sell): mcap peaks at $100k, trail=1000, trigger at $90k. If mcap then peaks at $150k, trigger moves up to $135k.

SIDE EFFECTS: Order persists server-side until trigger, expiry, or cancel_order.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'trail'],
      additionalProperties: false,
      properties: {
        wallet_address:      { type: 'string', description: 'Solana wallet public key (base58).' },
        token_address:       { type: 'string', description: 'SPL token mint.' },
        action:              { type: 'string', enum: ['trailing_sell', 'trailing_buy'], description: 'trailing_sell closes a position after a retracement from peak; trailing_buy opens a position after a rebound from trough.' },
        trail:               { type: 'integer', minimum: 1, description: 'Trail distance in BPS (basis points). 1000 = 10%. Server tracks high-water (sell) or low-water (buy) mark and fires when reversal exceeds this.' },
        amount:              { type: 'integer', minimum: 1, description: 'REQUIRED for trailing_buy. Lamports of SOL to spend when triggered.' },
        holdings_percentage: { type: 'integer', minimum: 1, maximum: 10000, description: 'REQUIRED for trailing_sell. Basis points of holdings to sell (10000 = 100%).' },
        slippage:            { type: 'integer', minimum: 100, maximum: 2500, default: 1500, description: 'Slippage in BPS at fill. Default 1500 (15%).' },
        expiry_hours:        { type: 'integer', minimum: 1, maximum: 336, default: 144, description: 'Hours until auto-cancel. Default 144.' },
      },
    },
  },
  {
    name: 'place_twap_order',
    description: `Places a Time-Weighted Average Price (TWAP) buy or sell order. The total amount is split into N equal slices executed every (duration / frequency) seconds.

WHEN TO USE: For DCA, large entries/exits where minimizing market impact matters more than getting a single price. Example: "DCA 1 SOL into JUP over 6 hours in 12 slices" → twap_buy with amount=1e9, frequency=12, duration=21600.

WHAT IT DOES: Server registers the order, returns twap_order_created with order_id, frequency, duration, interval_seconds, amount_per_execution. Then for each slice, server pushes twap_execution { execution_num, executions_total, executions_remaining, next_execution_at, server_signature, data: { swap_tx } }. The MCP verifies server_signature, signs swap_tx, submits via /protect. Final twap_order_completed when all slices done.

SLICING: amount (or holdings_percentage at creation time, then resolved to a fixed token amount) is divided by frequency. Each slice executes at duration / frequency intervals.

SIDE EFFECTS: Each slice is a real on-chain transaction. The order persists server-side and the MCP server must stay running to receive twap_execution pushes. cancel_order halts remaining slices.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'frequency', 'duration'],
      additionalProperties: false,
      properties: {
        wallet_address:       { type: 'string', description: 'Solana wallet public key (base58).' },
        token_address:        { type: 'string', description: 'SPL token mint.' },
        action:               { type: 'string', enum: ['twap_buy', 'twap_sell'], description: 'twap_buy spends SOL to acquire token over N slices; twap_sell sells token for SOL over N slices.' },
        frequency:            { type: 'integer', minimum: 1, maximum: 100, description: 'Number of slice executions. Total amount is divided by this number. Example: frequency=12 with duration=21600 (6h) = one slice every 30 minutes.' },
        duration:             { type: 'integer', minimum: 60, description: 'Total run time in seconds. Min 60, max ~2,592,000 (30 days). Order has no separate expiry — it lives exactly this long.' },
        amount:               { type: 'integer', minimum: 1, description: 'REQUIRED for twap_buy (total SOL lamports to spend across all slices). For twap_sell, optional — sell exactly this many token base units total.' },
        holdings_percentage:  { type: 'integer', minimum: 1, maximum: 10000, description: 'For twap_sell: basis points of CURRENT holdings to sell (resolved once at creation, then divided by frequency). Use either this or amount, not both.' },
        slippage:             { type: 'integer', minimum: 100, maximum: 2500, default: 500, description: 'Slippage in BPS per slice. Default 500 (5%) — TWAP slices are smaller so tolerate tighter slippage.' },
      },
    },
  },
  {
    name: 'place_limit_twap_order',
    description: `COMBO ORDER: Wait for a market-cap target to be crossed, then execute the entry/exit as a TWAP rather than a single swap. Server-orchestrated; no client-side state machine needed.

WHEN TO USE: When you want a trigger-then-distribute pattern. Example: "If BONK's mcap hits $500M, ladder out of my position over 30 minutes via TWAP."

WHAT IT DOES: Server waits for limit target. When crossed, sends limit_twap_triggered, then twap_order_created for the spawned TWAP, then twap_execution per slice (each with server_signature for verification).

RETURNS: { wallet, order_id, message: "Limit-TWAP order accepted", target, frequency, duration, expiry_hours, params_hash, server_signature }. The order_id is what you'd pass to check_order, cancel_order, or extend_order. Server returns an error event over WS if the wallet is not registered, or if both amount and holdings_percentage are missing.

SIDE EFFECTS: Server-side state created — the order watches the market-cap feed continuously until target hits or expiry_hours elapses. Once limit triggers, a child TWAP order is spawned with its own order_id (delivered via twap_order_created event); cancel_order on the parent only cancels the limit phase, not the child TWAP after it spawns. params_hash signs an 11-field commitment (target_bps, trail_bps n/a, frequency, duration, etc.) — verified locally against the trust anchor before the order is treated as accepted.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'target', 'frequency', 'duration'],
      additionalProperties: false,
      properties: {
        wallet_address:       { type: 'string', description: 'Solana wallet public key (base58).' },
        token_address:        { type: 'string', description: 'SPL token mint.' },
        action:               { type: 'string', enum: ['limit_twap_sell', 'limit_twap_buy'], description: 'sell when target is crossed (then TWAP exit), or buy when target is crossed (then TWAP entry).' },
        target:               { type: 'integer', minimum: 1, description: 'Market-cap target in BPS vs current mcap at placement. See place_limit_order for full semantics.' },
        frequency:            { type: 'integer', minimum: 1, maximum: 100, description: 'Number of TWAP slices to spawn after the limit triggers.' },
        duration:             { type: 'integer', minimum: 60, description: 'Total seconds the spawned TWAP will run. Slice interval = duration / frequency.' },
        amount:               { type: 'integer', minimum: 1, description: 'Total to spend (buy lamports) or sell (token base units) across all TWAP slices.' },
        holdings_percentage:  { type: 'integer', minimum: 1, maximum: 10000, description: 'Sell only: BPS of holdings at TWAP-creation time.' },
        slippage:             { type: 'integer', minimum: 100, maximum: 2500, default: 500, description: 'Slippage per TWAP slice (BPS). Default 500.' },
        expiry_hours:         { type: 'integer', minimum: 1, maximum: 336, default: 144, description: 'Hours until the LIMIT phase auto-cancels (before TWAP fires). Default 144.' },
      },
    },
  },
  {
    name: 'place_trailing_twap_order',
    description: `COMBO ORDER: Wait for a trailing-stop trigger, then execute the exit as a TWAP rather than a single swap.

WHEN TO USE: To ride a trend with a trailing stop, but exit gradually via TWAP when the trail fires (minimizing market impact on a low-liquidity exit). Example: "Sell BONK if mcap drops 15% from peak, but spread the exit over 30 min."

WHAT IT DOES: Server tracks high-water (sell) or low-water (buy) mark. When reversal exceeds trail BPS, sends trailing_twap_triggered, then twap_order_created, then twap_execution per slice.

RETURNS: { wallet, order_id, message: "Trailing-TWAP order accepted", trail, frequency, duration, expiry_hours, params_hash, server_signature }. order_id is the parent (trailing-watching) phase; the spawned TWAP gets its own child order_id at trigger time.

SIDE EFFECTS: Server-side state created — the trailing-watcher runs continuously until trail fires or expiry_hours elapses. cancel_order on the parent stops the trailing phase but does NOT cancel a child TWAP that has already spawned. The 11-field params_hash includes trail BPS, frequency, duration, slippage — signed by server, verified locally.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'trail', 'frequency', 'duration'],
      additionalProperties: false,
      properties: {
        wallet_address:       { type: 'string', description: 'Solana wallet public key (base58).' },
        token_address:        { type: 'string', description: 'SPL token mint.' },
        action:               { type: 'string', enum: ['trailing_twap_sell', 'trailing_twap_buy'], description: 'sell after retracement from peak (then TWAP); buy after rebound from trough (then TWAP).' },
        trail:                { type: 'integer', minimum: 1, description: 'Trail distance in BPS. 1000 = 10%. See place_trailing_order for full semantics.' },
        frequency:            { type: 'integer', minimum: 1, maximum: 100, description: 'Number of TWAP slices after trail fires.' },
        duration:             { type: 'integer', minimum: 60, description: 'Total seconds the spawned TWAP will run.' },
        amount:               { type: 'integer', minimum: 1, description: 'Total to spend (buy lamports) or sell (token base units) across all TWAP slices.' },
        holdings_percentage:  { type: 'integer', minimum: 1, maximum: 10000, description: 'Sell only: BPS of holdings at TWAP-creation time.' },
        slippage:             { type: 'integer', minimum: 100, maximum: 2500, default: 500, description: 'Slippage per slice (BPS).' },
        expiry_hours:         { type: 'integer', minimum: 1, maximum: 336, default: 144, description: 'Hours until trailing phase auto-cancels.' },
      },
    },
  },
  {
    name: 'place_limit_trailing_order',
    description: `COMBO ORDER: Wait for a limit target, then activate a trailing stop. When the trail triggers, execute as a SINGLE swap (not TWAP).

WHEN TO USE: To enter at a specific mcap, then ride the trend with a trailing stop. Example: "Buy BONK if mcap drops to $500M, then sell with a 15% trailing stop after entry."

WHAT IT DOES: Server waits for limit target. When crossed, sends limit_trailing_activated and starts trailing-stop tracking. When trail retraces enough, sends order_filled with a single unsigned tx.

RETURNS: { wallet, order_id, message: "Limit-Trailing order accepted", target, trail, expiry_hours, params_hash, server_signature }. The order_id stays the same across both phases (limit-watching → trailing-watching → filled). Use check_order to see which phase the order is currently in.

SIDE EFFECTS: Server-side state created — the limit watcher runs until target hits or expiry_hours elapses. Once limit triggers, the trail tracker takes over (high-water for sell, low-water for buy) until reversal exceeds trail BPS. cancel_order works in both phases. expiry_hours covers the LIMIT phase only — once trail activates, the order has no expiry (extend_order resets the limit phase only).`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'target', 'trail'],
      additionalProperties: false,
      properties: {
        wallet_address:       { type: 'string', description: 'Solana wallet public key (base58).' },
        token_address:        { type: 'string', description: 'SPL token mint.' },
        action:               { type: 'string', enum: ['limit_trailing_sell', 'limit_trailing_buy'], description: 'sell when limit hits (then trail until reversal); buy when limit hits (then trail until rebound).' },
        target:               { type: 'integer', minimum: 1, description: 'Market-cap target in BPS vs current mcap at placement.' },
        trail:                { type: 'integer', minimum: 1, description: 'Trail distance in BPS, applied AFTER limit fires. 1000 = 10% retracement.' },
        amount:               { type: 'integer', minimum: 1, description: 'REQUIRED for buy. Lamports of SOL to spend.' },
        holdings_percentage:  { type: 'integer', minimum: 1, maximum: 10000, description: 'REQUIRED for sell. Basis points of holdings.' },
        slippage:             { type: 'integer', minimum: 100, maximum: 2500, default: 500, description: 'Slippage at the single-swap fill (BPS).' },
        expiry_hours:         { type: 'integer', minimum: 1, maximum: 336, default: 144, description: 'Hours until limit phase auto-cancels (before activation).' },
      },
    },
  },
  {
    name: 'place_limit_trailing_twap_order',
    description: `COMBO ORDER (the full chain): Wait for a market-cap limit target → activate trailing stop → on trail trigger, execute exit/entry as TWAP slices.

WHEN TO USE: For the most sophisticated single-tool strategy. Example: "Buy BONK at mcap $500M, then sell with a 15% trailing stop, and when the trail fires distribute the exit over 30 minutes via TWAP."

WHAT IT DOES: Server orchestrates all three phases. Sends limit_trailing_activated when trail starts, limit_trailing_twap_triggered when trail fires, twap_execution per slice. The 11-field params_hash includes target, trail, frequency, and duration — all signed by the server, verified locally.

RETURNS: { wallet, order_id, message: "Limit-Trailing-TWAP order accepted", target, trail, frequency, duration, expiry_hours, params_hash, server_signature }. The parent order_id covers the limit + trailing phases; the spawned TWAP at trail-fire gets its own child order_id (delivered via twap_order_created event). check_order on the parent reports the current phase ("limit-watching", "trailing-watching", or "twap-spawned").

SIDE EFFECTS: Server-side state created — the watcher runs continuously through three phases. cancel_order on the parent works during limit and trailing phases but NOT once the child TWAP has spawned (cancel that TWAP's order_id directly). expiry_hours covers the LIMIT phase only. params_hash is the strongest commitment in the suite (11 fields including target, trail, frequency, duration, slippage) — verified locally before order acceptance.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'target', 'trail', 'frequency', 'duration'],
      additionalProperties: false,
      properties: {
        wallet_address:       { type: 'string', description: 'Solana wallet public key (base58).' },
        token_address:        { type: 'string', description: 'SPL token mint.' },
        action:               { type: 'string', enum: ['limit_trailing_twap_sell', 'limit_trailing_twap_buy'], description: 'Full combo direction.' },
        target:               { type: 'integer', minimum: 1, description: 'Market-cap target in BPS vs current.' },
        trail:                { type: 'integer', minimum: 1, description: 'Trail distance in BPS, applied after limit fires.' },
        frequency:            { type: 'integer', minimum: 1, maximum: 100, description: 'Number of TWAP slices after trail fires.' },
        duration:             { type: 'integer', minimum: 60, description: 'Total seconds the TWAP will run.' },
        amount:               { type: 'integer', minimum: 1, description: 'Total to spend (buy lamports) or sell (token base units) across all TWAP slices.' },
        holdings_percentage:  { type: 'integer', minimum: 1, maximum: 10000, description: 'Sell only: BPS of holdings at TWAP-creation time.' },
        slippage:             { type: 'integer', minimum: 100, maximum: 2500, default: 500, description: 'Slippage per TWAP slice (BPS).' },
        expiry_hours:         { type: 'integer', minimum: 1, maximum: 336, default: 144, description: 'Hours until limit phase auto-cancels.' },
      },
    },
  },
  // ──────────────────────────────────────────────────────────────────────────
  // ORDER MANAGEMENT (WEBSOCKET)
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: 'list_orders',
    description: `Returns all currently active orders (limit, trailing, TWAP, combo) for a wallet. Used to audit pending orders and find order_ids for cancel_order or extend_order.

WHEN TO USE: Periodically, to detect expired orders (the server does NOT push an expiry event — orders silently disappear from results when expiry_hours is reached). Also to confirm that a place_*_order call actually registered.

WHAT IT DOES: Sends { action: "list_orders" } over the WebSocket. Server returns { type: "order_list", orders: [{ order_id, order_type, token_address, target_mcap, trail_bps, amount, holdings_percentage, slippage, expires_at, status, ... }] }.

RETURNS: { wallet, orders: [...] }. Empty array if no active orders. Each order includes its current phase (e.g. limit_trailing_twap can be in "limit-watching", "trailing-watching", or "twap-executing" phases).

SIDE EFFECTS: None — pure read.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58). Must be registered on the WebSocket (via get_wallet_address or connect_websocket) for the request to succeed.' },
      },
    },
  },
  {
    name: 'check_order',
    description: `Returns the current status of a specific order by order_id. More targeted than list_orders.

WHEN TO USE: To check whether a known order has triggered, expired, or been cancelled. Useful when polling for a specific order's outcome rather than scanning the full list.

WHAT IT DOES: Sends { action: "check_order", order_id } over the WebSocket. Server returns { type: "order_status", order_id, status, ... }.

RETURNS: { wallet, order_id, status: "active"|"triggered"|"filled"|"cancelled"|"expired", ... }. If the order doesn't exist (already expired or cancelled), the server returns an error.

SIDE EFFECTS: None — pure read. Does not affect the order state or trigger any server-side processing.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'order_id'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58).' },
        order_id:       { type: 'string', description: 'The order_id returned by a place_*_order call. Format: a server-assigned UUID-like string.' },
      },
    },
  },
  {
    name: 'cancel_order',
    description: `Cancels an active limit, trailing, TWAP, or combo order. Once cancelled, the order is removed server-side and no further fills will arrive.

WHEN TO USE: To kill an order before it triggers (e.g. you no longer want to take that position) or to halt remaining TWAP slices.

WHAT IT DOES: Sends { action: "cancel_order", order_id } over the WebSocket. Server removes the order from its scheduler and confirms with { type: "order_cancelled", order_id } (or { type: "twap_order_cancelled" } for TWAP orders).

RETURNS: { wallet, order_id, status: "cancelled" }. Idempotent — cancelling an already-cancelled or already-filled order returns an error but is safe to retry.

SIDE EFFECTS: Stops all future fills for the order. For partial-fill TWAP orders, slices already executed are not reverted; only remaining slices are skipped.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'order_id'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58).' },
        order_id:       { type: 'string', description: 'The order_id to cancel.' },
      },
    },
  },
  {
    name: 'extend_order',
    description: `Extends the expiry time of an active limit or trailing order. expiry_hours sets the NEW total lifetime (counted from order creation, not from now).

WHEN TO USE: When you want to keep a pending order alive longer than the original expiry_hours allowed (max 336 = 14 days).

WHAT IT DOES: Sends { action: "extend_order", order_id, expiry_hours } over the WebSocket. Server updates the order's expires_at and confirms with { type: "order_extended", order_id }.

RETURNS: { wallet, order_id, expiry_hours, status: "extended" }. Cannot extend TWAP orders (they have no separate expiry — they live exactly duration seconds).

SIDE EFFECTS: Mutates server-side order state (expires_at field). The order continues from the same phase it was in — extending does not reset the trail high-water mark or restart the limit watcher. Idempotent if called with the same expiry_hours that already applies.`,
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'order_id', 'expiry_hours'],
      additionalProperties: false,
      properties: {
        wallet_address: { type: 'string', description: 'Solana wallet public key (base58).' },
        order_id:       { type: 'string', description: 'The order_id to extend.' },
        expiry_hours:   { type: 'integer', minimum: 1, maximum: 336, description: 'New total lifetime in hours, counted from the original creation time. Max 336 (14 days). Cannot be less than the elapsed time since creation.' },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Tool dispatch ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    const result = await callTool(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
      isError: true,
    };
  }
});

async function callTool(name, args) {
  // DRY_RUN gate — short-circuit write actions before any network I/O.
  // Agents/users opt in via TRADEROUTER_DRY_RUN=true; default is false (live).
  if (DRY_RUN && WRITE_ACTION_TOOLS.has(name)) {
    return {
      dry_run: true,
      tool: name,
      args,
      note: 'TRADEROUTER_DRY_RUN=true — no tx submitted and no order placed. Unset or set false to go live.',
    };
  }

  switch (name) {

    case 'get_wallet_address': {
      if (!PRIVATE_KEY_B58) return { configured: false, error: 'TRADEROUTER_PRIVATE_KEY not set' };
      const kp     = getKeypair();
      const wallet = kp.publicKey.toBase58();
      getManager(wallet);   // kick off WS connection
      return { configured: true, wallet_address: wallet };
    }

    case 'build_swap': {
      const { wallet_address, token_address, action, amount, holdings_percentage, slippage = 1500 } = args;
      if (!['buy', 'sell'].includes(action)) return { error: "action must be 'buy' or 'sell'" };
      if (action === 'buy'  && !amount)              return { error: 'amount (lamports) required for buy' };
      if (action === 'sell' && !holdings_percentage) return { error: 'holdings_percentage required for sell' };
      if (slippage < 100 || slippage > 2500)         return { error: 'slippage must be 100–2500 bps' };
      const body = { wallet_address, token_address, action, slippage };
      if (action === 'buy')  body.amount = amount;
      else body.holdings_percentage = holdings_percentage;
      return await post('/swap', body);
    }

    case 'submit_signed_swap': {
      return await post('/protect', { signed_tx_base64: args.signed_tx_base64 });
    }

    case 'auto_swap': {
      const swap = await callTool('build_swap', args);
      if (swap.error || swap.status !== 'success') return swap;
      const signedB64 = signTxB58(swap.data.swap_tx);
      const protect   = await post('/protect', { signed_tx_base64: signedB64 });
      return { swap: swap.data, protect };
    }

    case 'get_holdings': {
      return await post('/holdings', { wallet_address: args.wallet_address });
    }

    case 'get_mcap': {
      const tokens = typeof args.tokens === 'string' ? args.tokens : (args.tokens || []).join(',');
      if (!tokens.trim()) return { error: 'tokens (comma-separated) required' };
      return await get('/mcap', { tokens: tokens.trim() });
    }

    case 'get_flex_card': {
      const { wallet_address, token_address } = args;
      if (!wallet_address || !token_address) return { error: 'wallet_address and token_address required' };
      const url = `${API_BASE}/flex?wallet_address=${encodeURIComponent(wallet_address)}&token_address=${encodeURIComponent(token_address)}`;
      return { url, wallet_address, token_address };
    }

    case 'connect_websocket': {
      const mgr = await getManagerRegistered(args.wallet_address);
      return {
        wallet:  args.wallet_address,
        message: mgr.isConnected ? 'WebSocket connected and registered' : 'WebSocket not yet registered; commands may be queued',
        ...mgr.status(),
      };
    }

    case 'connection_status': {
      const mgr = getManager(args.wallet_address);
      return { wallet: args.wallet_address, ...mgr.status() };
    }

    case 'get_fill_log': {
      const mgr = getManager(args.wallet_address);
      return { wallet: args.wallet_address, fills: mgr.getFillLog() };
    }

    case 'place_limit_order': {
      const { wallet_address, token_address, action, target, amount, holdings_percentage, slippage = 1500, expiry_hours = 144 } = args;
      if (!['sell', 'buy'].includes(action))    return { error: "action must be 'sell' or 'buy'" };
      if (action === 'sell' && !holdings_percentage) return { error: 'holdings_percentage required for sell' };
      if (action === 'buy'  && !amount)              return { error: 'amount required for buy' };
      if (!target || target <= 0)                return { error: 'target must be > 0' };
      if (slippage < 100 || slippage > 2500)     return { error: 'slippage must be 100–2500 bps' };
      if (expiry_hours < 1 || expiry_hours > 336) return { error: 'expiry_hours must be 1–336' };
      const payload = { action, token_address, target, slippage, expiry_hours };
      if (action === 'sell') payload.holdings_percentage = holdings_percentage;
      else payload.amount = amount;
      return await ws(wallet_address, payload, 'order_created');
    }

    case 'place_trailing_order': {
      const { wallet_address, token_address, action, trail, amount, holdings_percentage, slippage = 1500, expiry_hours = 144 } = args;
      if (!['trailing_sell', 'trailing_buy'].includes(action)) return { error: "action must be 'trailing_sell' or 'trailing_buy'" };
      if (action === 'trailing_sell' && !holdings_percentage)  return { error: 'holdings_percentage required for trailing_sell' };
      if (action === 'trailing_buy'  && !amount)               return { error: 'amount required for trailing_buy' };
      if (!trail || trail <= 0)                    return { error: 'trail must be > 0' };
      if (slippage < 100 || slippage > 2500)       return { error: 'slippage must be 100–2500 bps' };
      if (expiry_hours < 1 || expiry_hours > 336)  return { error: 'expiry_hours must be 1–336' };
      const payload = { action, token_address, trail, slippage, expiry_hours };
      if (action === 'trailing_sell') payload.holdings_percentage = holdings_percentage;
      else payload.amount = amount;
      return await ws(wallet_address, payload, 'order_created');
    }

    case 'place_twap_order': {
      const { wallet_address, token_address, action, frequency, duration, amount, holdings_percentage, slippage = 500 } = args;
      if (!['twap_buy', 'twap_sell'].includes(action)) return { error: "action must be 'twap_buy' or 'twap_sell'" };
      if (action === 'twap_sell' && amount == null && holdings_percentage == null) return { error: 'amount or holdings_percentage required for twap_sell' };
      if (action === 'twap_buy' && amount == null) return { error: 'amount (SOL lamports) required for twap_buy' };
      if (!frequency || frequency < 1 || frequency > 100) return { error: 'frequency must be 1–100' };
      if (!duration || duration < 60) return { error: 'duration must be >= 60 seconds' };
      const payload = { action, token_address, frequency, duration, slippage };
      if (action === 'twap_sell') {
        if (amount != null) payload.amount = amount;
        else payload.holdings_percentage = holdings_percentage;
      } else {
        payload.amount = amount;
      }
      return await ws(wallet_address, payload, 'twap_order_created');
    }

    case 'place_limit_twap_order': {
      const { wallet_address, token_address, action, target, frequency, duration, amount, holdings_percentage, slippage = 500, expiry_hours = 144 } = args;
      if (!['limit_twap_sell', 'limit_twap_buy'].includes(action)) return { error: "action must be 'limit_twap_sell' or 'limit_twap_buy'" };
      if (action === 'limit_twap_sell' && amount == null && holdings_percentage == null) return { error: 'amount or holdings_percentage required for limit_twap_sell' };
      if (action === 'limit_twap_buy' && amount == null) return { error: 'amount (SOL lamports) required for limit_twap_buy' };
      if (!target || target <= 0) return { error: 'target must be > 0' };
      if (!frequency || frequency < 1 || frequency > 100) return { error: 'frequency must be 1–100' };
      if (!duration || duration < 60) return { error: 'duration must be >= 60 seconds' };
      const payload = { action, token_address, target, frequency, duration, slippage, expiry_hours };
      if (action === 'limit_twap_sell') {
        if (amount != null) payload.amount = amount;
        else payload.holdings_percentage = holdings_percentage;
      } else {
        payload.amount = amount;
      }
      return await ws(wallet_address, payload, 'order_created');
    }

    case 'place_trailing_twap_order': {
      const { wallet_address, token_address, action, trail, frequency, duration, amount, holdings_percentage, slippage = 500, expiry_hours = 144 } = args;
      if (!['trailing_twap_sell', 'trailing_twap_buy'].includes(action)) return { error: "action must be 'trailing_twap_sell' or 'trailing_twap_buy'" };
      if (action === 'trailing_twap_sell' && amount == null && holdings_percentage == null) return { error: 'amount or holdings_percentage required for trailing_twap_sell' };
      if (action === 'trailing_twap_buy' && amount == null) return { error: 'amount (SOL lamports) required for trailing_twap_buy' };
      if (!trail || trail <= 0) return { error: 'trail must be > 0' };
      if (!frequency || frequency < 1 || frequency > 100) return { error: 'frequency must be 1–100' };
      if (!duration || duration < 60) return { error: 'duration must be >= 60 seconds' };
      const payload = { action, token_address, trail, frequency, duration, slippage, expiry_hours };
      if (action === 'trailing_twap_sell') {
        if (amount != null) payload.amount = amount;
        else payload.holdings_percentage = holdings_percentage;
      } else {
        payload.amount = amount;
      }
      return await ws(wallet_address, payload, 'order_created');
    }

    case 'place_limit_trailing_order': {
      const { wallet_address, token_address, action, target, trail, amount, holdings_percentage, slippage = 500, expiry_hours = 144 } = args;
      if (!['limit_trailing_sell', 'limit_trailing_buy'].includes(action)) return { error: "action must be 'limit_trailing_sell' or 'limit_trailing_buy'" };
      if (action === 'limit_trailing_sell' && amount == null && holdings_percentage == null) return { error: 'amount or holdings_percentage required for limit_trailing_sell' };
      if (action === 'limit_trailing_buy' && amount == null) return { error: 'amount (SOL lamports) required for limit_trailing_buy' };
      if (!target || target <= 0) return { error: 'target must be > 0' };
      if (!trail || trail <= 0) return { error: 'trail must be > 0' };
      const payload = { action, token_address, target, trail, slippage, expiry_hours };
      if (action === 'limit_trailing_sell') {
        if (amount != null) payload.amount = amount;
        else payload.holdings_percentage = holdings_percentage;
      } else {
        payload.amount = amount;
      }
      return await ws(wallet_address, payload, 'order_created');
    }

    case 'place_limit_trailing_twap_order': {
      const { wallet_address, token_address, action, target, trail, frequency, duration, amount, holdings_percentage, slippage = 500, expiry_hours = 144 } = args;
      if (!['limit_trailing_twap_sell', 'limit_trailing_twap_buy'].includes(action)) return { error: "action must be 'limit_trailing_twap_sell' or 'limit_trailing_twap_buy'" };
      if (action === 'limit_trailing_twap_sell' && amount == null && holdings_percentage == null) return { error: 'amount or holdings_percentage required for limit_trailing_twap_sell' };
      if (action === 'limit_trailing_twap_buy' && amount == null) return { error: 'amount (SOL lamports) required for limit_trailing_twap_buy' };
      if (!target || target <= 0) return { error: 'target must be > 0' };
      if (!trail || trail <= 0) return { error: 'trail must be > 0' };
      if (!frequency || frequency < 1 || frequency > 100) return { error: 'frequency must be 1–100' };
      if (!duration || duration < 60) return { error: 'duration must be >= 60 seconds' };
      const payload = { action, token_address, target, trail, frequency, duration, slippage, expiry_hours };
      if (action === 'limit_trailing_twap_sell') {
        if (amount != null) payload.amount = amount;
        else payload.holdings_percentage = holdings_percentage;
      } else {
        payload.amount = amount;
      }
      return await ws(wallet_address, payload, 'order_created');
    }

    case 'list_orders': {
      return await ws(args.wallet_address, { action: 'list_orders', wallet_address: args.wallet_address }, 'order_list');
    }

    case 'check_order': {
      return await ws(args.wallet_address, { action: 'check_order', order_id: args.order_id }, 'order_status');
    }

    case 'cancel_order': {
      return await ws(args.wallet_address, { action: 'cancel_order', order_id: args.order_id }, 'order_cancelled', 10000);
    }

    case 'extend_order': {
      if (args.expiry_hours < 1 || args.expiry_hours > 336) return { error: 'expiry_hours must be 1–336' };
      return await ws(args.wallet_address, { action: 'extend_order', order_id: args.order_id, expiry_hours: args.expiry_hours }, 'order_extended', 10000);
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  // Pre-connect WS if private key is configured
  if (PRIVATE_KEY_B58) {
    try {
      const kp     = getKeypair();
      const wallet = kp.publicKey.toBase58();
      log('info', `Wallet: ${wallet}`);
      const mgr = getManager(wallet);
      // Don't block startup — let it connect in background
      mgr.waitRegistered(WS_STARTUP_WAIT_MS).then(ok => {
        if (ok) log('info', `WS registered for …${wallet.slice(-6)}`);
        else    log('warn', `WS did not register within ${WS_STARTUP_WAIT_MS / 1000}s; background reconnect continues`);
      });
    } catch (e) {
      log('warn', `Pre-connect skipped: ${e.message}`);
    }
  } else {
    log('warn', 'TRADEROUTER_PRIVATE_KEY not set — WS auth and auto-sign unavailable');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'traderouter MCP server running (stdio)');
}

// Only start the server when this file is the entry point. When imported from
// tests (e.g. `import { getOrderCreatedPreimage } from './trade-router-mcp.mjs'`),
// we want the functions to be reachable without booting the stdio transport.
import { fileURLToPath } from 'node:url';
const __entryIsThisFile = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (__entryIsThisFile) {
  main().catch(e => {
    log('error', e.message);
    process.exit(1);
  });
}
