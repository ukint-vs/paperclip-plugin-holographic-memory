import type { HolographicMemoryConfig } from "../types.js";

export interface SettingsPanelProps {
  config: HolographicMemoryConfig;
  status?: string;
}

export function SettingsPanel({ config, status }: SettingsPanelProps) {
  return (
    <section>
      <h2>Holographic Memory</h2>
      <dl>
        <dt>Database</dt>
        <dd>{config.dbPath}</dd>
        <dt>Recall</dt>
        <dd>{config.recallEnabled ? "Enabled" : "Disabled"}</dd>
        <dt>Minimum trust</dt>
        <dd>{config.minTrustScore}</dd>
        <dt>Facts per recall</dt>
        <dd>{config.maxFactsPerRecall}</dd>
      </dl>
      {status ? <p>{status}</p> : null}
    </section>
  );
}

export default SettingsPanel;
