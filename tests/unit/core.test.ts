/** 纯逻辑层单测: 必修优先排序 / 筛选 / 状态计数 / 日志着色 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as core from '../../extension/lib/core.js';

test('无人值守队列: 只含待学课程/专题, 必修排在最前', () => {
  const rows = [
    row({ bid: 'a', type: '专题', required: '必修', state: '未开始' }),
    row({ bid: 'b', type: '课程', required: '选修', state: '学习中' }),
    row({ bid: 'c', type: '课程', required: '必修', state: '学习中' }),
    row({ bid: 'd', type: '课程', required: '必修', state: '已完成' }),
    row({ bid: 'e', type: '考试', required: '必修', state: '未开始', runnable: false }),
    row({ bid: 'f', type: '专题', required: '必修', state: '已过期' }),
  ];
  assert.deepEqual(core.autopilotQueueOf(rows).map((r) => r.bid), ['a', 'c', 'b']);
  assert.equal(core.PAGE_SIZE, 12);
  assert.equal(core.LIB_BLOCK_SIZE, 240);
});

test('一键无人值守候选: 只收未开始/学习中且可播放的课程与专题, 可按状态收窄', () => {
  const rows = [
    row({ bid: 'a', state: '未开始', type: '课程' }),
    row({ bid: 'b', state: '学习中', type: '专题' }),
    row({ bid: 'c', state: '已完成', type: '课程' }),
    row({ bid: 'd', state: '已过期', type: '课程' }),
    row({ bid: 'e', state: '未开始', type: '考试', runnable: false }),
    row({ bid: 'f', state: '未开始', type: '课程', runnable: false }),
  ];
  assert.deepEqual(core.autopilotPending(rows).map((r) => r.bid), ['a', 'b']);
  assert.deepEqual(core.autopilotPending(rows, '未开始').map((r) => r.bid), ['a']);
  assert.deepEqual(core.autopilotPending(rows, '学习中').map((r) => r.bid), ['b']);
  // 停在「已完成」筛选时不能被筛空, 仍应拿到待学任务
  assert.deepEqual(core.autopilotPending(rows, '已完成').map((r) => r.bid), ['a', 'b']);
});

test('单卡/单行值守按钮的可见性: 只有未开始·学习中的可播放课程与专题才显示', () => {
  // 卡片/列表行上的「值守」按钮用它决定是否出现
  assert.equal(core.isAutopilotTarget(row({ state: '未开始' })), true);
  assert.equal(core.isAutopilotTarget(row({ state: '学习中', type: '专题' })), true);
  assert.equal(core.isAutopilotTarget(row({ state: '已完成' })), false);
  assert.equal(core.isAutopilotTarget(row({ state: '已过期' })), false);
  assert.equal(core.isAutopilotTarget(row({ type: '考试' })), false);      // 考试不能无人值守播放
  assert.equal(core.isAutopilotTarget(row({ runnable: false })), false);   // 平台无媒体源
  assert.equal(core.isAutopilotTarget(null), false);
});

const row = (over = {}) => ({
  type: '课程', required: '必修', state: '学习中', name: 'x', bid: 'b1',
  runnable: true, reg_ts: 0, push_ts: 0, url: '', ...over,
});

test('继续学习: 只取必修未完成, 学习中排在未开始之前', () => {
  const rows = [
    row({ name: '选修-学习中', required: '选修', state: '学习中' }),
    row({ name: '必修-未开始', required: '必修', state: '未开始' }),
    row({ name: '必修-学习中', required: '必修', state: '学习中' }),
    row({ name: '必修-已完成', required: '必修', state: '已完成' }),
  ];
  const out = core.continueList(rows);
  assert.deepEqual(out.rows.map((r) => r.name), ['必修-学习中', '必修-未开始']);
  assert.equal(out.required, true);
  assert.equal(out.doing, 1);
  assert.equal(out.hint, '必修 · 学习中 1 · 未开始 1');
});

test('继续学习: 必修全完成时退回待学任务并说明', () => {
  const rows = [
    row({ name: '必修-已完成', state: '已完成' }),
    row({ name: '选修-未开始', required: '选修', state: '未开始' }),
  ];
  const out = core.continueList(rows);
  assert.equal(out.required, false);
  assert.deepEqual(out.rows.map((r) => r.name), ['选修-未开始']);
  assert.match(out.hint, /必修已全部完成/);
});

test('继续学习: 同状态下按推送时间倒序, 条数受 limit 限制', () => {
  const rows = [1, 2, 3].map((i) => row({ name: `必修${i}`, push_ts: i * 1000 }));
  const out = core.continueList(rows, 2);
  assert.deepEqual(out.rows.map((r) => r.name), ['必修3', '必修2']);
  assert.equal(out.total, 3);
});

test('任务筛选: 状态 / 类型 / 关键词可叠加', () => {
  const rows = [
    row({ name: '烟草专卖法 第一章', type: '课程', state: '学习中' }),
    row({ name: '烟草专卖法 第二章', type: '课程', state: '已完成' }),
    row({ name: '安全生产专题', type: '专题', state: '学习中' }),
  ];
  assert.equal(core.filterRows(rows, { status: '学习中' }).length, 2);
  assert.equal(core.filterRows(rows, { status: '学习中', type: '专题' }).length, 1);
  assert.equal(core.filterRows(rows, { q: '第二章' })[0].name, '烟草专卖法 第二章');
  assert.equal(core.filterRows(rows, { q: '  烟草  ' }).length, 2);
  assert.equal(core.filterRows(rows, {}).length, 3);
});

test('状态计数', () => {
  const counts = core.countStates([
    row({ state: '学习中' }), row({ state: '学习中' }), row({ state: '已完成' }),
  ]);
  assert.deepEqual(counts, { '学习中': 2, '已完成': 1 });
});

test('日志着色: 错误 / 警告 / 成功 / 标签', () => {
  assert.equal(core.logClass('         -> FAIL 上报失败'), 'l-err');
  assert.equal(core.logClass('异常 TypeError'), 'l-err');
  assert.equal(core.logClass('[配额] 当日配额已满'), 'l-warn');
  assert.equal(core.logClass('         -> OK 完成, 共 4 轮'), 'l-ok');
  assert.equal(core.logClass('[证件] x'), '');
  assert.equal(core.logClass('[凭证] 重新登录成功'), 'l-tag');
});

test('时间格式化: 缺失显示破折号, 时长可读', () => {
  assert.equal(core.fmtTime(0), '—');
  assert.match(core.fmtTime(Date.UTC(2026, 0, 2, 3, 4)), /^01-0\d \d\d:\d\d$/);
  assert.equal(core.fmtDur(0), '0 秒');
  assert.equal(core.fmtDur(65_000), '1 分 5 秒');
  assert.equal(core.fmtDur(3_900_000), '1 时 5 分');
  assert.equal(core.fmtDur(-1), '—');
});
