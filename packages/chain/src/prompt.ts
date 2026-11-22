import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/**
 * Ask for a secret on the terminal without echoing it. Keys and mnemonics are entered by
 * the owner at runtime and never written to disk or logs (no .env files — CLAUDE.md).
 */
export async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${question}: a terminal is required to enter secrets`);
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(question);
  muted = true;
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim();
}
