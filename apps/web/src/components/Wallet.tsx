import { WizardConnectQRDialog } from '@wizardconnect/react';
import { useHermes } from '../lib/context';

export function WalletButton() {
  const { wc } = useHermes();
  return (
    <div className="wallet">
      {wc.state === 'connected' ? (
        <>
          <span className="dot ok" /> <span className="wallet-name">{wc.walletName ?? 'Wallet'}</span>
          <button className="ghost" onClick={() => void wc.disconnect()}>
            Disconnect
          </button>
        </>
      ) : (
        <button className="small" title="Connect a Bitcoin Cash wallet with WizardConnect" onClick={() => wc.connect()} disabled={wc.state === 'connecting' || wc.state === 'reconnecting'}>
          {wc.state === 'connecting' ? (
            'Waiting for wallet…'
          ) : wc.state === 'reconnecting' ? (
            'Reconnecting…'
          ) : (
            <>
              Connect wallet<span className="wc-via"> (WizardConnect)</span>
            </>
          )}
        </button>
      )}
      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog
          show={wc.state === 'connecting'}
          onClose={() => void wc.disconnect()}
          uri={wc.uri}
          qrUri={wc.qrUri}
          title="Connect to Hermes"
          subtitle="Scan with a WizardConnect wallet"
          theme={{ dialogBackground: '#101b2d', headerBackground: '#101b2d', borderColor: '#24344f' }}
        />
      )}
      {wc.error && <span className="err small">{wc.error}</span>}
    </div>
  );
}
