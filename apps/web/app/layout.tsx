import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Teamem Cloud',
  description: 'Managed Teamem setup for humans and their coding agents.'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
