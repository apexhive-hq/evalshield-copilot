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

export async function rpcCallSingle<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(6000)
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message ?? 'unknown'}`);
  return json.result as T;
}

export async function rpcCallWithFailover<T>(
  urls: string[],
  method: string,
  params: unknown[]
): Promise<T> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await rpcCallSingle<T>(url, method, params);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `All Base RPC endpoints failed: ${lastError instanceof Error ? lastError.message : 'unknown'}`
  );
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
  const client = createPublicClient({
    chain: base,
    transport: custom({
      async request({ method, params }) {
        return rpcCallWithFailover(
          input.rpcUrls,
          method,
          Array.isArray(params) ? params : []
        );
      }
    })
  });

  return client
    .verifyMessage({
      address: input.address as `0x${string}`,
      message: input.message,
      signature: input.signature as `0x${string}`
    })
    .catch(() => false);
}
