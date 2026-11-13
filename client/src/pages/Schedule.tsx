import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Skeleton, Table, Tag, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { api, type ScheduleItem } from '../lib/api';
import type { ColumnsType } from 'antd/es/table';

const KIND_COLOR: Record<string, string> = { 班级: 'green', 考试: 'red', 调研: 'blue', 直播: 'purple' };
const KIND_ORDER = ['班级', '考试', '调研', '直播'];

const fmt = (t: number | null) => (t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function statusOf(x: ScheduleItem) {
  const now = Date.now();
  if (x.start && x.start > now) return <Tag>未开始</Tag>;
  if (x.end && x.end < now) return <Tag>已结束</Tag>;
  return <Tag color="processing">进行中</Tag>;
}

const columns: ColumnsType<ScheduleItem> = [
  {
    title: '类型', dataIndex: 'kind', width: 78, filters: KIND_ORDER.map((k) => ({ text: k, value: k })),
    onFilter: (v, r) => r.kind === v,
    render: (v) => <Tag color={KIND_COLOR[v] ?? 'default'}>{v}</Tag>,
  },
  { title: '名称', dataIndex: 'name', ellipsis: true },
  { title: '开始', dataIndex: 'start', width: 132, className: 'num', render: fmt },
  { title: '结束', dataIndex: 'end', width: 132, className: 'num', render: fmt },
  { title: '状态', key: 'st', width: 92, render: (_v, r) => statusOf(r) },
];

export default function Schedule() {
  const sched = useQuery({ queryKey: ['schedule'], queryFn: () => api.get<{ items: ScheduleItem[] }>('/api/schedule') });
  const items = sched.data?.items ?? [];
  const upcoming = items.filter((x) => (x.start ?? x.end ?? 0) > Date.now()).length;
  return (
    <div>
      <Card size="small" title="日程 · 班级 / 考试 / 调研 / 直播" extra={
        <Button icon={<DownloadOutlined />} size="small">
          <a href="/api/ics" download style={{ color: 'inherit', textDecoration: 'none' }}>下载日历 (.ics)</a>
        </Button>
      }>
        <Typography.Text type="secondary">
          近 7 天与未来一年的平台活动{sched.isPending ? '，加载中…' : `，共 ${items.length} 项（其中 ${upcoming} 项未开始）`}。日历文件含必修任务截止提醒，可导入 Outlook / 手机日历。
        </Typography.Text>
        <div style={{ marginTop: 12 }}>
          {sched.isPending && <Skeleton active paragraph={{ rows: 5 }} />}
          {sched.isError && <Alert type="warning" showIcon message={(sched.error as Error).message} />}
          {sched.data && (
            <Table<ScheduleItem> rowKey="id" size="small" columns={columns} dataSource={items}
              pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 项` }}
              scroll={{ x: 'max-content' }}
              locale={{ emptyText: '窗口内没有日程活动' }} />
          )}
        </div>
      </Card>
    </div>
  );
}
