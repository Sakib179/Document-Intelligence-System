import { redirect } from 'next/navigation';
// Preserve old bookmarks without retaining a sign-in screen.
export default function FormerLogin(){redirect('/');}
