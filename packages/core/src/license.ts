import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import type { EvalShieldLicensePayload, LicenseVerificationResult } from './types.js';

export const TOKEN_PREFIX = 'EVALSHIELD-PRO-v1.';

export const DEFAULT_EVALSHIELD_PUBLIC_KEY_SPKI_B64 =
  'MCowBQYDK2VwAyEArz/+yUqh9Alo5B2DPD23q2vbvAuPPL5m1zqtHg66cA0=';

const LicensePayloadSchema = z.object({
  v: z.literal(1),
  product: z.literal('evalshield-copilot'),
  tier: z.enum(['solo', 'team']),
  maxAccounts: z.number().int().positive().nullable().optional(),
  payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive().nullable()
});

function toPublicKeyObject(spkiB64: string) {
  const der = Buffer.from(spkiB64.trim(), 'base64');
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function getMaxAllowedAccounts(verification: LicenseVerificationResult): number | null {
  if (!verification.valid || verification.tier === 'free') {
    return 1;
  }
  if (verification.tier === 'team') {
    return verification.maxAccounts ?? null;
  }
  return verification.maxAccounts ?? 20;
}

export function verifyEvalShieldLicenseToken(
  token: string,
  options?: { publicKeySpkiB64?: string; nowMs?: number }
): LicenseVerificationResult {
  const trimmed = token.trim();
  if (!trimmed.startsWith(TOKEN_PREFIX)) {
    return {
      valid: false,
      tier: 'free',
      maxAccounts: 1,
      reason: `Invalid license prefix (expected ${TOKEN_PREFIX}).`
    };
  }

  const parts = trimmed.slice(TOKEN_PREFIX.length).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return {
      valid: false,
      tier: 'free',
      maxAccounts: 1,
      reason: 'Malformed license token structure.'
    };
  }

  const [payloadB64Url, sigB64Url] = parts;
  const spkiB64 =
    options?.publicKeySpkiB64 ||
    process.env.EVALSHIELD_PUBLIC_KEY ||
    DEFAULT_EVALSHIELD_PUBLIC_KEY_SPKI_B64;

  let sigOk = false;
  try {
    const pubKey = toPublicKeyObject(spkiB64);
    const signingInput = Buffer.from(`${TOKEN_PREFIX}${payloadB64Url}`, 'utf8');
    const sigBytes = Buffer.from(sigB64Url, 'base64url');
    sigOk = verify(null, signingInput, pubKey, sigBytes);
  } catch (err) {
    return {
      valid: false,
      tier: 'free',
      maxAccounts: 1,
      reason: `Ed25519 verification error: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  if (!sigOk) {
    return {
      valid: false,
      tier: 'free',
      maxAccounts: 1,
      reason: 'Invalid Ed25519 signature.'
    };
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(Buffer.from(payloadB64Url, 'base64url').toString('utf8'));
  } catch {
    return {
      valid: false,
      tier: 'free',
      maxAccounts: 1,
      reason: 'Malformed JSON payload in license token.'
    };
  }

  const parsed = LicensePayloadSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    return {
      valid: false,
      tier: 'free',
      maxAccounts: 1,
      reason: 'License payload failed schema validation.'
    };
  }

  const payload: EvalShieldLicensePayload = {
    v: parsed.data.v,
    product: parsed.data.product,
    tier: parsed.data.tier,
    maxAccounts: parsed.data.maxAccounts ?? (parsed.data.tier === 'solo' ? 20 : null),
    payer: parsed.data.payer,
    txHash: parsed.data.txHash,
    issuedAt: parsed.data.issuedAt,
    expiresAt: parsed.data.expiresAt
  };

  const nowMs = options?.nowMs ?? Date.now();
  if (payload.expiresAt !== null && nowMs > payload.expiresAt) {
    return {
      valid: false,
      tier: 'free',
      maxAccounts: 1,
      reason: 'License token has expired.'
    };
  }

  return {
    valid: true,
    tier: payload.tier,
    maxAccounts: payload.maxAccounts,
    payload
  };
}
