import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { HashRouter } from 'react-router-dom';
import { walletConfig } from './lib/runtime';
import App from './App';
import './styles.css';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
      queryKeyHashFn: (key) =>
        JSON.stringify(key, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    },
  },
});
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={walletConfig}>
      <QueryClientProvider client={client}>
        <HashRouter>
          <App />
        </HashRouter>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
