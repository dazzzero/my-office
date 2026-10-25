// 대표실 비서: 대표의 말을 읽고 어느 층·팀·직원에게 어떤 일을 시킬지 업무 초안으로 나눈다.
// 도구 없이(--tools "") 한 번만 답하는 Claude 호출. 같은 요금제·모델(Opus 5.5)을 쓴다.
import type { MyOfficeConfig } from '../../shared/src/config.ts';
import type { Draft } from '../../shared/src/tasks.ts';
import { createOneShot, type OneShot } from './oneshot.ts';

export interface SecretaryAnswer {
  reply: string;
  drafts: Draft[];
}

export type AgentLister = (teamPath: string) => { name: string; description: string }[];

export function buildSecretaryPrompt(config: MyOfficeConfig, agentsOf: AgentLister, text: string): string {
  const org = config.floors.map(f => [
    `${f.label} ${f.name}`,
    ...f.teams.map(t => {
      const agents = agentsOf(t.path).map(a => `${a.name}${a.description ? `(${a.description.slice(0, 60)})` : ''}`).join(', ');
      return `  - teamId=${t.id} · ${t.name} · 폴더 ${t.path}${agents ? ` · 고정 직원: ${agents}` : ''}`;
    }),
  ].join('\n')).join('\n');
  return [
    '너는 "마이오피스"의 비서다. 대표의 요청을 읽고 어느 팀(teamId)에게 어떤 일을 시킬지 업무 초안으로 나눠라.',
    '',
    '[조직도]',
    org,
    '',
    '[규칙]',
    '- 한 요청에 여러 팀 일이 섞여 있으면 팀별로 나눠 drafts에 여러 개 넣는다.',
    '- teamId는 반드시 조직도에 있는 값만 쓴다. 어느 팀인지 애매하면 drafts를 비우고 reply로 되묻는다.',
    '- agent는 그 팀의 고정 직원 중 딱 맞는 사람이 있을 때만 이름을 넣고, 아니면 null.',
    '- title은 20자 안팎의 한국어 요약, instruction은 그 팀 직원이 바로 일할 수 있게 구체적인 한국어 지시로.',
    '- reply는 대표에게 하는 짧은 한국어 답(무엇을 누구에게 맡길지).',
    '',
    '[대표의 요청]',
    text,
  ].join('\n');
}

export function secretarySchema(config: MyOfficeConfig): object {
  const teamIds = config.floors.flatMap(f => f.teams.map(t => t.id));
  return {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      drafts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            teamId: { type: 'string', enum: teamIds },
            agent: { type: ['string', 'null'] },
            title: { type: 'string' },
            instruction: { type: 'string' },
          },
          required: ['teamId', 'agent', 'title', 'instruction'],
        },
      },
    },
    required: ['reply', 'drafts'],
  };
}

export async function askSecretary(config: MyOfficeConfig, agentsOf: AgentLister, text: string, cwd: string, ask: OneShot = createOneShot(config.runner)): Promise<SecretaryAnswer> {
  const r = await ask({ cwd, prompt: buildSecretaryPrompt(config, agentsOf, text), tools: [], schema: secretarySchema(config), timeoutMs: 180_000 })
    .catch((e: Error) => { throw new Error(`비서가 답하지 못했습니다: ${e.message}`); });
  const teamIds = new Set(config.floors.flatMap(f => f.teams.map(t => t.id)));
  const { reply, drafts } = r.structured as SecretaryAnswer;
  return { reply, drafts: drafts.filter(d => teamIds.has(d.teamId)) };
}
