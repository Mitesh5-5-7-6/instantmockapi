/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The platform API is a separate service (doc 08); the web app talks HTTP only (doc 05)
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },
};

export default nextConfig;
