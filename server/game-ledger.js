import {
  advanceDay,
  createInitialState,
  getCourier,
  validateAssignmentPlan
} from './engine.js';
import { CommandError, CorruptionError, Ledger } from './ledger.js';

/**
 * 游戏域命令：装载（load）、路线（route）、结算（settle）。
 *
 * 账本管理的业务状态形如：
 *   { game: <engine 的权威游戏状态>, plan: [<已装载未结算的调度方案>] }
 *
 * 三类命令均满足账本要求的确定性契约：相同状态必然得到相同结果，
 * compensate 精确撤销 apply 的效果（结算通过事前快照实现撤销）。
 */

const round1 = (value) => Math.round(value * 10) / 10;

function findLetter(game, letterId) {
  return game.letters.find((letter) => letter.id === letterId);
}

function stagedEntries(plan, courierId) {
  return plan.filter((entry) => entry.courierId === courierId);
}

function stagedWeight(game, plan, courierId) {
  return round1(
    stagedEntries(plan, courierId)
      .reduce((sum, entry) => sum + findLetter(game, entry.letterId).weight, 0)
  );
}

/** 装载：把一封待投递邮件装上信使。 */
export const loadCommand = {
  validate(state, payload) {
    const { game, plan } = state;
    if (game.phase !== 'planning') {
      throw new CommandError('本局已结束，无法继续装载。');
    }
    const letter = findLetter(game, payload.letterId);
    if (!letter) throw new CommandError(`找不到邮件 ${payload.letterId}。`);
    if (letter.status !== 'inbox' && letter.status !== 'backlog') {
      throw new CommandError(`${letter.id} 已不在待投递队列，不能装载。`);
    }
    if (plan.some((entry) => entry.letterId === letter.id)) {
      throw new CommandError(`${letter.id} 已经装载，不能重复装载。`);
    }
    const courier = getCourier(game, payload.courierId);
    if (!courier) throw new CommandError(`找不到信使 ${payload.courierId}。`);
    const staged = stagedEntries(plan, courier.id);
    if (staged.length + 1 > courier.maxLetters) {
      throw new CommandError(`${courier.name} 最多携带 ${courier.maxLetters} 封，已装载 ${staged.length} 封。`);
    }
    if (stagedWeight(game, plan, courier.id) + letter.weight > courier.capacity + 1e-9) {
      throw new CommandError(`${courier.name} 载重上限 ${courier.capacity} kg，无法再装载 ${letter.weight} kg。`);
    }
  },

  apply(state, payload) {
    const { game, plan } = state;
    const letter = findLetter(game, payload.letterId);
    const courier = getCourier(game, payload.courierId);
    const staged = stagedEntries(plan, courier.id);
    const order = staged.length === 0 ? 0 : Math.max(...staged.map((entry) => entry.order)) + 1;
    plan.push({
      letterId: letter.id,
      courierId: courier.id,
      targetIslandId: letter.recipientIslandId,
      order
    });
    return {
      letterId: letter.id,
      courierId: courier.id,
      targetIslandId: letter.recipientIslandId,
      order,
      stagedCount: staged.length + 1,
      stagedWeight: stagedWeight(game, plan, courier.id)
    };
  },

  compensate(state, payload) {
    const index = state.plan.findIndex((entry) => entry.letterId === payload.letterId);
    if (index === -1) {
      throw new CorruptionError(`装载补偿失败：${payload.letterId} 不在装载计划中。`);
    }
    state.plan.splice(index, 1);
    return { letterId: payload.letterId, unstaged: true };
  }
};

/** 路线：为信使已装载的邮件设定投递顺序。 */
export const routeCommand = {
  validate(state, payload) {
    const courier = getCourier(state.game, payload.courierId);
    if (!courier) throw new CommandError(`找不到信使 ${payload.courierId}。`);
    if (!Array.isArray(payload.stops) || payload.stops.length === 0
        || payload.stops.some((id) => typeof id !== 'string')) {
      throw new CommandError('路线 stops 必须是非空的邮件编号数组。');
    }
    if (new Set(payload.stops).size !== payload.stops.length) {
      throw new CommandError('路线中存在重复的邮件。');
    }
    const stagedIds = stagedEntries(state.plan, courier.id).map((entry) => entry.letterId);
    if (payload.stops.length !== stagedIds.length || !stagedIds.every((id) => payload.stops.includes(id))) {
      throw new CommandError(`${courier.name} 的路线必须恰好包含已装载的 ${stagedIds.length} 封邮件。`);
    }
  },

  apply(state, payload) {
    const previous = stagedEntries(state.plan, payload.courierId)
      .map((entry) => ({ letterId: entry.letterId, order: entry.order }))
      .sort((first, second) => first.order - second.order);
    payload.stops.forEach((letterId, index) => {
      state.plan.find((entry) => entry.letterId === letterId).order = index;
    });
    return {
      courierId: payload.courierId,
      previous,
      next: payload.stops.map((letterId, order) => ({ letterId, order }))
    };
  },

  compensate(state, payload, result) {
    for (const { letterId, order } of result.previous) {
      const entry = state.plan.find((item) => item.letterId === letterId);
      if (!entry) {
        throw new CorruptionError(`路线补偿失败：${letterId} 不在装载计划中。`);
      }
      entry.order = order;
    }
    return { courierId: payload.courierId, restored: true };
  }
};

/** 结算：按当前装载方案执行当日结算（advanceDay），结果附事前快照用于回滚。 */
export const settleCommand = {
  validate(state) {
    if (state.game.phase !== 'planning') {
      throw new CommandError('本局已结束，无法结算。');
    }
    const { issues } = validateAssignmentPlan(state.game, state.plan);
    if (issues.length > 0) {
      throw new CommandError(`装载方案不合法：${issues.map((issue) => issue.message).join('；')}`);
    }
  },

  apply(state) {
    const snapshot = structuredClone(state.game);
    const assignments = structuredClone(state.plan);
    const report = advanceDay(state.game, state.plan);
    state.plan = [];
    return { day: report.day, report, assignments, snapshot };
  },

  compensate(state, payload, result) {
    state.game = structuredClone(result.snapshot);
    state.plan = structuredClone(result.assignments);
    return { restoredDay: result.snapshot.day };
  }
};

export const GAME_COMMANDS = {
  load: loadCommand,
  route: routeCommand,
  settle: settleCommand
};

/** 摘要前剔除易变字段（墙钟时间戳不影响命令结果与顺序）。 */
function stripVolatileTimestamps(state) {
  delete state.game.createdAt;
  delete state.game.updatedAt;
  return state;
}

export function createGameLedger(filePath, options = {}) {
  return Ledger.create(filePath, {
    state: { game: createInitialState(options), plan: [] },
    commands: GAME_COMMANDS,
    normalize: stripVolatileTimestamps
  });
}

export function openGameLedger(filePath) {
  return Ledger.open(filePath, {
    commands: GAME_COMMANDS,
    normalize: stripVolatileTimestamps
  });
}
