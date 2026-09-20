import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Ledger,
  ConflictError,
  CommandError,
  CorruptionError,
  RollbackError,
  LedgerError
} from '../ledger.js';
import { GAME_COMMANDS, createGameLedger, openGameLedger } from '../game-ledger.js';

function makeLedger(context, seed = 'ledger-seed') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-ledger-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'ledger.log');
  const ledger = createGameLedger(filePath, { seed });
  context.after(() => ledger.close());
  return { dir, filePath, ledger };
}

function openLetters(ledger) {
  return ledger.state.game.letters.filter(
    (letter) => letter.status === 'inbox' || letter.status === 'backlog'
  );
}

function lightestOpenLetters(ledger, count) {
  return [...openLetters(ledger)]
    .sort((first, second) => first.weight - second.weight)
    .slice(0, count);
}

test('装载、路线、结算命令按顺序入账并推进游戏', (context) => {
  const { ledger } = makeLedger(context);
  const [first, second] = lightestOpenLetters(ledger, 2);

  const loadOne = ledger.submit('load-1', 'load', { letterId: first.id, courierId: 'atlas' });
  assert.equal(loadOne.merged, false);
  assert.equal(loadOne.seq, 1);
  assert.equal(loadOne.result.stagedCount, 1);

  const loadTwo = ledger.submit('load-2', 'load', { letterId: second.id, courierId: 'atlas' });
  assert.equal(loadTwo.seq, 2);

  const route = ledger.submit('route-1', 'route', {
    courierId: 'atlas',
    stops: [second.id, first.id]
  });
  assert.deepEqual(route.result.next, [
    { letterId: second.id, order: 0 },
    { letterId: first.id, order: 1 }
  ]);

  const settle = ledger.submit('settle-1', 'settle', {});
  assert.equal(settle.result.report.day, 1);
  assert.equal(ledger.state.game.day, 2);
  assert.equal(ledger.state.plan.length, 0);

  const history = ledger.history();
  assert.deepEqual(
    history.map((record) => record.kind),
    ['genesis', 'command', 'command', 'command', 'command']
  );
  assert.deepEqual(
    history.map((record) => record.seq),
    [0, 1, 2, 3, 4]
  );
  assert.ok(history.every((record, index) => index === 0 || record.status === 'committed'));
});

test('相同幂等键的重试会被合并，不会重复执行', (context) => {
  const { ledger } = makeLedger(context);
  const [letter] = lightestOpenLetters(ledger, 1);

  const first = ledger.submit('load-key', 'load', { letterId: letter.id, courierId: 'comet' });
  const retry = ledger.submit('load-key', 'load', { letterId: letter.id, courierId: 'comet' });
  assert.equal(retry.merged, true);
  assert.equal(retry.seq, first.seq);
  assert.deepEqual(retry.result, first.result);
  assert.equal(ledger.state.plan.length, 1);
  assert.equal(ledger.history().length, 2);

  const settle = ledger.submit('settle-key', 'settle', {});
  const settleRetry = ledger.submit('settle-key', 'settle', {});
  assert.equal(settleRetry.merged, true);
  assert.deepEqual(settleRetry.result, settle.result);
  assert.equal(ledger.state.game.day, 2, '结算不应重复推进天数');
  assert.equal(ledger.history().length, 3);
});

test('幂等键绑定不同命令或负载时拒绝执行', (context) => {
  const { ledger } = makeLedger(context);
  const [first, second] = lightestOpenLetters(ledger, 2);
  ledger.submit('same-key', 'load', { letterId: first.id, courierId: 'atlas' });

  assert.throws(
    () => ledger.submit('same-key', 'load', { letterId: second.id, courierId: 'atlas' }),
    ConflictError
  );
  assert.throws(() => ledger.submit('same-key', 'settle', {}), ConflictError);
  assert.equal(ledger.history().length, 2);
});

test('校验失败的命令不会写入账本，幂等键仍可复用', (context) => {
  const { ledger } = makeLedger(context);
  const historyBefore = ledger.history().length;

  assert.throws(
    () => ledger.submit('retryable-key', 'load', { letterId: 'NOPE', courierId: 'atlas' }),
    CommandError
  );
  assert.equal(ledger.history().length, historyBefore);

  const [letter] = lightestOpenLetters(ledger, 1);
  const recovered = ledger.submit('retryable-key', 'load', { letterId: letter.id, courierId: 'atlas' });
  assert.equal(recovered.merged, false);

  // 彗尾号最多 3 封 / 7 kg，持续装载必然触发业务校验。
  const historyAfterLoad = ledger.history().length;
  assert.throws(() => {
    for (const candidate of openLetters(ledger)) {
      ledger.submit(`overload-${candidate.id}`, 'load', { letterId: candidate.id, courierId: 'comet' });
    }
  }, CommandError);
  assert.equal(ledger.history().length, ledger.nextSeq);
  assert.ok(ledger.history().length < historyAfterLoad + openLetters(ledger).length);
});

test('回滚按后进先出执行补偿并如实入账', (context) => {
  const { ledger } = makeLedger(context);
  const genesisDigest = ledger.digest();
  const [first, second] = lightestOpenLetters(ledger, 2);

  ledger.submit('load-1', 'load', { letterId: first.id, courierId: 'atlas' });
  ledger.submit('load-2', 'load', { letterId: second.id, courierId: 'atlas' });
  ledger.submit('route-1', 'route', { courierId: 'atlas', stops: [second.id, first.id] });
  assert.equal(ledger.state.plan[0].order, 1);

  const rollback = ledger.rollback(3, 'rollback-all');
  assert.deepEqual(rollback.targets, [3, 2, 1], '回滚必须按后进先出顺序执行');
  assert.equal(ledger.state.plan.length, 0);
  assert.equal(ledger.digest(), genesisDigest, '全部回滚后状态应回到创世快照');

  const history = ledger.history();
  assert.equal(history.at(-1).kind, 'rollback');
  assert.deepEqual(
    history.filter((record) => record.kind === 'command').map((record) => record.status),
    ['rolled-back', 'rolled-back', 'rolled-back']
  );
});

test('结算回滚后恢复当日状态与待投递邮件', (context) => {
  const { ledger } = makeLedger(context);
  const [letter] = lightestOpenLetters(ledger, 1);
  ledger.submit('load-1', 'load', { letterId: letter.id, courierId: 'comet' });
  const digestBeforeSettle = ledger.digest();

  ledger.submit('settle-1', 'settle', {});
  assert.equal(ledger.state.game.day, 2);
  assert.equal(ledger.state.game.letters.find((item) => item.id === letter.id).status, 'delivered');

  const rollback = ledger.rollback(1);
  assert.deepEqual(rollback.results, [{ restoredDay: 1 }]);
  assert.equal(ledger.state.game.day, 1);
  assert.equal(ledger.state.game.letters.find((item) => item.id === letter.id).status, 'inbox');
  assert.equal(ledger.state.plan.length, 1, '结算前的装载方案应随回滚恢复');
  assert.equal(ledger.digest(), digestBeforeSettle);
});

test('回滚操作本身支持幂等重试，不会重复补偿', (context) => {
  const { ledger } = makeLedger(context);
  const [letter] = lightestOpenLetters(ledger, 1);
  ledger.submit('load-1', 'load', { letterId: letter.id, courierId: 'comet' });

  const first = ledger.rollback(1, 'rollback-key');
  const retry = ledger.rollback(1, 'rollback-key');
  assert.equal(retry.merged, true);
  assert.deepEqual(retry.targets, first.targets);
  assert.deepEqual(retry.results, first.results);
  assert.equal(ledger.state.plan.length, 0);
  assert.equal(ledger.history().length, 3);
});

test('可回滚命令不足时拒绝回滚', (context) => {
  const { ledger } = makeLedger(context);
  assert.throws(() => ledger.rollback(1), RollbackError);

  const [letter] = lightestOpenLetters(ledger, 1);
  ledger.submit('load-1', 'load', { letterId: letter.id, courierId: 'comet' });
  assert.throws(() => ledger.rollback(2), RollbackError);
  ledger.rollback(1);
  assert.throws(() => ledger.rollback(1), RollbackError, '已回滚的命令不能再次回滚');
});

test('已回滚命令的重试不会重新执行', (context) => {
  const { ledger } = makeLedger(context);
  const [letter] = lightestOpenLetters(ledger, 1);
  ledger.submit('load-key', 'load', { letterId: letter.id, courierId: 'comet' });
  ledger.rollback(1);

  const retry = ledger.submit('load-key', 'load', { letterId: letter.id, courierId: 'comet' });
  assert.equal(retry.merged, true);
  assert.equal(retry.status, 'rolled-back');
  assert.equal(ledger.state.plan.length, 0, '回滚后的重试不得重新装载');
});

test('崩溃恢复后命令顺序与结果保持原样', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-ledger-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'ledger.log');

  const ledger = createGameLedger(filePath, { seed: 'recovery-seed' });
  const [first, second] = lightestOpenLetters(ledger, 2);
  ledger.submit('l1', 'load', { letterId: first.id, courierId: 'atlas' });
  ledger.submit('l2', 'load', { letterId: second.id, courierId: 'atlas' });
  ledger.submit('r1', 'route', { courierId: 'atlas', stops: [second.id, first.id] });
  ledger.submit('s1', 'settle', {});
  const [dayTwoLetter] = lightestOpenLetters(ledger, 1);
  ledger.submit('l3', 'load', { letterId: dayTwoLetter.id, courierId: 'comet' });
  ledger.rollback(1, 'rb1');

  const digestBefore = ledger.digest();
  const historyBefore = ledger.history();
  ledger.close();

  const recovered = openGameLedger(filePath);
  context.after(() => recovered.close());
  assert.equal(recovered.digest(), digestBefore, '恢复后状态摘要必须一致');
  assert.deepEqual(recovered.history(), historyBefore, '恢复后账本顺序与记录必须一致');

  const retry = recovered.submit('l1', 'load', { letterId: first.id, courierId: 'atlas' });
  assert.equal(retry.merged, true, '恢复前的幂等键在恢复后仍然有效');

  const [anotherLetter] = lightestOpenLetters(recovered, 1);
  const continued = recovered.submit('l4', 'load', { letterId: anotherLetter.id, courierId: 'comet' });
  assert.equal(continued.seq, historyBefore.length, '恢复后新命令必须延续原序号');
});

test('末尾撕裂写被截断且账本可继续追加', (context) => {
  const { filePath, ledger } = makeLedger(context);
  const [letter] = lightestOpenLetters(ledger, 1);
  ledger.submit('load-1', 'load', { letterId: letter.id, courierId: 'comet' });
  const digestBefore = ledger.digest();
  const seqBefore = ledger.nextSeq;
  ledger.close();

  // 模拟崩溃时的半条记录。
  fs.appendFileSync(filePath, '{"seq":99,"kind":"command","key":"torn"');

  const recovered = openGameLedger(filePath);
  assert.equal(recovered.digest(), digestBefore);
  assert.equal(recovered.nextSeq, seqBefore);
  const anotherLetter = lightestOpenLetters(recovered, 2)[1];
  const continued = recovered.submit('load-2', 'load', { letterId: anotherLetter.id, courierId: 'atlas' });
  assert.equal(continued.seq, seqBefore);
  recovered.close();
});

test('篡改已记录结果或中间损坏会被恢复校验发现', (context) => {
  const { filePath, ledger } = makeLedger(context);
  const [first, second] = lightestOpenLetters(ledger, 2);
  ledger.submit('load-1', 'load', { letterId: first.id, courierId: 'atlas' });
  ledger.submit('load-2', 'load', { letterId: second.id, courierId: 'atlas' });
  ledger.close();

  const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.result.stagedCount = 999;
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  assert.throws(() => openGameLedger(filePath), CorruptionError, '重放结果与账本不一致必须报错');

  const broken = lines.slice();
  broken[1] = '<<<not-json>>>';
  fs.writeFileSync(filePath, `${broken.join('\n')}\n`);
  assert.throws(() => openGameLedger(filePath), CorruptionError, '中间记录损坏必须报错');
});

function stripTimestamps(value) {
  if (Array.isArray(value)) return value.map(stripTimestamps);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'createdAt' && key !== 'updatedAt')
        .map(([key, item]) => [key, stripTimestamps(item)])
    );
  }
  return value;
}

test('相同操作序列在不同账本实例上产生完全一致的结果', (context) => {
  const first = makeLedger(context, 'deterministic-seed');
  const second = makeLedger(context, 'deterministic-seed');

  for (const ledger of [first.ledger, second.ledger]) {
    const [one, two] = lightestOpenLetters(ledger, 2);
    ledger.submit('k1', 'load', { letterId: one.id, courierId: 'atlas' });
    ledger.submit('k2', 'load', { letterId: two.id, courierId: 'atlas' });
    ledger.submit('k3', 'route', { courierId: 'atlas', stops: [two.id, one.id] });
    ledger.submit('k4', 'settle', {});
  }

  assert.equal(first.ledger.digest(), second.ledger.digest());
  assert.deepEqual(
    stripTimestamps(first.ledger.history()),
    stripTimestamps(second.ledger.history())
  );
});

test('重复创建或打开缺失账本时报错', (context) => {
  const { filePath, ledger } = makeLedger(context);
  assert.throws(
    () => Ledger.create(filePath, { state: {}, commands: GAME_COMMANDS }),
    LedgerError
  );
  ledger.close();

  const missing = path.join(path.dirname(filePath), 'missing.log');
  assert.throws(() => Ledger.open(missing, { commands: GAME_COMMANDS }), LedgerError);
});
