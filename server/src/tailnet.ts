// 이 PC의 Tailscale 상태를 읽는다 (읽기만). 휴대폰이 들어올 주소·계정을 알아야 원격 요청을 검사할 수 있다.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TailnetInfo } from '../../shared/src/mobile.ts';

export const OFF: TailnetInfo = { running: false, dnsName: null, login: null, certs: false, serving: false };

export function tailscaleExe(): string {
  const installed = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  return existsSync(installed) ? installed : 'tailscale';
}

const run = (args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(tailscaleExe(), args, { encoding: 'utf8', timeout: 10_000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out))));

export async function readTailnet(port: number): Promise<TailnetInfo> {
  let status: { BackendState?: string; Self?: { DNSName?: string; UserID?: number }; User?: Record<string, { LoginName?: string }>; CertDomains?: string[] | null };
  try { status = JSON.parse(await run(['status', '--json'])); } catch { return OFF; }
  if (status.BackendState !== 'Running' || !status.Self?.DNSName) return { ...OFF, running: status.BackendState === 'Running' };
  const dnsName = status.Self.DNSName.replace(/\.$/, '');
  const login = status.User?.[String(status.Self.UserID)]?.LoginName ?? null;
  const serve = await run(['serve', 'status', '--json']).catch(() => '');
  return {
    running: true,
    dnsName,
    login,
    certs: (status.CertDomains ?? []).includes(dnsName),
    // serve 설정 안에 이 서버 주소로 넘기는 항목이 있는지
    serving: serve.includes(`127.0.0.1:${port}`) || serve.includes(`localhost:${port}`),
  };
}
