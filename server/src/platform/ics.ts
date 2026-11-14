// ICS 日历导出（协议最小实现，移植自 extension 分支 lib/ics.js 的 folded/esc 规则）
export interface IcsEvent {
  uid: string;
  summary: string;
  start: Date;
  end?: Date;        // 缺省按全天事件处理（只落到日期）
  alarmDays?: number; // 全天截止事件的提前提醒天数
}

const pad = (n: number) => String(n).padStart(2, '0');
const basicDate = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const basicTime = (d: Date) => `${basicDate(d)}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
// DTSTAMP 按协议必须声明为 UTC：basicTime 是本地浮动时间，硬加 Z 会差一个时区，
// 日历客户端会把整份文件的元时间戳读错
const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// RFC5545 每行 ≤75 字节，超长折叠
const fold = (line: string) => {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 73, bytes.length);
    while (end > start && end !== undefined && (bytes[end]! & 0xc0) === 0x80) end--; // 不劈开多字节字符
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
};

export function buildIcs(events: IcsEvent[]): string {
  const now = new Date();
  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'PRODID:-//mooc-auto-study//web//CN', 'CALSCALE:GREGORIAN',
  ];
  for (const ev of events) {
    // RFC5545 ABNF：VEVENT 先父属性后子组件，VALARM 必须在 SUMMARY 之后，严格解析器会丢弃乱序组件
    lines.push('BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${utcStamp(now)}`);
    if (ev.end) {
      lines.push(`DTSTART;VALUE=DATE-TIME:${basicTime(ev.start)}`, `DTEND;VALUE=DATE-TIME:${basicTime(ev.end)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${basicDate(ev.start)}`);
    }
    lines.push(`SUMMARY:${esc(ev.summary)}`);
    if (!ev.end && ev.alarmDays) {
      lines.push(
        'BEGIN:VALARM', `TRIGGER:-P${ev.alarmDays}D`,
        'ACTION:DISPLAY', `DESCRIPTION:${esc(ev.summary)}`, 'END:VALARM',
      );
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
