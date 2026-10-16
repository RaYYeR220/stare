import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DeskShell } from '@/components/desk/Shell';
import { DeskProvider } from '@/lib/desk';
import './desk.css';

export const metadata: Metadata = {
  title: 'The desk',
  description: 'The reading room: decide requests on precedent that is still good law, and see why.',
};

export default function DeskLayout({ children }: { children: ReactNode }) {
  return (
    <DeskProvider>
      <DeskShell>{children}</DeskShell>
    </DeskProvider>
  );
}
