import fs from 'node:fs';
import path from 'node:path';

/**
 * 可回滚操作账本（append-only WAL + 补偿回滚 + 幂等执行）。
 *
 * 记录的命令类型：
 *  - LOAD    装载：把货物登记到装载清单
 *  - ROUTE   路线：为已装载的货物规划路线与成本
 *  - SETTLE  结算：向账户余额过账一笔金额（正数入账，负数扣减）
 *
 * 保证：
 *  1. 幂等：cmdId 是幂等键。已生效的命令被重试、或随批次合并重投时，
 *     直接返回首次记录的结果，绝不重复执行。
 *  2. 可回滚：每条 APPLIED 记录都带有补偿数据 undo，rollback 按后进先出
 *     顺序补偿，并追加 ROLLED_BACK 记录；回滚后的命令可按原 cmdId 重新执行。
 *  3. 可恢复：崩溃后重放日志即可按原始顺序重建状态。重放使用的是记录中的
 *     effect/result 而非重新执行命令，因此恢复后的顺序与结果和崩溃前完全
 *     一致；只有 INTENT 没有 APPLIED 的命令是崩溃残留，视为从未执行。
 *
 * 限制：单进程使用；同一日志文件同一时间只允许一个 OperationLedger 实例写入。
 */

export const RECORD_KINDS = Object.freeze({
  INTENT: 'INTENT', // 执行前落盘的命令意图
  APPLIED: 'APPLIED', // 命令已生效，携带效果、补偿与结果
  ABORTED: 'ABORTED', // 业务校验失败，命令未生效
  ROLLED_BACK: 'ROLLED_BACK' // 已生效命令被补偿撤销
});

export const COMMAND_TYPES = Object.freeze({
  LOAD: 'LOAD',
  ROUTE: 'ROUTE',
  SETTLE: 'SETTLE'
});

export class LedgerError extends Error {
  constructor(message, code = 'LEDGER_ERROR') {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export function loadCommand(cmdId, payload) {
  return { cmdId, type: COMMAND_TYPES.LOAD, payload };
}

export function routeCommand(cmdId, payload) {
  return { cmdId, type: COMMAND_TYPES.ROUTE, payload };
}

export function settleCommand(cmdId, payload) {
  return { cmdId, type: COMMAND_TYPES.SETTLE, payload };
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function createEmptyState() {
  return { manifest: {}, routes: {}, balances: {} };
}

// 规划器：只校验与计算，不修改状态。返回 { effect, undo, result }。
// effect 是落盘的状态变更数据，undo 是补偿数据，result 是返回给调用方的结果。
const PLANNERS = {
  [COMMAND_TYPES.LOAD](state, payload) {
    const { shipmentId, cargo, weight } = payload;
    if (typeof shipmentId !== 'string' || shipmentId.length === 0) {
      throw new LedgerError('装载命令必须提供 shipmentId。', 'INVALID_PAYLOAD');
    }
    if (typeof cargo !== 'string' || cargo.length === 0) {
      throw new LedgerError('装载命令必须提供 cargo 描述。', 'INVALID_PAYLOAD');
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new LedgerError(`货物 ${shipmentId} 的重量必须是正数。`, 'INVALID_PAYLOAD');
    }
    if (state.manifest[shipmentId]) {
      throw new LedgerError(`货物 ${shipmentId} 已在装载清单中，不能重复装载。`, 'ALREADY_LOADED');
    }
    return {
      effect: { shipmentId, entry: { cargo, weight } },
      undo: { shipmentId },
      result: { shipmentId, status: 'loaded', manifestSize: Object.keys(state.manifest).length + 1 }
    };
  },

  [COMMAND_TYPES.ROUTE](state, payload) {
    const { shipmentId, route, cost } = payload;
    if (typeof shipmentId !== 'string' || shipmentId.length === 0) {
      throw new LedgerError('路线命令必须提供 shipmentId。', 'INVALID_PAYLOAD');
    }
    if (!state.manifest[shipmentId]) {
      throw new LedgerError(`货物 ${shipmentId} 尚未装载，不能规划路线。`, 'NOT_LOADED');
    }
    if (typeof route !== 'string' || route.length === 0) {
      throw new LedgerError('路线命令必须提供 route。', 'INVALID_PAYLOAD');
    }
    if (!Number.isFinite(cost) || cost < 0) {
      throw new LedgerError(`货物 ${shipmentId} 的路线成本必须是非负数字。`, 'INVALID_PAYLOAD');
    }
    const previous = state.routes[shipmentId] ?? null;
    return {
      effect: { shipmentId, entry: { route, cost } },
      undo: { shipmentId, previous },
      result: { shipmentId, route, cost, replaced: previous !== null }
    };
  },

  [COMMAND_TYPES.SETTLE](state, payload) {
    const { account, amount } = payload;
    if (typeof account !== 'string' || account.length === 0) {
      throw new LedgerError('结算命令必须提供 account。', 'INVALID_PAYLOAD');
    }
    if (!Number.isFinite(amount) || amount === 0) {
      throw new LedgerError(`账户 ${account} 的结算金额必须是非零数字。`, 'INVALID_PAYLOAD');
    }
    const balanceBefore = state.balances[account] ?? 0;
    const balanceAfter = roundMoney(balanceBefore + amount);
    return {
      effect: { account, amount },
      undo: { account, amount: -amount },
      result: { account, amount, balanceBefore, balanceAfter }
    };
  }
};

// 正向效果：在线执行与崩溃恢复共用同一段逻辑，保证两条路径结果一致。
function applyEffect(state, commandType, effect) {
  switch (commandType) {
    case COMMAND_TYPES.LOAD:
      state.manifest[effect.shipmentId] = structuredClone(effect.entry);
      return;
    case COMMAND_TYPES.ROUTE:
      state.routes[effect.shipmentId] = structuredClone(effect.entry);
      return;
    case COMMAND_TYPES.SETTLE:
      state.balances[effect.account] = roundMoney((state.balances[effect.account] ?? 0) + effect.amount);
      return;
    default:
      throw new LedgerError(`未知命令类型 ${commandType}。`, 'UNKNOWN_TYPE');
  }
}

// 补偿：rollback 与恢复重放 ROLLED_BACK 记录时共用。
function applyUndo(state, commandType, undo) {
  switch (commandType) {
    case COMMAND_TYPES.LOAD:
      delete state.manifest[undo.shipmentId];
      return;
    case COMMAND_TYPES.ROUTE:
      if (undo.previous == null) delete state.routes[undo.shipmentId];
      else state.routes[undo.shipmentId] = structuredClone(undo.previous);
      return;
    case COMMAND_TYPES.SETTLE: {
      const balance = roundMoney((state.balances[undo.account] ?? 0) + undo.amount);
      if (balance === 0) delete state.balances[undo.account];
      else state.balances[undo.account] = balance;
      return;
    }
    default:
      throw new LedgerError(`未知命令类型 ${commandType}。`, 'UNKNOWN_TYPE');
  }
}

export class OperationLedger {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.results = new Map(); // cmdId -> 已生效结果（重试合并时直接返回）
    this.undoLog = new Map(); // cmdId -> { commandType, undo }
    this.stack = []; // 已生效 cmdId，按生效顺序排列，回滚时从尾部弹出
    this.seq = 0;
    this.fd = null;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, 'a+');
    this.recover();
  }

  // 扫描日志重建状态。恢复重放只使用记录中的 effect/undo/result，
  // 不重新执行命令，因此恢复后的顺序与结果与崩溃前完全一致。
  recover() {
    for (const record of this.readRecords()) {
      this.seq = Math.max(this.seq, record.seq ?? 0);
      if (record.kind === RECORD_KINDS.APPLIED) {
        applyEffect(this.state, record.commandType, record.effect);
        this.results.set(record.cmdId, record.result);
        this.undoLog.set(record.cmdId, { commandType: record.commandType, undo: record.undo });
        this.stack.push(record.cmdId);
      } else if (record.kind === RECORD_KINDS.ROLLED_BACK) {
        applyUndo(this.state, record.commandType, record.undo);
        this.results.delete(record.cmdId);
        this.undoLog.delete(record.cmdId);
        this.stack = this.stack.filter((cmdId) => cmdId !== record.cmdId);
      }
      // INTENT/ABORTED 不改变状态：孤立 INTENT 是崩溃残留，视为未执行。
    }
  }

  readRecords() {
    const buffer = fs.readFileSync(this.filePath);
    const records = [];
    let cursor = 0;
    while (cursor < buffer.length) {
      const newline = buffer.indexOf(0x0a, cursor);
      const end = newline === -1 ? buffer.length : newline;
      const line = buffer.subarray(cursor, end).toString('utf8').trim();
      if (line.length > 0) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // 崩溃造成的撕裂写入：截断到最近一条完整记录之后。
          fs.ftruncateSync(this.fd, cursor);
          break;
        }
      }
      cursor = newline === -1 ? buffer.length : newline + 1;
    }
    return records;
  }

  append(record) {
    this.seq += 1;
    const line = `${JSON.stringify({ seq: this.seq, ...record })}\n`;
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
  }

  execute(command) {
    const { cmdId, type, payload } = command ?? {};
    if (typeof cmdId !== 'string' || cmdId.length === 0) {
      throw new LedgerError('命令必须提供字符串形式的 cmdId 作为幂等键。', 'INVALID_COMMAND');
    }
    if (this.results.has(cmdId)) {
      // 重试合并：已生效命令直接返回首次记录的结果，绝不重复执行。
      return structuredClone(this.results.get(cmdId));
    }

    this.append({ kind: RECORD_KINDS.INTENT, cmdId, commandType: type ?? null, payload: payload ?? null });

    const planner = PLANNERS[type];
    let planned;
    try {
      if (!planner) {
        throw new LedgerError(`未知命令类型 ${String(type)}。`, 'UNKNOWN_TYPE');
      }
      planned = planner(this.state, payload ?? {});
    } catch (error) {
      this.append({ kind: RECORD_KINDS.ABORTED, cmdId, commandType: type ?? null, error: error.message });
      throw error;
    }

    applyEffect(this.state, type, planned.effect);
    this.append({
      kind: RECORD_KINDS.APPLIED,
      cmdId,
      commandType: type,
      effect: planned.effect,
      undo: planned.undo,
      result: planned.result
    });
    this.results.set(cmdId, planned.result);
    this.undoLog.set(cmdId, { commandType: type, undo: planned.undo });
    this.stack.push(cmdId);
    return structuredClone(planned.result);
  }

  // 重试合并：整批提交，批内重复与历史已生效的命令都会被去重。
  // 若中途失败，已生效的命令保持生效；修正后整批重投是安全的。
  merge(commands) {
    if (!Array.isArray(commands)) {
      throw new LedgerError('合并提交的命令必须是数组。', 'INVALID_COMMAND');
    }
    return commands.map((command) => this.execute(command));
  }

  // 按后进先出顺序补偿已生效的命令。返回被回滚的 cmdId 列表；
  // count 超过已生效数量时回滚到空为止。
  rollback(count = 1) {
    if (!Number.isInteger(count) || count < 1) {
      throw new LedgerError('回滚步数必须是正整数。', 'INVALID_COMMAND');
    }
    const rolledBack = [];
    for (let step = 0; step < count && this.stack.length > 0; step += 1) {
      const cmdId = this.stack.pop();
      const { commandType, undo } = this.undoLog.get(cmdId);
      applyUndo(this.state, commandType, undo);
      this.append({ kind: RECORD_KINDS.ROLLED_BACK, cmdId, commandType, undo });
      this.undoLog.delete(cmdId);
      this.results.delete(cmdId);
      rolledBack.push(cmdId);
    }
    return rolledBack;
  }

  // 事务：fn 抛出异常时，自动补偿事务内已执行的全部命令。
  transaction(fn) {
    const depth = this.stack.length;
    try {
      return fn(this);
    } catch (error) {
      const pending = this.stack.length - depth;
      if (pending > 0) this.rollback(pending);
      throw error;
    }
  }

  has(cmdId) {
    return this.results.has(cmdId);
  }

  resultOf(cmdId) {
    return this.results.has(cmdId) ? structuredClone(this.results.get(cmdId)) : null;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  get size() {
    return this.stack.length;
  }

  close() {
    if (this.fd != null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
