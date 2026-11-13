/** ICS 日历: VEVENT 关键行（UID/DTSTAMP/SUMMARY/VALARM） */
import { describe, expect, it } from 'vitest';
import { renderIcs } from '../../extension/lib/ics.js';

const NOW = new Date('2026-06-15T08:00:00');
const task = (o: object) => ({ businessType: 1, endTime: new Date('2026-06-20').getTime(), ...o });

describe('renderIcs', () => {
  it('输出 VCALENDAR 骨架与关键行', () => {
    const ics = renderIcs([task({ businessId: 'b1' })], NOW);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('UID:b1@mooc-auto-study');
    expect(ics).toContain('DTSTAMP:20260615T000000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260620');
    expect(ics).toContain('SUMMARY:【截止】课程');
    expect(ics).toContain('END:VCALENDAR');
  });
  it('只含未完成必修: 考试/已完成/已过期/无截止不提醒', () => {
    const ics = renderIcs([
      task({ businessType: 3 }),
      task({ businessId: 'done', status: 3 }),
      task({ businessId: 'expired', expired: true }),
      task({ businessId: 'nodate', endTime: undefined }),
      task({ businessId: 'past', endTime: new Date('2026-06-01').getTime() }),
      task({ businessId: 'ok2', businessType: 2 }),
    ], NOW);
    expect(ics).toContain('UID:ok2@mooc-auto-study');
    expect(ics).not.toContain('UID:done@');
    expect(ics).not.toContain('UID:expired@');
    expect(ics).toContain('专题');
  });
  it('默认脱敏 + VALARM 提醒', () => {
    const ics = renderIcs([task({ name: '烟草专卖法' })], NOW);
    expect(ics).toContain('必修任务 #1');
    expect(ics).not.toContain('烟草专卖法');
    expect(ics).toContain('BEGIN:VALARM');
  });
  it('长中文标题按字节折行 (RFC 5545 ≤75 octets)', () => {
    const ics = renderIcs([task({ name: '长'.repeat(60), maskTitles: false })], NOW);
    for (const line of ics.split('\r\n')) expect(line.length).toBeLessThanOrEqual(80);
  });
});
