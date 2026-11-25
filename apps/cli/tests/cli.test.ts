import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'src', 'cli.js');

test('evalshield CLI supports import -> check -> report end-to-end on local sqlite', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evalshield-cli-'));
  const dbPath = join(tempDir, 'test.sqlite');
  const csvPath = join(tempDir, 'fills.csv');

  writeFileSync(
    csvPath,
    [
      'Fill ID,Order ID,Timestamp,_timestamp,Side,Quantity,Price,Contract,Commission',
      'F1,O1,2026-03-18 09:35:00,2026-03-18T13:35:00.000Z,Buy,1,5000.00,MESH6,0.62',
      'F2,O2,2026-03-18 09:42:00,2026-03-18T13:42:00.000Z,Sell,1,5020.00,MESH6,0.62'
    ].join('\n'),
    'utf8'
  );

  try {
    const importOut = execFileSync(
      process.execPath,
      [CLI_ENTRY, 'import', '--file', csvPath, '--db', dbPath, '--json'],
      { encoding: 'utf8' }
    );
    const imp = JSON.parse(importOut) as { ok: boolean; account: { realizedBalance: number } };
    assert.equal(imp.ok, true);
    // +20 pts * $5 - $1.24 = +$98.76 -> 50098.76
    assert.equal(imp.account.realizedBalance, 50_098.76);

    const checkOut = execFileSync(
      process.execPath,
      [
        CLI_ENTRY,
        'check',
        '--symbol',
        'MES',
        '--stop-ticks',
        '8',
        '--atr',
        '2.0',
        '--skip-globex',
        '--db',
        dbPath,
        '--json'
      ],
      { encoding: 'utf8' }
    );
    const chk = JSON.parse(checkOut) as {
      ok: boolean;
      result: { maxContractsAllowed: number; remainingBuffer: number };
    };
    assert.equal(chk.ok, true);
    assert.ok(chk.result.maxContractsAllowed >= 1);
    assert.equal(chk.result.remainingBuffer, 800);

    const reportOut = execFileSync(
      process.execPath,
      [CLI_ENTRY, 'report', '--db', dbPath, '--json'],
      { encoding: 'utf8' }
    );
    const rep = JSON.parse(reportOut) as {
      ok: boolean;
      scorecard: { totalTrades: number; netPnlUsd: number };
    };
    assert.equal(rep.ok, true);
    assert.equal(rep.scorecard.totalTrades, 1);
    assert.equal(rep.scorecard.netPnlUsd, 98.76);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
