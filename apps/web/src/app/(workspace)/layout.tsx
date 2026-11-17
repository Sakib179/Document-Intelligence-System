import type { ReactNode } from 'react';
import { workspaceUser } from '../../lib/backend';
import { Shell } from '../../components/shell';
export const dynamic = 'force-dynamic';
export default async function WorkspaceLayout({ children }: {
  children: ReactNode;
}) {
  const user = await workspaceUser();return <Shell user={user}>{children}</Shell>;
}
