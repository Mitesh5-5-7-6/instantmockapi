import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Demo API Builder',
  description: 'Explore an editable E-commerce Project API data model inside InstantMockAPI.',
  robots: { index: false, follow: false },
};

export default function DemoApiLayout({ children }: { children: React.ReactNode }) {
  return children;
}
