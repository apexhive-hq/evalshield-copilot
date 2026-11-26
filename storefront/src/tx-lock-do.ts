export type Tier = 'solo' | 'team' | 'enterprise';

export interface DurableClaimRecord {
  scope: string;
  txHash: string;
  payer: string;
  tier: Tier;
  paidAtomic: string;
  claimedAt: number;
}

interface DoStateLike {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
  };
}

/**
 * Strongly-consistent Cloudflare Durable Object locking each txHash atomically.
 * Serializes concurrent HTTP claim attempts for the same txHash inside a single-threaded
 * DO instance, eliminating Workers KV eventual-consistency double-claim races.
 */
export class TxClaimLockDO {
  private readonly ctx: DoStateLike;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DoStateLike) {
    this.ctx = ctx;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    return this.runExclusive(async () => {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/claim') {
        return Response.json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
      }

      const body = (await request.json()) as Record<string, unknown>;
      const scope = String(body.scope ?? 'storefront:evalshield-copilot');
      const txHash = String(body.txHash ?? '').toLowerCase();
      const payer = String(body.payer ?? '').toLowerCase();
      const tier = String(body.tier ?? '') as Tier;
      const paidAtomic = String(body.paidAtomic ?? '0');

      if (!txHash || !payer || (tier !== 'solo' && tier !== 'team' && tier !== 'enterprise')) {
        return Response.json({ ok: false, error: 'INVALID_CLAIM_PARAMS' }, { status: 400 });
      }

      const existing = await this.ctx.storage.get<DurableClaimRecord>('claim');
      if (existing) {
        if (existing.scope !== scope) {
          return Response.json(
            {
              ok: false,
              error: 'TX_ALREADY_CLAIMED_ELSEWHERE',
              message: `Already claimed on ${existing.scope}.`
            },
            { status: 403 }
          );
        }
        if (existing.payer.toLowerCase() === payer && existing.tier === tier) {
          return Response.json({ ok: true, reclaimed: true, record: existing });
        }
        return Response.json(
          {
            ok: false,
            error: 'TX_ALREADY_CLAIMED',
            message: 'Transaction already claimed by another payer or tier.'
          },
          { status: 403 }
        );
      }

      const record: DurableClaimRecord = {
        scope,
        txHash,
        payer,
        tier,
        paidAtomic,
        claimedAt: Date.now()
      };
      await this.ctx.storage.put('claim', record);
      return Response.json({ ok: true, reclaimed: false, record });
    });
  }
}
