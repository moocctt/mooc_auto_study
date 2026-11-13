import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Input, Modal, Select, Space, Spin, Switch, Table, Tag, Typography } from 'antd';
import { CaretRightOutlined, PauseOutlined, ClockCircleOutlined, DownloadOutlined } from '@ant-design/icons';
import { api, type CourseInfo, type EngineStatus, type ScheduleCfg, type TaskRow } from '../lib/api';
import { sfx } from '../lib/sfx';
import type { ColumnsType } from 'antd/es/table';

const columns = (onRun: (bid: string) => void, onDetail: (bid: string) => void): ColumnsType<TaskRow> => [
  { title: '任务', dataIndex: 'name', ellipsis: true, render: (v, r) => (
    <Space size={4}>
      {r.required && <Tag color="orange">必修</Tag>}
      <Typography.Text ellipsis style={{ maxWidth: 420 }}>{v}</Typography.Text>
    </Space>
  ) },
  { title: '类型', dataIndex: 'kind', width: 70, render: (v) => <Tag>{v}</Tag> },
  { title: '状态', dataIndex: 'state', width: 90, render: (v) =>
    <Tag color={v === '已完成' ? 'green' : v === '已过期' ? 'default' : 'processing'}>{v}</Tag> },
  {
    title: '已学', dataIndex: 'studiedH', width: 90, align: 'right' as const,
    render: (v) => <span className="num">{v} 学时</span>,
  },
  { title: '', key: 'act', width: 70, render: (_, r) =>
    r.state === '进行中' || r.state === '已过期'
      ? <Button size="small" icon={<CaretRightOutlined />} onClick={() => onRun(r.bid)}>学</Button>
      : null },
  { title: '', key: 'act', width: 64, render: (_, r) =>
    <Button size="small" type="text" onClick={() => onDetail(r.bid)}>详情</Button> },
];

/** 课程详情预览：启动前先看这门课有哪些小节、引擎会跳过哪些 */
function CourseDetail({ bid, onClose }: { bid: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['course-info', bid],
    queryFn: () => api.get<CourseInfo>(`/api/course-info?bid=${bid}`),
    enabled: bid !== null,
  });
  const d = q.data;
  return (
    <Modal
      title={<span>{d ? d.name : '课程详情'}{d?.courseHour ? <Typography.Text type="secondary" className="num"> · {d.courseHour} 学时</Typography.Text> : null}</span>}
      open={bid !== null}
      onCancel={onClose}
      footer={null}
      width={560}
    >
      {q.isPending && <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>}
      {q.isError && <Alert type="warning" showIcon message={(q.error as Error).message} />}
      {d && d.chapters.length === 0 && <Typography.Text type="secondary">没有可显示的章节</Typography.Text>}
      {d && d.chapters.map((c, ci) => (
        <div key={ci} style={{ marginBottom: 12 }}>
          <Typography.Text strong>{c.title}</Typography.Text>
          <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
            {c.sections.map((x) => (
              <li key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--line)' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</span>
                {x.kind && <Tag>{x.kind}</Tag>}
                {x.minutes ? <span className="num" style={{ minWidth: 52, textAlign: 'right' }}>{x.minutes} 分钟</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Modal>
  );
}

function EnginePanel() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const status = useQuery<EngineStatus>({
    queryKey: ['engine'],
    queryFn: () => api.get('/api/engine/status'),
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const logRef = useRef<HTMLPreElement>(null);
  // 引擎从运行到停止的边沿：按停止原因给音效（完成/配额）——
  // status 无显式完成标志，靠最后一条日志区分
  const wasRunning = useRef(false);
  useEffect(() => {
    const st = status.data;
    if (wasRunning.current && st && !st.running) {
      const last = st.logs.at(-1) ?? '';
      if (last.includes('全部完成')) sfx.done();
      else if (last.includes('配额')) sfx.stop();
      // 页面在后台时用系统通知兜底（前端被切走听不到音效；权限被拒则静默跳过）
      if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const body = last.includes('配额') ? '当日学时配额已满，已自动停止'
          : last.includes('全部完成') ? '全部任务处理完毕'
          : (last.replace(/^\[[^\]]*\]\s*/, '').slice(0, 80) || '引擎已停止');
        try { new Notification('学习引擎已停止', { body }); } catch { /* 忽略通知失败 */ }
      }
    }
    wasRunning.current = Boolean(st?.running);
  }, [status.data]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status.data?.logs.length]);

  const start = useMutation({
    mutationFn: (courseId: string) => api.post('/api/engine/start', { courseId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['engine'] }); sfx.start(); },
    onError: (e: Error) => message.error(e.message),
  });
  const stop = useMutation({
    mutationFn: () => api.post('/api/engine/stop'),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['engine'] }); sfx.stop(); },
    onError: (e: Error) => { message.error(e.message); sfx.error(); },
  });
  const st = status.data;
  const canAskNotify = typeof Notification !== 'undefined' && Notification.permission === 'default';
  return (
    <Card size="small" title="快刷引擎" extra={
      <Space>
        {canAskNotify && (
          <Button size="small" onClick={() => { void Notification.requestPermission(); }}>
            开启完成通知
          </Button>
        )}
        {st?.running
          ? <Button danger icon={<PauseOutlined />} onClick={() => stop.mutate()} loading={stop.isPending}>停止</Button>
          : <>
              <Button type="primary" icon={<CaretRightOutlined />}
                onClick={() => start.mutate('')} loading={start.isPending}>开始全部</Button>
            </>}
        <Typography.Text type="secondary">
          {st?.running ? `运行中 · ${st.course || '准备中'} · ${st.section}` : '空闲'}
        </Typography.Text>
      </Space>
    }>
      <pre ref={logRef} role="log" aria-live="polite" aria-busy={st?.running} style={{
        background: '#0C1712', color: '#B8D6C6', borderRadius: 8, padding: 12,
        minHeight: 180, maxHeight: 320, overflow: 'auto', fontSize: 12, lineHeight: 1.7,
      }}>{st?.logs.length ? st.logs.join('\n') : '尚未运行。点「开始全部」跑完所有未完成任务（考试/问卷类会自动跳过）。'}</pre>
      <Typography.Text type="secondary">
        单轮上报 ≤90s（平台 120s 静默丢弃上限），轮间歇 0.6–1.6s；当日配额满会自动停止
      </Typography.Text>
    </Card>
  );
}

/** 定时引擎：每天到点自动「开始全部」，配额满自动停；当天已跑不重复 */
function ScheduleCard() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const q = useQuery({ queryKey: ['schedule'], queryFn: () => api.get<ScheduleCfg>('/api/engine/schedule') });
  const save = useMutation({
    mutationFn: (v: Partial<ScheduleCfg>) => api.put('/api/engine/schedule', v),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedule'] }); },
    onError: (e: Error) => message.error(e.message),
  });
  const s = q.data;
  const opts = (max: number, step = 1) => Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  return (
    <Card size="small" title={<><ClockCircleOutlined /> 定时引擎</>} style={{ marginTop: 12 }}
      extra={<Switch size="small" aria-label="定时引擎开关" loading={save.isPending}
        checked={s?.enabled ?? false}
        disabled={!s}
        onChange={(v: boolean) => s && save.mutate({ enabled: v, hour: s.hour, minute: s.minute })} />} >
      <Space size={8} wrap align="center">
        <Typography.Text>每天</Typography.Text>
        <Select size="small" style={{ width: 76 }} value={s?.hour ?? 9} disabled={!s || save.isPending}
          options={opts(23).map((n) => ({ value: n, label: `${String(n).padStart(2, '0')} 点` }))}
          onChange={(hour) => s && save.mutate({ enabled: s.enabled, hour, minute: s.minute })} />
        <Select size="small" style={{ width: 76 }} value={s?.minute ?? 0} disabled={!s || save.isPending}
          options={opts(55, 5).map((n) => ({ value: n, label: `${String(n).padStart(2, '0')} 分` }))}
          onChange={(minute) => s && save.mutate({ enabled: s.enabled, hour: s.hour, minute })} />
        <Typography.Text type="secondary">自动「开始全部」，配额满自动停；当天已跑不重复</Typography.Text>
      </Space>
      {s?.lastRunDay && <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>上次定时运行：{s.lastRunDay}</Typography.Text>}
    </Card>
  );
}

export default function Tasks() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api.get<{ tasks: TaskRow[] }>('/api/tasks') });
  const [kw, setKw] = useState('');
  const [onlyRequired, setOnlyRequired] = useState(false);
  const startOne = useMutation({
    mutationFn: (bid: string) => api.post('/api/engine/start', { courseId: bid }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['engine'] }); message.success('已启动，看日志页进度'); sfx.start(); },
    onError: (e: Error) => { message.error(e.message); sfx.error(); },
  });
  const all = tasks.data?.tasks ?? [];
  const rows = all.filter((t) =>
    (!kw || t.name.toLowerCase().includes(kw.trim().toLowerCase()))
    && (!onlyRequired || t.required));
  const [detailBid, setDetailBid] = useState<string | null>(null);
  const csv = () => {
    const head = '任务名,类型,必修,状态,已学(学时),截止';
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = all.map((t) => [
      t.name, t.kind, t.required ? '必修' : '选修', t.state, t.studiedH,
      t.endTime ? new Date(t.endTime).toLocaleString('zh-CN') : '',
    ].map(esc).join(','));
    const blob = new Blob(['\uFEFF' + head + '\r\n' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `学习任务-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div>
      <EnginePanel />
      <ScheduleCard />
      <Card size="small" title="学习任务" style={{ marginTop: 12 }} extra={
        <Space size={8} wrap>
          <Input.Search size="small" allowClear placeholder="搜任务名" style={{ width: 180 }}
            value={kw} onChange={(e) => setKw(e.target.value)} />
          <Button size="small" type={onlyRequired ? 'primary' : 'default'} onClick={() => setOnlyRequired((v) => !v)}>
            只看必修
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={csv} disabled={!all.length}>
            下载 CSV
          </Button>
          <Typography.Text type="secondary" className="num">{rows.length} / {all.length}</Typography.Text>
        </Space>
      }>
        {tasks.isError && <Alert type="warning" showIcon message={(tasks.error as Error).message} />}
        <Table<TaskRow> rowKey="bid" size="small" columns={columns((bid) => startOne.mutate(bid), setDetailBid)} dataSource={rows}
          loading={tasks.isLoading} pagination={{ pageSize: 15, showSizeChanger: false }} scroll={{ x: 'max-content' }}
          locale={{ emptyText: all.length ? '没有匹配的任务' : '没有任务（先绑定平台账号）' }} />
      </Card>
      <CourseDetail bid={detailBid} onClose={() => setDetailBid(null)} />
    </div>
  );
}
