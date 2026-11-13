import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Form, Input, Tabs, Typography } from 'antd';
import { api } from '../lib/api';
import { sfx } from '../lib/sfx';

interface AuthBody { username: string; password: string }

export default function Login() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [form] = Form.useForm<AuthBody>();

  const go = useMutation({
    mutationFn: ({ tab, values }: { tab: string; values: AuthBody }) =>
      tab === 'login' ? api.post('/api/auth/login', values) : api.post('/api/auth/register', values),
    onSuccess: () => { void qc.invalidateQueries(); sfx.login(); },
    onError: (e: Error) => { message.error(e.message); sfx.error(); },
  });

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <Card style={{ width: 'min(400px, calc(100vw - 32px))' }}>
        <Typography.Title level={4} className="brand-title" style={{ textAlign: 'center', marginTop: 4, marginBottom: 0 }}>烟草网络学院 · 学习助手</Typography.Title>
        <Tabs
          centered
          activeKey={tab}
          onChange={(k) => setTab(k as 'login' | 'register')}
          items={[
            { key: 'login', label: '登录' },
            { key: 'register', label: '注册' },
          ]}
        />
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => go.mutate({ tab, values: v })}
        >
          <Form.Item name="username" label="用户名" rules={[
            { required: true, message: '请输入用户名' },
            { pattern: /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/, message: '2-32 位，中英文/数字/下划线' },
          ]}>
            <Input autoFocus placeholder="站点用户名（不是平台账号）" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[
            { required: true, message: '请输入密码' },
            { min: 8, message: '至少 8 位' },
          ]}>
            <Input.Password placeholder={tab === 'register' ? '至少 8 位' : ''} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={go.isPending}>
            {tab === 'login' ? '登录' : '注册并登录'}
          </Button>
        </Form>
        {tab === 'register' && (
          <Alert style={{ marginTop: 16 }} type="info" showIcon
            message="注册成功后，在「总览」页绑定你的平台账号即可开始使用" />
        )}
      </Card>
    </div>
  );
}
