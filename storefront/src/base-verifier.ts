import { createPublicClient, custom } from 'viem';
import { base } from 'viem/chains';

export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const STRICT_HEX_RE = /^0x[0-9a-fA-F]+$/;

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}

export interface RpcReceipt {
  status: string;
  blockNumber: string;
  logs: RpcLog[];
}

export function parseStrictHexBigInt(val: unknown): bigint | null {
  if (typeof val !== 'string' || !STRICT_HEX_RE.test(val)) return null;
  return BigInt(val);
}

export function normalizeAddressFromTopic(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`;
}

export class RpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcUnavailableError';
  }
}

export async function rpcCallSingle<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(6000)
    });
  } catch (err) {
    throw new RpcUnavailableError(err instanceof Error ? err.message : 'RPC fetch error');
  }
  if (!res.ok) throw new RpcUnavailableError(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
  if (json.error) {
    const msg = json.error.message ?? 'unknown';
    // Treat contract execution reverts as deterministic contract failures, not RPC outages
    if (json.error.code === 3 || /revert/i.test(msg)) {
      throw new Error(`RPC revert: ${msg}`);
    }
    throw new RpcUnavailableError(`RPC error: ${msg}`);
  }
  return json.result as T;
}

export async function rpcCallWithFailover<T>(
  urls: string[],
  method: string,
  params: unknown[]
): Promise<T> {
  let lastError: unknown;
  let allRpcUnavailable = true;
  for (const url of urls) {
    try {
      return await rpcCallSingle<T>(url, method, params);
    } catch (err) {
      lastError = err;
      if (!(err instanceof RpcUnavailableError)) {
        allRpcUnavailable = false;
      }
    }
  }
  const message = `All Base RPC endpoints failed: ${lastError instanceof Error ? lastError.message : 'unknown'}`;
  if (allRpcUnavailable) {
    throw new RpcUnavailableError(message);
  }
  throw new Error(message);
}

export function sumBaseUsdcTransfers(
  logs: RpcLog[] | undefined,
  expectedUsdcContract: string,
  expectedPayTo: string
): Map<string, bigint> {
  const expectedUsdc = expectedUsdcContract.toLowerCase();
  const expectedTo = expectedPayTo.toLowerCase();
  const payerTotals = new Map<string, bigint>();
  for (const log of logs ?? []) {
    if (log.address?.toLowerCase() !== expectedUsdc) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    const from = normalizeAddressFromTopic(log.topics[1]);
    const to = normalizeAddressFromTopic(log.topics[2]);
    if (to !== expectedTo) continue;
    const value = parseStrictHexBigInt(log.data);
    if (value === null) continue;
    payerTotals.set(from, (payerTotals.get(from) ?? 0n) + value);
  }
  return payerTotals;
}

/**
 * Verifies EOA (EIP-191) and Smart Contract Wallet (ERC-1271 / EIP-6492) signatures
 * via viem publicClient.verifyMessage backed by multi-RPC Base failover transport.
 */
export async function verifySmartWalletOrEoaSignature(input: {
  rpcUrls: string[];
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  let transportOutage: RpcUnavailableError | null = null;
  const client = createPublicClient({
    chain: base,
    transport: custom({
      async request({ method, params }) {
        try {
          return await rpcCallWithFailover(
            input.rpcUrls,
            method,
            Array.isArray(params) ? params : []
          );
        } catch (err) {
          if (err instanceof RpcUnavailableError) {
            transportOutage = err;
          }
          throw err;
        }
      }
    })
  });

  try {
    const ok = await client.verifyMessage({
      address: input.address as `0x${string}`,
      message: input.message,
      signature: input.signature as `0x${string}`
    });
    if (!ok && transportOutage) {
      throw transportOutage;
    }
    return ok;
  } catch (err) {
    if (transportOutage) throw transportOutage;
    if (err instanceof RpcUnavailableError) throw err;
    return false;
  }
}
