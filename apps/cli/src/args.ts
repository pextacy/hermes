export const argv = process.argv.slice(2);
export const opt = (n: string, d?: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
export const flag = (n: string) => argv.includes(`--${n}`);
export function guardMainnet(network: string) {
  if (network === 'mainnet' && !flag('i-have-owner-approval')) {
    console.error('Mainnet needs the owner’s explicit approval in chat (CLAUDE.md). Add --i-have-owner-approval once approved.');
    process.exit(1);
  }
}
