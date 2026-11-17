'use client';
export default function ErrorPage({ reset }: {
  error: Error;
  reset: () => void;
}) {
  return <main className="standalone">
    <h1>Workspace unavailable.</h1>
    <p>We couldn’t load this page. Check the service connection and try again.</p>
    <button className="button" onClick={reset}>Try again</button>
    <a className="text-link" href="/">Return to workspace</a>
  </main>;
}
