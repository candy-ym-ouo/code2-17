import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 可回滚操作账本。
 *
 * 设计要点：
 * - 只追加日志（WAL）：每条记录独占一行 JSON，写入后立即 fsync，
 *   只有落盘成功的命令才会向调用方返回；
 * - 幂等键：客户端为每条命令提供唯一 key，重试会被合并到首条记录，
 *   直接返回已记录的结果，绝不重复执行；
 * - 回滚：按后进先出对命令执行补偿（compensate），回滚本身也作为记录入账，
 *   因此崩溃恢复后回滚效果依然成立；
 * - 恢复：按 seq 顺序重放全部记录，重新执行命令并逐项校验
 *   “重算结果 === 已记录结果”，任何分叉都视为账本损坏并拒绝启动。
 *
 * 命令需实现三个方法：
 *   validate(state, payload)            校验，失败抛 CommandError，不产生任何记录
 *   apply(state, payload) -> result     执行，必须确定性（同样的状态必然得到同样的结果）
 *   compensate(state, payload, result)  补偿，精确撤销 apply 的效果
 */

export class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

/** 幂等键冲突：同一个 key 绑定了不同的命令。 */
export class ConflictError extends LedgerError {}

/** 命令校验失败（业务规则），不会写入账本。 */
export class CommandError extends LedgerError {}

/** 账本内容与确定性重放不一致。 */
export class CorruptionError extends LedgerError {}

/** 回滚请求不合法。 */
export class RollbackError extends LedgerError {}

export const KIND_GENESIS = 'genesis';
export const KIND_COMMAND = 'command';
export const KIND_ROLLBACK = 'rollback';

/** 规范化 JSON：对象键递归排序，用于结果与负载的稳定比较。 */
export function stableStringify(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item ?? null)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const parts = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

export class Ledger {
  #fd = null;
  #filePath;
  #commands;
  #normalize;
  #entries = new Map();
  #keyIndex = new Map();
  #rolledBack = new Set();
  #nextSeq = 0;

  /** 命令重放后的业务状态，只允许通过命令修改。 */
  state = null;

  constructor(filePath, { commands, normalize = null, create = false, initialState = null } = {}) {
    if (!commands || typeof commands !== 'object') {
      throw new LedgerError('必须提供命令注册表 commands。');
    }
    this.#filePath = filePath;
    this.#commands = commands;
    this.#normalize = normalize;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) this.#recover();
    if (create && this.#nextSeq > 0) {
      throw new LedgerError(`账本 ${filePath} 已存在，请使用 Ledger.open 打开。`);
    }
    if (!create && this.#nextSeq === 0) {
      throw new LedgerError(`账本 ${filePath} 不存在或为空，请使用 Ledger.create 创建。`);
    }
    this.#fd = fs.openSync(filePath, 'a');
    if (create) {
      const genesis = { seq: 0, kind: KIND_GENESIS, state: initialState };
      this.#append(genesis);
      this.#replay(genesis);
    }
  }

  /** 创建新账本并写入创世记录（初始状态快照）。 */
  static create(filePath, { state, commands, normalize }) {
    return new Ledger(filePath, { commands, normalize, create: true, initialState: state });
  }

  /** 打开已有账本，重放全部记录恢复状态。 */
  static open(filePath, { commands, normalize }) {
    return new Ledger(filePath, { commands, normalize });
  }

  get nextSeq() {
    return this.#nextSeq;
  }

  /**
   * 提交一条命令。
   * 相同 key 的重试会被合并：返回首次记录的结果（merged: true），不重复执行。
   * 校验失败的命令不入账，key 也不会被占用。
   */
  submit(key, type, payload = {}) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new LedgerError('每条命令必须提供非空字符串幂等键。');
    }
    const safePayload = payload ?? {};
    const existingSeq = this.#keyIndex.get(key);
    if (existingSeq !== undefined) {
      const record = this.#entries.get(existingSeq);
      if (record.kind !== KIND_COMMAND || record.type !== type
          || stableStringify(record.payload) !== stableStringify(safePayload)) {
        throw new ConflictError(`幂等键 ${key} 已绑定到其他命令，不能复用。`);
      }
      return {
        seq: record.seq,
        key,
        status: this.#statusOf(record),
        result: structuredClone(record.result),
        merged: true
      };
    }
    const command = this.#commands[type];
    if (!command) throw new LedgerError(`未知命令类型：${type}。`);
    command.validate(this.state, safePayload);
    const result = command.apply(this.state, safePayload);
    const record = {
      seq: this.#nextSeq,
      kind: KIND_COMMAND,
      key,
      type,
      payload: structuredClone(safePayload),
      result
    };
    try {
      this.#append(record);
    } catch (error) {
      // 写盘失败：内存中撤销，保持状态与账本一致。
      command.compensate(this.state, safePayload, result);
      throw error;
    }
    this.#register(record);
    return { seq: record.seq, key, status: 'committed', result: structuredClone(result), merged: false };
  }

  /**
   * 回滚最近 steps 条未回滚的命令（后进先出），回滚本身也会入账。
   * 提供 key 时回滚操作同样幂等：重试返回首次的补偿结果，不会重复补偿。
   */
  rollback(steps = 1, key = null) {
    if (!Number.isInteger(steps) || steps < 1) {
      throw new RollbackError('回滚步数必须是正整数。');
    }
    if (key !== null && (typeof key !== 'string' || key.length === 0)) {
      throw new RollbackError('回滚幂等键必须是非空字符串。');
    }
    if (key !== null && this.#keyIndex.has(key)) {
      const record = this.#entries.get(this.#keyIndex.get(key));
      if (record.kind !== KIND_ROLLBACK || record.targets.length !== steps) {
        throw new ConflictError(`幂等键 ${key} 已绑定到其他操作，不能复用。`);
      }
      return {
        seq: record.seq,
        key,
        targets: [...record.targets],
        results: structuredClone(record.results),
        merged: true
      };
    }
    const targets = [];
    for (let seq = this.#nextSeq - 1; seq >= 1 && targets.length < steps; seq -= 1) {
      const record = this.#entries.get(seq);
      if (record.kind === KIND_COMMAND && !this.#rolledBack.has(seq)) targets.push(record);
    }
    if (targets.length < steps) {
      throw new RollbackError(`可回滚命令不足：需要 ${steps} 条，实际 ${targets.length} 条。`);
    }
    const results = [];
    const compensated = [];
    for (const target of targets) {
      const command = this.#commands[target.type];
      results.push(command.compensate(this.state, target.payload, target.result));
      compensated.push(command);
    }
    const record = {
      seq: this.#nextSeq,
      kind: KIND_ROLLBACK,
      key,
      targets: targets.map((target) => target.seq),
      results
    };
    try {
      this.#append(record);
    } catch (error) {
      // 写盘失败：按相反顺序重新执行原命令，恢复内存状态。
      for (let index = compensated.length - 1; index >= 0; index -= 1) {
        compensated[index].apply(this.state, targets[index].payload);
      }
      throw error;
    }
    for (const target of targets) this.#rolledBack.add(target.seq);
    this.#register(record);
    return {
      seq: record.seq,
      key,
      targets: record.targets,
      results: structuredClone(results),
      merged: false
    };
  }

  /** 按 seq 顺序返回全部记录（命令记录附带 committed / rolled-back 状态）。 */
  history() {
    const records = [];
    for (let seq = 0; seq < this.#nextSeq; seq += 1) {
      const record = this.#entries.get(seq);
      const item = structuredClone(record);
      if (record.kind === KIND_COMMAND) item.status = this.#statusOf(record);
      records.push(item);
    }
    return records;
  }

  /** 当前状态的确定性摘要（sha256），用于比对恢复前后的状态是否一致。 */
  digest() {
    const snapshot = this.#normalize ? this.#normalize(structuredClone(this.state)) : this.state;
    return crypto.createHash('sha256').update(stableStringify(snapshot)).digest('hex');
  }

  close() {
    if (this.#fd !== null) {
      fs.closeSync(this.#fd);
      this.#fd = null;
    }
  }

  #statusOf(record) {
    return this.#rolledBack.has(record.seq) ? 'rolled-back' : 'committed';
  }

  #register(record) {
    this.#entries.set(record.seq, record);
    if (record.key != null) this.#keyIndex.set(record.key, record.seq);
    this.#nextSeq = record.seq + 1;
  }

  #append(record) {
    fs.writeSync(this.#fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(this.#fd);
  }

  /** 启动时读取日志；末尾撕裂写（崩溃残留）截断处理，中间损坏则报错。 */
  #recover() {
    const buffer = fs.readFileSync(this.#filePath);
    const records = [];
    let offset = 0;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(0x0a, offset);
      const end = newline === -1 ? buffer.length : newline;
      const nextOffset = newline === -1 ? buffer.length : end + 1;
      const line = buffer.subarray(offset, end).toString('utf8');
      if (line.trim().length === 0) {
        if (nextOffset >= buffer.length) break;
        throw new CorruptionError(`账本在偏移 ${offset} 处存在空行。`);
      }
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        record = null;
      }
      if (!record || typeof record !== 'object' || !Number.isInteger(record.seq) || typeof record.kind !== 'string') {
        if (nextOffset >= buffer.length) {
          fs.truncateSync(this.#filePath, offset);
          break;
        }
        throw new CorruptionError(`账本在偏移 ${offset} 处损坏。`);
      }
      records.push(record);
      offset = nextOffset;
    }
    for (const record of records) this.#replay(record);
  }

  /** 重放单条记录：重新执行并校验结果与账本一致，保证恢复后顺序与结果保持原样。 */
  #replay(record) {
    if (record.seq !== this.#nextSeq) {
      throw new CorruptionError(`账本序号不连续：期望 ${this.#nextSeq}，实际 ${record.seq}。`);
    }
    if (record.kind === KIND_GENESIS) {
      if (record.seq !== 0) throw new CorruptionError('创世记录必须是第一条记录。');
      this.state = structuredClone(record.state);
    } else if (record.kind === KIND_COMMAND) {
      const command = this.#commands[record.type];
      if (!command) throw new CorruptionError(`账本包含未知命令类型：${record.type}。`);
      command.validate(this.state, record.payload);
      const result = command.apply(this.state, record.payload);
      if (stableStringify(result) !== stableStringify(record.result)) {
        throw new CorruptionError(`第 ${record.seq} 条记录的重放结果与账本不一致。`);
      }
    } else if (record.kind === KIND_ROLLBACK) {
      if (!Array.isArray(record.targets) || !Array.isArray(record.results)
          || record.targets.length !== record.results.length) {
        throw new CorruptionError(`第 ${record.seq} 条回滚记录结构不完整。`);
      }
      for (let index = 0; index < record.targets.length; index += 1) {
        const target = this.#entries.get(record.targets[index]);
        if (!target || target.kind !== KIND_COMMAND) {
          throw new CorruptionError(`第 ${record.seq} 条回滚记录指向无效目标。`);
        }
        if (this.#rolledBack.has(target.seq)) {
          throw new CorruptionError(`第 ${record.seq} 条回滚记录重复回滚了第 ${target.seq} 条命令。`);
        }
        const command = this.#commands[target.type];
        const compensation = command.compensate(this.state, target.payload, target.result);
        if (stableStringify(compensation) !== stableStringify(record.results[index])) {
          throw new CorruptionError(`第 ${record.seq} 条回滚记录的补偿结果与账本不一致。`);
        }
        this.#rolledBack.add(target.seq);
      }
    } else {
      throw new CorruptionError(`未知记录类型：${record.kind}。`);
    }
    this.#register(record);
  }
}
