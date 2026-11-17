import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
export const metadata: Metadata = {
  title: 'Document Intelligence | Workspace',
  description: 'Private document processing, financial review, search and reconciliation.',
};
export default function RootLayout({ children }: {
  children: ReactNode;
}) {
  return <html lang="en">
    <body>{children}</body>
  </html>;
}
