import { ApiError } from "./lib/api";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { tokens, injectCssVars } from './theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        // 认证类失败重试没有意义（401/未绑定不会自愈）
        !(error instanceof ApiError && (error.code === 'AUTH' || error.code === 'UNBOUND')) && failureCount < 1,
      refetchOnWindowFocus: false, staleTime: 30_000,
    },
  },
});

injectCssVars();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: tokens.green,
            colorLink: tokens.colorLink,
            colorBgLayout: tokens.bg,
            colorBgContainer: tokens.surface,
            colorBorderSecondary: tokens.line,
            colorText: tokens.ink,
            colorTextSecondary: tokens.ink2,
            colorTextTertiary: tokens.ink3,
            borderRadius: 8,
          },
        }}
      >
        <AntApp>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  </StrictMode>,
);
