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
      <head>
        {/* The type the design names. Without this, `--font-ui` fell through to
            the system font (Segoe UI on Windows). A stylesheet link rather than
            next/font, so the build never depends on reaching a font host. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
      </head>
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
