'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ToastHost } from '../components/toast-host';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, refetchOnWindowFocus: false },
        },
        /**
         * No `MutationCache.onError` here, deliberately.
         *
         * A global handler cannot see the form an error came from, so every
         * validation failure that was routed to inline field messages would also
         * raise an unconditional generic toast — the duplicate-notification
         * problem, installed at the root. `useAction` owns the decision because
         * it is the only layer that knows both the failure and the form.
         */
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {/*
        Mounted once, outside the page tree, so a notification survives the
        navigation that raised it — committing a draft routes to the progress
        board, and the toast has to outlive the screen it came from.
      */}
      <ToastHost />
    </QueryClientProvider>
  );
}
