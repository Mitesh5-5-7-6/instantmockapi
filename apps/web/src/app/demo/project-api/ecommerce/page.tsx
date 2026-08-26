import type { Metadata } from 'next';
import { EcommerceDemo } from '../../../../components/demo/ecommerce-demo';

export const metadata: Metadata = {
  title: 'E-commerce Project API Demo',
  description:
    'Explore a realistic E-commerce Project API with authentication, customers, products, orders, payments, delivery, and entity relationships.',
  alternates: { canonical: '/demo/project-api/ecommerce' },
  robots: { index: true, follow: true },
  openGraph: {
    title: 'E-commerce Project API Demo | InstantMockAPI',
    description: 'Explore a complete commerce backend model and its request surface.',
    type: 'website',
    url: '/demo/project-api/ecommerce',
  },
};

export default function EcommerceDemoPage() {
  return <EcommerceDemo />;
}
