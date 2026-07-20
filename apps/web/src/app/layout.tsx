import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import { AppShell } from '../components/app-shell';
import '@instantmockapi/ui/styles.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'InstantMockAPI',
  description: 'Turn API requirements into generated backend artifacts and a hosted mock API',
};

// Apply the stored theme before first paint to avoid a flash of wrong theme
const themeBootstrap = `try{var t=localStorage.getItem('instantmockapi.theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
