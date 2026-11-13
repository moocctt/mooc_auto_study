import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Empty, Input, Segmented, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { api, LIBRARY_KINDS, type LibraryItem, type LibraryResult } from '../lib/api';

export default function Library() {
  const [kind, setKind] = useState(0);
  const [kw, setKw] = useState('');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'covers' | 'list'>('covers');

  const result = useQuery<LibraryResult>({
    queryKey: ['library', kind, q],
    queryFn: () => api.get(`/api/library?kind=${kind}&kw=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
    placeholderData: (prev) => prev,
  });

  const items = result.data?.items ?? [];
  const showCover = view === 'covers' && (kind === 0 || kind === 2);

  return (
    <Card size="small" title="课程库（12 类内容检索）">
      <Space wrap style={{ marginBottom: 12 }}>
        <Select value={kind} onChange={setKind} style={{ width: 130 }}
          options={LIBRARY_KINDS.map((k) => ({ value: k.id, label: k.label }))} />
        <Input.Search
          placeholder={`搜索${LIBRARY_KINDS.find((k) => k.id === kind)?.label ?? ''}…`}
          style={{ width: 'min(320px, 100%)' }}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onSearch={(v) => setQ(v.trim())}
        />
        <Segmented options={[{ label: '封面', value: 'covers' }, { label: '列表', value: 'list' }]}
          value={view} onChange={(v) => setView(v as 'covers' | 'list')} />
        {result.data && <Typography.Text type="secondary">共 {result.data.total} 条</Typography.Text>}
      </Space>

      {result.isError && <Alert type="warning" showIcon message={(result.error as Error).message} />}

      {!q && !result.isError && (
        <Empty description={
          <Typography.Text type="secondary">
            输入关键词开始检索；课程与专题支持封面视图，其余类型为列表视图
          </Typography.Text>
        } />
      )}

      {q && result.isLoading && (
        <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
      )}

      {showCover && items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {items.map((it: LibraryItem) => (
            <Card key={it.id} size="small" hoverable cover={
              it.cover
                ? <img alt={it.name} src={it.cover} style={{ height: 110, objectFit: 'cover' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                : <div style={{ height: 110, background: '#EEF0E8', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5F6B65' }}>{it.kind}</div>
            }>
              <Tooltip title={it.name}>
                <Typography.Text strong ellipsis style={{ maxWidth: '100%' }}>{it.name}</Typography.Text>
              </Tooltip>
              <div style={{ marginTop: 4 }}>
                {it.joined ? <Tag color="green">已加入任务</Tag> : <Tag>{it.kind}</Tag>}
                {it.credit > 0 && <Tag>学分 {it.credit}</Tag>}
                {it.courseHour > 0 && <Tag>学时 {it.courseHour}</Tag>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {!showCover && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((it) => (
            <div key={it.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
              background: 'var(--green-wash)', borderRadius: 8,
            }}>
              <Tag>{it.kind}</Tag>
              <Typography.Text ellipsis style={{ flex: 1 }}>{it.name}</Typography.Text>
              {it.joined && <Tag color="green">已加入任务</Tag>}
              {it.credit > 0 && <Typography.Text type="secondary">学分 {it.credit}</Typography.Text>}
              {it.courseHour > 0 && <Typography.Text type="secondary">学时 {it.courseHour}</Typography.Text>}
              {it.startTime ? <Typography.Text type="secondary">{new Date(it.startTime).toLocaleDateString('zh-CN')}</Typography.Text> : null}
            </div>
          ))}
        </div>
      )}

      {q && !result.isLoading && !items.length && !result.isError &&
        <Typography.Text type="secondary">没有匹配结果</Typography.Text>}
    </Card>
  );
}
