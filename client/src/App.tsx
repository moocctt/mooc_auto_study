import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Layout, Menu, Space, Spin, Tag, App as AntApp } from 'antd';
import { DashboardOutlined, LogoutOutlined, PlayCircleOutlined, AppstoreOutlined, CalendarOutlined, SoundOutlined, MutedOutlined } from '@ant-design/icons';
import './app.css';
import { api, type Me } from './lib/api';
import { isMuted, setMuted, warmup } from './lib/sfx';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Tasks from './pages/Tasks';
import Library from './pages/Library';
import Schedule from './pages/Schedule';

const { Header, Sider, Content } = Layout;

function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/api/auth/me'),
    retry: false,
  });
}

function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [soundOn, setSoundOn] = useState(!isMuted());
  // 预热 AudioContext：任意首次点击后即可在非手势回调里发声
  useEffect(() => {
    const h = () => warmup();
    window.addEventListener('pointerdown', h, { once: true });
    return () => window.removeEventListener('pointerdown', h);
  }, []);
  const toggleSound = () => {
    const next = !soundOn;
    setMuted(!next);
    setSoundOn(next);
  };
  const logout = async () => {
    await api.post('/api/auth/logout');
    await qc.invalidateQueries();
    message.success('已退出');
  };
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="light" width={200} breakpoint="lg" collapsedWidth={64} style={{ borderRight: '1px solid #eee' }}>
        <div className="brand">
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: 'var(--green)', marginRight: 8 }} />
          <span className="brand-text brand-title" style={{ color: 'var(--green-deep)' }}>学习助手</span>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={[
            { key: '/', icon: <DashboardOutlined />, label: <NavLink to="/">总览</NavLink> },
            { key: '/tasks', icon: <PlayCircleOutlined />, label: <NavLink to="/tasks">任务 · 引擎</NavLink> },
            { key: '/library', icon: <AppstoreOutlined />, label: <NavLink to="/library">课程库</NavLink> },
            { key: '/schedule', icon: <CalendarOutlined />, label: <NavLink to="/schedule">日程</NavLink> },
          ]}
        />
      </Sider>
      <Layout>
        <Header className="app-header" style={{ background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
          <span className="brand-title" style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>烟草网络学院 · 学习助手</span>
          <Space>
            <Button
              type="text"
              icon={soundOn ? <SoundOutlined /> : <MutedOutlined />}
              onClick={toggleSound}
              title={soundOn ? '关闭音效' : '开启音效'}
              aria-label={soundOn ? '关闭音效' : '开启音效'}
            />
            <Tag color="green">{me.username}</Tag>
            <Button icon={<LogoutOutlined />} onClick={() => logout().catch(() => message.error('退出失败'))}>退出</Button>
          </Space>
        </Header>
        <Content className="page-content" style={{ maxWidth: 1200, width: '100%', margin: '0 auto' }}>{children}</Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  const { data: me, isLoading, isError } = useMe();
  if (isLoading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Spin tip="正在进入…" size="large" />
    </div>
  );
  if (isError || !me) return <Routes>
    <Route path="*" element={<Login />} />
  </Routes>;
  return (
    <Shell me={me}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/library" element={<Library />} />
        <Route path="/schedule" element={<Schedule />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
