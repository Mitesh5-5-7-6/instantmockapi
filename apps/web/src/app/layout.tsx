import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Analytics } from '@vercel/analytics/next';
import { Providers } from './providers';
import { AppShell } from '../components/app-shell';
import '@instantmockapi/ui/styles.css';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ? new URL(process.env.NEXT_PUBLIC_SITE_URL)
  : undefined;

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: 'InstantMockAPI | Build realistic mock APIs faster',
    template: '%s | InstantMockAPI',
  },
  description:
    'Create realistic mock APIs from JSON or OpenAPI requirements, with connected data, CRUD endpoints, and hosted backend artifacts.',
  applicationName: 'InstantMockAPI',
  authors: [{ name: 'InstantMockAPI' }],
  creator: 'InstantMockAPI',
  keywords: [
    'mock API',
    'API mocking tool',
    'OpenAPI mock server',
    'JSON to API',
    'fake REST API',
    'frontend development',
  ],
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    siteName: 'InstantMockAPI',
    title: 'InstantMockAPI | Build realistic mock APIs faster',
    description:
      'Create realistic mock APIs from JSON or OpenAPI requirements, with connected data, CRUD endpoints, and hosted backend artifacts.',
    url: '/',
    images: [{ url: '/icon.png', width: 512, height: 512, alt: 'InstantMockAPI' }],
  },
  twitter: {
    card: 'summary',
    title: 'InstantMockAPI | Build realistic mock APIs faster',
    description:
      'Create realistic mock APIs from JSON or OpenAPI requirements, with connected data, CRUD endpoints, and hosted backend artifacts.',
    images: ['/icon.png'],
  },
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
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
        <Analytics />
      </body>
    </html>
  );
}
