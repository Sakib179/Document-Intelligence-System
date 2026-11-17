import { SystemStatus } from '../../system-status';
export default function SystemPage() {
  return <>
    <div className="page-heading">
      <div>
        <div className="eyebrow">OPERATIONS</div>
        <h1>Service status</h1>
        <p>Live readiness checks from your local services.</p>
      </div>
    </div>
    <SystemStatus />
  </>;
}
