import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Form, Input, Modal, Progress, Row, Skeleton, Spin, Table, Tag, Typography } from 'antd';
import { api, type DueRow, type Heatmap, type HistoryDay, type Hours, type PlatformBound, ApiError } from '../lib/api';
import type { ColumnsType } from 'antd/es/table';

function Track({ title, done, required, hint }: { title: string; done: number; required: number; hint?: string }) {
  const pct = required > 0 ? Math.min(100, (done / required) * 100) : 0;
  return (
    <Card size="small" title={title} styles={{ body: { paddingTop: 12 } }}>
      <div className="kpi-value num">
        {done.toFixed(2)}
        <span style={{ fontSize: '1rem', fontWeight: 400, color: 'var(--ink-3)' }}> / {required.toFixed(2)} 学时</span>
      </div>
      <Progress percent={Number(pct.toFixed(1))} showInfo={false} strokeColor="var(--green)"
        trailColor="var(--green-wash)" style={{ marginTop: 8, marginBottom: 4 }} />
      <Typography.Text type="secondary" className="num" style={{ fontSize: 'var(--text-secondary)' }}>
        已完成 {pct.toFixed(0)}%{hint ? ` · ${hint}` : ''}
      </Typography.Text>
    </Card>
  );
}

function Heat({ data }: { data: Heatmap }) {
  const lvColor = ['#EBEFEA', '#B8D6C6', '#7FB89D', '#4A9A77', '#007556'];
  const weeks: typeof data.cells[] = [];
  for (let i = 0; i < data.cells.length; i += 7) weeks.push(data.cells.slice(i, i + 7));
  const s = data.summary;
  // 热力图下钻：点某天看当日学习流水
  const [day, setDay] = useState<string | null>(null);
  const hist = useQuery({
    queryKey: ['history', day],
    queryFn: () => api.get<HistoryDay>(`/api/history?date=${day}`),
    enabled: day !== null,
  });
  return (
    <Card size="small" title="学习热力图（26 周）" extra={
      <Typography.Text type="secondary" className="num">
        今日 {s.today.toFixed(2)} · 本周 {s.week.toFixed(2)} · 本月 {s.month.toFixed(2)} · 本年 {s.year.toFixed(2)} 学时
      </Typography.Text>
    }>
      <div style={{ display: 'flex', gap: 3, overflowX: 'auto', padding: 4 }}>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {week.map((c) => (
              <div key={c.day} role="button" tabIndex={0}
                onClick={() => setDay(c.day)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setDay(c.day); }}
                className="heat-cell"
                title={`${c.day} · ${c.hours.toFixed(2)} 学时，点击看明细`}
                style={{ background: lvColor[c.level] ?? lvColor[0], cursor: 'pointer' }} />
            ))}
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, marginLeft: 8 }}>
          <span className="heat-legend-label" style={{ marginRight: 2 }}>少</span>
          {lvColor.map((c, i) => <div key={i} style={{ width: 12, height: 12, borderRadius: 3, background: c }} />)}
          <span className="heat-legend-label" style={{ marginLeft: 2 }}>多</span>
        </div>
      </div>
      <Modal
        title={<span>{day} 学习明细 {hist.data && <Typography.Text type="secondary" className="num">共 {hist.data.totalMin} 分钟</Typography.Text>}</span>}
        open={day !== null}
        onCancel={() => setDay(null)}
        footer={null}
        width={520}
      >
        {hist.isPending && <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>}
        {hist.data && hist.data.items.length === 0 && <Typography.Text type="secondary">这一天没有学习记录</Typography.Text>}
        {hist.data && hist.data.items.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', maxHeight: 420, overflowY: 'auto' }}>
            {hist.data.items.map((x, i) => (
              <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</span>
                {x.required && <Tag color="green">必修</Tag>}
                <Tag>{x.kind}</Tag>
                <span className="num" style={{ minWidth: 64, textAlign: 'right' }}>{x.minutes} 分钟</span>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </Card>
  );
}

function PlatformBind() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { data: bound, isPending: boundPending } = useQuery({
    queryKey: ['bound'],
    queryFn: () => api.get<PlatformBound | null>('/api/auth/platform'),
  });
  const bind = useMutation({
    mutationFn: (v: { username: string; password: string; company?: string }) => api.post('/api/auth/platform', v),
    onSuccess: () => { void qc.invalidateQueries(); message.success('平台账号已绑定并验证通过'); },
    onError: (e: Error) => message.error(e.message),
  });
  if (boundPending) return <Card size="small"><Skeleton active title={false} paragraph={{ rows: 1 }} /></Card>;
  if (bound) {
    return <Alert type="success" showIcon
      message={`平台账号已绑定：${bound.username}（${bound.company}）`}
      action={
        <Button size="small" danger onClick={async () => { await api.del('/api/auth/platform'); void qc.invalidateQueries(); }}>
          解绑
        </Button>
      } />;
  }
  return (
    <Card size="small" title="绑定平台账号（烟草网络学院）">
      <Form layout="inline" onFinish={(v) => bind.mutate(v)}>
        <Form.Item name="username" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="平台账号" style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="password" rules={[{ required: true, message: '必填' }]}>
          <Input.Password placeholder="平台密码" style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="company" initialValue="全行业">
          <Input placeholder="单位名称" style={{ width: 140 }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={bind.isPending}>绑定</Button>
        </Form.Item>
      </Form>
      <Typography.Text type="secondary">
        绑定时会真实登录一次验证；密码加密落库（AES-256-GCM），用于引擎自动续期登录态
      </Typography.Text>
    </Card>
  );
}

const dueColumns: ColumnsType<DueRow> = [
  { title: '任务', dataIndex: 'name', ellipsis: true },
  { title: '类型', dataIndex: 'kind', width: 70, render: (v) => <Tag>{v}</Tag> },
  {
    title: '截止', dataIndex: 'endTime', width: 170,
    render: (v: number | null) => {
      if (!v) return '—';
      const left = v - Date.now();
      const d = Math.floor(left / 86400_000);
      return <Tag color={d <= 1 ? 'red' : d <= 3 ? 'orange' : 'default'}>
        {new Date(v).toLocaleDateString('zh-CN')}（剩 {d < 1 ? Math.round(left / 3600_000) + ' 小时' : d + ' 天'}）
      </Tag>;
    },
  },
];

export default function Dashboard() {
  const hours = useQuery({ queryKey: ['hours'], queryFn: () => api.get<Hours>('/api/hours') });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api.get<{ due: DueRow[] }>('/api/tasks') });
  const heat = useQuery({ queryKey: ['heatmap'], queryFn: () => api.get<Heatmap>('/api/heatmap') });
  const h = hours.data;
  const boundError = hours.error instanceof ApiError && hours.error.code === 'UNBOUND';
  // 达标预测：按近 4 周周均速推算自学轨剩余学时
  const fc = h?.forecast;
  const selfHint = fc
    ? fc.remainingH <= 0
      ? '已达标'
      : fc.eta
        ? `${fc.weeklyH.toFixed(1)} 学时/周 · 预计 ${new Date(fc.eta).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 达标`
        : '暂无学习节奏数据，开跑几天后给出预测'
    : undefined;
  return (
    <div>
      <PlatformBind />
      {hours.isError && !boundError &&
        <Alert type="warning" showIcon message={(hours.error as Error).message} style={{ marginTop: 12 }} />}
      {hours.isPending && !boundError && (
        <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
          <Col xs={24} md={12}><Card size="small"><Skeleton active paragraph={{ rows: 2 }} /></Card></Col>
          <Col xs={24} md={12}><Card size="small"><Skeleton active paragraph={{ rows: 2 }} /></Card></Col>
        </Row>
      )}
      {h && (
        <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
          <Col xs={24} md={12}><Track title="网络自学（必修课）" done={h.self.done} required={h.self.required} hint={selfHint} /></Col>
          <Col xs={24} md={12}>
            <Track title="集中培训" done={h.train.done} required={h.train.required}
              hint={h.gap > 0 ? `面授缺口 ${h.gap.toFixed(2)} 学时（网课补不上）` : undefined} />
          </Col>
        </Row>
      )}
      <div style={{ marginTop: 12 }}>
        {heat.isPending && <Card size="small"><Skeleton active title paragraph={{ rows: 3 }} /></Card>}
        {heat.data && <Heat data={heat.data} />}
      </div>
      <Card size="small" title="必修临近截止（7 天内）" style={{ marginTop: 12 }}>
        <Table<DueRow> rowKey="bid" size="small" columns={dueColumns} dataSource={tasks.data?.due ?? []}
          loading={tasks.isLoading} pagination={false} scroll={{ x: 'max-content' }}
          locale={{ emptyText: '近 7 天没有要截止的必修任务' }} />
      </Card>
    </div>
  );
}
