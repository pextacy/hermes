import { useState } from 'react';
import type { BchNetwork } from '@hermes/chain';
import { useHermes } from '../lib/context';
import { MIN_RELAYS, defaultSettings, isCustom, parseList, resetSettings, saveSettings, validateSettings, type Settings } from '../lib/settings';
import { Card, Status } from '../components/ui';
import { ProbeList, useConnectivity } from '../components/Health';
import { ThemeChooser } from '../components/ShellExtras';
import { toast } from '../components/Toast';

/** Probes the servers typed in the form (not yet saved), on demand. */
function TestPanel({ draft, network }: { draft: Settings; network: BchNetwork }) {
  const c = useConnectivity(network, draft.relays, draft.electrum[network], 0);
  return <ProbeList c={c} network={network} />;
}

/** F33: choose your own Nostr relays and Electrum (Fulcrum) servers. Stored in this browser only; used by Pay, Identity, Swap and Claims. */
export function SettingsTab() {
  const { settings, theme, setTheme, payNetwork, setPayNetwork } = useHermes();
  const pickPay = (n: BchNetwork) => {
    if (n === payNetwork) return;
    if (setPayNetwork(n)) toast(n === 'mainnet' ? 'Pay is now on BCH mainnet — real funds' : 'Pay switched to chipnet — test coins only', n === 'mainnet' ? 'warn' : 'ok');
    else toast('Pay stays on chipnet', 'info');
  };
  const [relays, setRelays] = useState(settings.relays.join('\n'));
  const [main, setMain] = useState(settings.electrum.mainnet.join('\n'));
  const [chip, setChip] = useState(settings.electrum.chipnet.join('\n'));
  const [t4, setT4] = useState(settings.electrum.testnet4.join('\n'));
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [test, setTest] = useState<{ draft: Settings; n: number }>();
  const draft: Settings = { relays: parseList(relays), electrum: { mainnet: parseList(main), chipnet: parseList(chip), testnet4: parseList(t4) } };
  const errors = validateSettings(draft);
  const invalid = Object.keys(errors).length > 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const fill = (s: Settings) => {
    setRelays(s.relays.join('\n'));
    setMain(s.electrum.mainnet.join('\n'));
    setChip(s.electrum.chipnet.join('\n'));
    setT4(s.electrum.testnet4.join('\n'));
    setMsg(undefined);
  };
  const reload = (text: string) => {
    setMsg({ ok: true, text });
    setTimeout(() => location.reload(), 500);
  };
  return (
    <div className="stack">
      <div className="hero small">
        <h2>Settings</h2>
        <p>
          Hermes has no server of its own: pick the Nostr relays and Electrum (Fulcrum) servers you trust. They are stored in this browser
          and used by Pay, Identity, Swap and Claims. Discovery needs at least {MIN_RELAYS} relays.
        </p>
        <p className="small">
          {isCustom(settings) ? <span className="pill pill-warn">Custom servers active</span> : <span className="pill">Using the default servers</span>}
        </p>
      </div>
      <div className="grid2">
        <Card title="Appearance" aside={<span className="muted small">this browser</span>}>
          <ThemeChooser theme={theme} onChange={setTheme} />
          <p className="muted small">System follows your device's light/dark setting.</p>
        </Card>
        <Card title="Pay network" aside={<span className="muted small">Pay tab only</span>}>
          <div className="seg" role="radiogroup" aria-label="Pay network">
            {(['chipnet', 'mainnet'] as const).map((n) => (
              <button key={n} role="radio" aria-checked={payNetwork === n} className={payNetwork === n ? 'on' : ''} onClick={() => pickPay(n)}>
                {n === 'mainnet' ? 'Mainnet (real funds)' : 'Chipnet (test coins)'}
              </button>
            ))}
          </div>
          <p className="muted small">Switching to mainnet asks for confirmation; a warning strip stays on screen while Pay is on mainnet.</p>
        </Card>
      </div>
      <Card title="Nostr relays" aside={<span className="muted small">one per line · wss://</span>}>
        <textarea
          className="mono"
          rows={5}
          value={relays}
          spellCheck={false}
          aria-invalid={!!errors.relays}
          aria-label="Nostr relays"
          onChange={(e) => setRelays(e.target.value)}
        />
        {errors.relays && <Status kind="err">{errors.relays}</Status>}
      </Card>
      <div className="grid2">
        <Card title="Electrum · mainnet" aside={<span className="muted small">host or host:port</span>}>
          <textarea className="mono" rows={4} value={main} spellCheck={false} aria-invalid={!!errors.mainnet} aria-label="Mainnet Electrum servers" onChange={(e) => setMain(e.target.value)} />
          {errors.mainnet && <Status kind="err">{errors.mainnet}</Status>}
        </Card>
        <Card title="Electrum · chipnet" aside={<span className="muted small">host or host:port</span>}>
          <textarea className="mono" rows={4} value={chip} spellCheck={false} aria-invalid={!!errors.chipnet} aria-label="Chipnet Electrum servers" onChange={(e) => setChip(e.target.value)} />
          {errors.chipnet && <Status kind="err">{errors.chipnet}</Status>}
        </Card>
        <Card title="Electrum · testnet4" aside={<span className="muted small">host or host:port</span>}>
          <textarea className="mono" rows={4} value={t4} spellCheck={false} aria-invalid={!!errors.testnet4} aria-label="Testnet4 Electrum servers" onChange={(e) => setT4(e.target.value)} />
          {errors.testnet4 && <Status kind="err">{errors.testnet4}</Status>}
        </Card>
      </div>
      <div className="row wrap">
        <button
          className="primary"
          disabled={invalid || !dirty}
          onClick={() => {
            try {
              saveSettings(draft);
              reload('Saved — reloading so every tab reconnects…');
            } catch (e) {
              setMsg({ ok: false, text: (e as Error).message });
            }
          }}
        >
          Save
        </button>
        <button disabled={invalid} onClick={() => setTest({ draft, n: (test?.n ?? 0) + 1 })}>
          Test connections
        </button>
        <button onClick={() => fill(defaultSettings())}>Fill defaults</button>
        {isCustom(settings) && (
          <button
            className="ghost"
            onClick={() => {
              resetSettings();
              reload('Reset to defaults — reloading…');
            }}
          >
            Reset to defaults
          </button>
        )}
        {dirty && !msg && <span className="muted small">Unsaved changes</span>}
      </div>
      {msg && <Status kind={msg.ok ? 'ok' : 'err'}>{msg.text}</Status>}
      {test && (
        <Card title="Connection test" aside={<span className="muted small">servers as typed above</span>}>
          <div className="grid2">
            <TestPanel key={`m${test.n}`} draft={test.draft} network="mainnet" />
            <TestPanel key={`c${test.n}`} draft={{ ...test.draft, relays: [] }} network="chipnet" />
            <TestPanel key={`t${test.n}`} draft={{ ...test.draft, relays: [] }} network="testnet4" />
          </div>
        </Card>
      )}
    </div>
  );
}
