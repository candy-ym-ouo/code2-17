import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OperationLedger,
  LedgerError,
  loadCommand,
  routeCommand,
  settleCommand
} from '../ledger.js';

const EMPTY_STATE = { manifest: {}, routes: {}, balances: {} };

function makeLedgerFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ledger.log');
}

function readRecords(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test('装载、路线、结算命令按顺序生效并返回结果', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);

  const loadResult = ledger.execute(loadCommand('cmd-load-1', { shipmentId: 'PKG-1', cargo: '药品', weight: 2.5 }));
  assert.deepEqual(loadResult, { shipmentId: 'PKG-1', status: 'loaded', manifestSize: 1 });

  const routeResult = ledger.execute(routeCommand('cmd-route-1', { shipmentId: 'PKG-1', route: '天枢港→曦光岛', cost: 12 }));
  assert.equal(routeResult.replaced, false);

  const settleResult = ledger.execute(settleCommand('cmd-settle-1', { account: '晨曦商会', amount: 120 }));
  assert.deepEqual(settleResult, { account: '晨曦商会', amount: 120, balanceBefore: 0, balanceAfter: 120 });

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.manifest['PKG-1'].cargo, '药品');
  assert.equal(snapshot.routes['PKG-1'].route, '天枢港→曦光岛');
  assert.equal(snapshot.balances['晨曦商会'], 120);
  assert.equal(ledger.size, 3);
  ledger.close();
});

test('同一 cmdId 重试不会重复执行，结果以首次记录为准', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);

  const first = ledger.execute(settleCommand('s1', { account: 'a', amount: 100 }));
  const retry = ledger.execute(settleCommand('s1', { account: 'a', amount: 100 }));
  const conflicting = ledger.execute(settleCommand('s1', { account: 'a', amount: 999 }));

  assert.deepEqual(retry, first);
  assert.deepEqual(conflicting, first);
  assert.equal(ledger.snapshot().balances.a, 100);

  const applied = readRecords(file).filter((record) => record.kind === 'APPLIED' && record.cmdId === 's1');
  assert.equal(applied.length, 1);
  ledger.close();
});

test('重试合并批次中的重复命令只执行一次，整批重投也安全', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);

  const batch = [
    loadCommand('L1', { shipmentId: 'PKG-1', cargo: '种子', weight: 1 }),
    settleCommand('S1', { account: 'a', amount: 50 }),
    loadCommand('L1', { shipmentId: 'PKG-1', cargo: '种子', weight: 1 }),
    settleCommand('S1', { account: 'a', amount: 50 })
  ];

  const firstRun = ledger.merge(batch);
  assert.equal(firstRun.length, 4);
  assert.deepEqual(firstRun[2], firstRun[0]);
  assert.deepEqual(firstRun[3], firstRun[1]);
  assert.equal(ledger.snapshot().balances.a, 50);
  assert.equal(Object.keys(ledger.snapshot().manifest).length, 1);

  // 网络重试导致整批重投：结果一致，且不重复生效。
  const retry = ledger.merge(batch);
  assert.deepEqual(retry, firstRun);
  assert.equal(ledger.snapshot().balances.a, 50);
  assert.equal(ledger.size, 2);
  ledger.close();
});

test('校验失败的命令记入 ABORTED，不改变状态，修正后可重新提交', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);

  assert.throws(
    () => ledger.execute(routeCommand('r1', { shipmentId: 'GHOST', route: '天枢港→雾礁岛', cost: 1 })),
    (error) => error instanceof LedgerError && error.code === 'NOT_LOADED'
  );
  assert.throws(() => ledger.execute(settleCommand('s-zero', { account: 'a', amount: 0 })), /非零/);
  assert.throws(() => ledger.execute({ cmdId: 'x1', type: 'FLY', payload: {} }), /未知命令类型/);
  assert.deepEqual(ledger.snapshot(), EMPTY_STATE);

  const kinds = readRecords(file).map((record) => record.kind);
  assert.equal(kinds.filter((kind) => kind === 'ABORTED').length, 3);

  // 失败的命令不占用幂等键：先补上装载，原 cmdId 的路线命令即可生效。
  ledger.execute(loadCommand('load-ghost', { shipmentId: 'GHOST', cargo: '工具', weight: 3 }));
  const routed = ledger.execute(routeCommand('r1', { shipmentId: 'GHOST', route: '天枢港→雾礁岛', cost: 1 }));
  assert.equal(routed.shipmentId, 'GHOST');
  ledger.close();
});

test('回滚按后进先出顺序补偿，补偿记录落盘', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);

  ledger.execute(loadCommand('c1', { shipmentId: 'PKG-1', cargo: '信件', weight: 0.5 }));
  ledger.execute(routeCommand('c2', { shipmentId: 'PKG-1', route: '天枢港→铸炉岛', cost: 8 }));
  ledger.execute(settleCommand('c3', { account: 'a', amount: 80 }));

  const rolledBack = ledger.rollback(2);
  assert.deepEqual(rolledBack, ['c3', 'c2']);

  const snapshot = ledger.snapshot();
  assert.equal(Object.keys(snapshot.manifest).length, 1);
  assert.deepEqual(snapshot.routes, {});
  assert.deepEqual(snapshot.balances, {});

  const rollbacks = readRecords(file)
    .filter((record) => record.kind === 'ROLLED_BACK')
    .map((record) => record.cmdId);
  assert.deepEqual(rollbacks, ['c3', 'c2']);
  ledger.close();
});

test('事务内任意一步失败都会补偿已执行的命令', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);

  assert.throws(
    () => ledger.transaction((tx) => {
      tx.execute(loadCommand('t1', { shipmentId: 'PKG-1', cargo: '药品', weight: 2 }));
      tx.execute(settleCommand('t2', { account: 'a', amount: 40 }));
      throw new Error('下游故障');
    }),
    /下游故障/
  );
  assert.deepEqual(ledger.snapshot(), EMPTY_STATE);
  ledger.close();

  // 恢复后补偿同样生效，状态仍为空。
  const recovered = new OperationLedger(file);
  assert.deepEqual(recovered.snapshot(), EMPTY_STATE);
  assert.equal(recovered.size, 0);
  recovered.close();
});

test('恢复后命令顺序与执行结果保持原样', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);

  const commands = [
    loadCommand('k1', { shipmentId: 'PKG-1', cargo: '药品', weight: 2 }),
    loadCommand('k2', { shipmentId: 'PKG-2', cargo: '信件', weight: 0.5 }),
    routeCommand('k3', { shipmentId: 'PKG-1', route: '天枢港→雾礁岛', cost: 20 }),
    settleCommand('k4', { account: '雾礁灯塔', amount: 200 }),
    settleCommand('k5', { account: '雾礁灯塔', amount: -30 })
  ];
  const resultsBefore = commands.map((command) => ledger.execute(command));
  ledger.rollback(1); // 撤销 k5
  const k6Result = ledger.execute(settleCommand('k6', { account: '雾礁灯塔', amount: 15 }));
  const snapshotBefore = ledger.snapshot();
  const resultOfK4 = ledger.resultOf('k4');
  ledger.close();

  const recovered = new OperationLedger(file);
  assert.deepEqual(recovered.snapshot(), snapshotBefore);
  assert.deepEqual(recovered.resultOf('k4'), resultOfK4);

  // 重放仍处于生效状态的命令：结果与首次完全一致，且不会重复生效。
  const committed = [...commands.slice(0, 4), settleCommand('k6', { account: '雾礁灯塔', amount: 15 })];
  const resultsAfter = committed.map((command) => recovered.execute(command));
  assert.deepEqual(resultsAfter, [...resultsBefore.slice(0, 4), k6Result]);
  assert.equal(recovered.snapshot().balances['雾礁灯塔'], 215);
  recovered.close();
});

test('崩溃残留的孤立 INTENT 恢复时视为未执行', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);
  ledger.execute(settleCommand('ok-1', { account: 'a', amount: 10 }));
  ledger.close();

  // 模拟崩溃：INTENT 已落盘，APPLIED 未来得及写入。
  const seq = readRecords(file).length;
  fs.appendFileSync(file, `${JSON.stringify({
    seq: seq + 1,
    kind: 'INTENT',
    cmdId: 'ghost',
    commandType: 'SETTLE',
    payload: { account: 'a', amount: 999 }
  })}\n`);

  const recovered = new OperationLedger(file);
  assert.equal(recovered.has('ghost'), false);
  assert.equal(recovered.snapshot().balances.a, 10);

  // 恢复后可以继续正常写入。
  recovered.execute(settleCommand('ok-2', { account: 'a', amount: 5 }));
  assert.equal(recovered.snapshot().balances.a, 15);
  recovered.close();
});

test('末尾撕裂的写入在恢复时被截断，不影响后续使用', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);
  ledger.execute(settleCommand('ok-1', { account: 'a', amount: 10 }));
  ledger.close();

  // 模拟崩溃：最后一条记录只写了一半。
  fs.appendFileSync(file, '{"seq":99,"kind":"APPLIED","cmdId":"torn"');

  const recovered = new OperationLedger(file);
  assert.equal(recovered.has('torn'), false);
  assert.equal(recovered.snapshot().balances.a, 10);
  recovered.execute(settleCommand('ok-2', { account: 'a', amount: 5 }));
  recovered.close();

  // 撕裂部分已被截断，再次恢复不会读到文件中间的坏行。
  const again = new OperationLedger(file);
  assert.equal(again.snapshot().balances.a, 15);
  again.close();
});

test('回滚后的命令可以按原 cmdId 重新执行，恢复后结果一致', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);

  ledger.execute(settleCommand('s1', { account: 'a', amount: 70 }));
  ledger.rollback(1);
  assert.equal(ledger.has('s1'), false);
  assert.deepEqual(ledger.snapshot().balances, {});

  const result = ledger.execute(settleCommand('s1', { account: 'a', amount: 70 }));
  assert.equal(result.balanceAfter, 70);
  ledger.close();

  const recovered = new OperationLedger(file);
  assert.equal(recovered.has('s1'), true);
  assert.equal(recovered.snapshot().balances.a, 70);
  recovered.close();
});

test('账本记录序号连续递增，恢复后续写不断号', (t) => {
  const file = makeLedgerFile(t);
  const ledger = new OperationLedger(file);
  ledger.execute(loadCommand('n1', { shipmentId: 'PKG-1', cargo: '药品', weight: 2 }));
  ledger.execute(settleCommand('n2', { account: 'a', amount: 10 }));
  ledger.close();

  const recovered = new OperationLedger(file);
  recovered.execute(settleCommand('n3', { account: 'a', amount: 5 }));
  recovered.rollback(1);
  recovered.close();

  const seqs = readRecords(file).map((record) => record.seq);
  assert.deepEqual(seqs, seqs.map((_, index) => index + 1));
});
