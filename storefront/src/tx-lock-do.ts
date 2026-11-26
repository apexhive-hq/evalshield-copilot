export type Tier = 'solo' | 'team' | 'enterprise';

export interface DurableClaimRecord {
  scope: string;
  txHash: string;
  payer: string;
  tier: Tier;
  paidAtomic: string;
  claimedAt: number;
}

export interface DurableChallengeRecord {
  nonce: string;
  txHash: string;
  tier: Tier;
  ts: number;
  message: string;
  expiresAtMs: number;
  consumed: boolean;
}

export interface DurableDownloadGrantRecord {
  txHash: string;
  payer: string;
  tier: Tier;
  remainingDownloads: number;
  createdAt: number;
  expiresAtMs: number;
  licenseToken: string;
}

interface DoStateLike {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete?(key: string): Promise<boolean>;
    setAlarm?(scheduledTime: number | Date): Promise<void>;
  };
}

/**
 * Strongly-consistent Cloudflare Durable Object managing:
 * 1. Atomic transaction claim locking (`/claim`)
 * 2. Challenge nonce lifecycle (`/challenge/create`, `/challenge/check`, `/challenge/consume`)
 * 3. Commercial download grant redemption (`/download/create`, `/download/redeem`)
 *
 * All operations for a given DO key are serialized inside a single-threaded instance,
 * eliminating Workers KV eventual-consistency and read-modify-write races.
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

  private async deleteOrInvalidate(key: string, tombValue: unknown): Promise<void> {
    if (typeof this.ctx.storage.delete === 'function') {
      await this.ctx.storage.delete(key);
    } else {
      await this.ctx.storage.put(key, tombValue);
    }
  }

  async alarm(): Promise<void> {
    await this.runExclusive(async () => {
      const now = Date.now();
      let nextAlarm: number | null = null;

      const ch = await this.ctx.storage.get<DurableChallengeRecord>('challenge');
      if (ch) {
        if (ch.consumed || !Number.isFinite(ch.expiresAtMs) || now >= ch.expiresAtMs) {
          await this.deleteOrInvalidate('challenge', { ...ch, consumed: true });
        } else {
          nextAlarm = nextAlarm === null ? ch.expiresAtMs : Math.min(nextAlarm, ch.expiresAtMs);
        }
      }

      const grant = await this.ctx.storage.get<DurableDownloadGrantRecord>('grant');
      if (grant) {
        if (grant.remainingDownloads <= 0 || !Number.isFinite(grant.expiresAtMs) || now >= grant.expiresAtMs) {
          await this.deleteOrInvalidate('grant', { ...grant, remainingDownloads: 0 });
        } else {
          nextAlarm = nextAlarm === null ? grant.expiresAtMs : Math.min(nextAlarm, grant.expiresAtMs);
        }
      }

      if (nextAlarm !== null && typeof this.ctx.storage.setAlarm === 'function') {
        await this.ctx.storage.setAlarm(nextAlarm);
      }
    });
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    return this.runExclusive(async () => {
      const url = new URL(request.url);
      if (request.method !== 'POST') {
        return Response.json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
      }

      if (url.pathname === '/claim') {
        const body = (await request.json()) as Record<string, unknown>;
        const scope = String(body.scope ?? 'storefront:evalshield-copilot');
        const txHash = String(body.txHash ?? '').toLowerCase();
        const payer = String(body.payer ?? '').toLowerCase();
        const tier = String(body.tier ?? '') as Tier;
        const paidAtomic = String(body.paidAtomic ?? '0');

        if (!txHash || !payer || (tier !== 'team' && tier !== 'enterprise')) {
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
      }

      if (url.pathname === '/challenge/create') {
        const body = (await request.json()) as Partial<DurableChallengeRecord>;
        const tsNum = Number(body.ts);
        const expNum = Number(body.expiresAtMs);
        if (
          !body.nonce ||
          !body.txHash ||
          !body.tier ||
          !body.message ||
          !Number.isFinite(tsNum) ||
          !Number.isFinite(expNum) ||
          expNum <= Date.now()
        ) {
          return Response.json({ ok: false, error: 'INVALID_CHALLENGE_PARAMS' }, { status: 400 });
        }
        const record: DurableChallengeRecord = {
          nonce: String(body.nonce),
          txHash: String(body.txHash).toLowerCase(),
          tier: body.tier,
          ts: tsNum,
          message: String(body.message),
          expiresAtMs: expNum,
          consumed: false
        };
        await this.ctx.storage.put('challenge', record);
        if (typeof this.ctx.storage.setAlarm === 'function') {
          await this.ctx.storage.setAlarm(expNum);
        }
        return Response.json({ ok: true });
      }

      if (url.pathname === '/challenge/check' || url.pathname === '/challenge/consume') {
        const body = (await request.json()) as { txHash?: string; tier?: Tier };
        const existing = await this.ctx.storage.get<DurableChallengeRecord>('challenge');
        if (!existing || existing.consumed || Date.now() > existing.expiresAtMs) {
          if (existing) {
            await this.deleteOrInvalidate('challenge', { ...existing, consumed: true });
          }
          return Response.json(
            {
              ok: false,
              error: 'CHALLENGE_EXPIRED_OR_MISSING',
              message: 'Challenge expired (>300s) or unknown.'
            },
            { status: 403 }
          );
        }
        const txLower = String(body.txHash ?? '').toLowerCase();
        if (existing.txHash !== txLower || existing.tier !== body.tier) {
          await this.deleteOrInvalidate('challenge', { ...existing, consumed: true });
          return Response.json(
            {
              ok: false,
              error: 'CHALLENGE_MISMATCH_OR_EXPIRED',
              message: 'Challenge mismatch or expired.'
            },
            { status: 403 }
          );
        }
        if (url.pathname === '/challenge/consume') {
          await this.deleteOrInvalidate('challenge', { ...existing, consumed: true });
        }
        return Response.json({ ok: true, challenge: existing });
      }

      if (url.pathname === '/download/create') {
        const body = (await request.json()) as Partial<DurableDownloadGrantRecord>;
        const expNum = Number(body.expiresAtMs);
        const remNum = Number(body.remainingDownloads ?? 3);
        const createdNum = Number(body.createdAt ?? Date.now());
        if (
          !body.txHash ||
          !body.payer ||
          !body.tier ||
          !body.licenseToken ||
          !Number.isFinite(expNum) ||
          expNum <= Date.now() ||
          !Number.isFinite(remNum) ||
          !Number.isFinite(createdNum)
        ) {
          return Response.json({ ok: false, error: 'INVALID_DOWNLOAD_PARAMS' }, { status: 400 });
        }
        const record: DurableDownloadGrantRecord = {
          txHash: String(body.txHash).toLowerCase(),
          payer: String(body.payer),
          tier: body.tier,
          remainingDownloads: Math.max(1, Math.trunc(remNum)),
          createdAt: createdNum,
          expiresAtMs: expNum,
          licenseToken: String(body.licenseToken)
        };
        await this.ctx.storage.put('grant', record);
        if (typeof this.ctx.storage.setAlarm === 'function') {
          await this.ctx.storage.setAlarm(expNum);
        }
        return Response.json({ ok: true });
      }

      if (url.pathname === '/download/redeem') {
        const grant = await this.ctx.storage.get<DurableDownloadGrantRecord>('grant');
        if (!grant || Date.now() > grant.expiresAtMs) {
          if (grant) {
            await this.deleteOrInvalidate('grant', { ...grant, remainingDownloads: 0 });
          }
          return Response.json(
            {
              ok: false,
              error: 'DOWNLOAD_TOKEN_EXPIRED',
              message: 'Download grant expired or exhausted.'
            },
            { status: 403 }
          );
        }
        if (grant.remainingDownloads <= 0) {
          await this.deleteOrInvalidate('grant', { ...grant, remainingDownloads: 0 });
          return Response.json(
            { ok: false, error: 'DOWNLOAD_LIMIT_REACHED', message: 'Download limit reached.' },
            { status: 403 }
          );
        }
        const nextRemaining = grant.remainingDownloads - 1;
        if (nextRemaining <= 0) {
          await this.deleteOrInvalidate('grant', { ...grant, remainingDownloads: 0 });
        } else {
          await this.ctx.storage.put('grant', { ...grant, remainingDownloads: nextRemaining });
        }
        return Response.json({
          ok: true,
          grant: { ...grant, remainingDownloads: nextRemaining }
        });
      }

      return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
    });
  }
}
